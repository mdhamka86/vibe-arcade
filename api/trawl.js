// api/trawl.js
// THE TOUT — the Stewards' Room morning trawl (Phase 3, Stage B).
// Watches the gallops before anyone is awake: runs triage with the data-edge
// gate applied in code, deep-reads SGPools tipster PDFs, harvests the open
// pundit sources from the scout manifest, pulls weather at each track, and
// caches the whole "morning pack" in Redis for a lag-free open.
//
// Actions:
//   GET/POST ?action=run&stage=triage|docs|sources|weather|all[&date=DD/MM/YYYY]
//   GET      ?action=pack            -> latest morning pack
//   GET      ?action=pack&date=DDMMYYYY
//
// Cron (vercel.json): hit ?action=run&stage=all daily at 01:00 UTC (08:00 Phuket).
// Every stage is idempotent and writes progress, so a rerun only improves the pack.

const R_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const R_TOK =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

const BASE =
  "https://" +
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    "vibe-arcade-omega.vercel.app");


async function redis(cmds) {
  const r = await fetch(R_URL + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + R_TOK,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("Redis HTTP " + r.status);
  const j = await r.json();
  const bad = j.find((x) => x.error);
  if (bad) throw new Error("Redis: " + bad.error);
  return j.map((x) => x.result);
}

// ---- resilient fetch helpers ----
// UA POOL. The honest identifying UA below is the DEFAULT and stays the default: it is the
// right thing to send and plenty of sources accept it. But a live probe of every adapter on
// 16/07/2026 found several sources return 403 to ANY unfamiliar UA while serving a normal
// browser fine — selangorturfclub is 403 on every path to a desktop UA and 200 to an iPhone,
// and justhorseracing is the same. That is a WAF fingerprinting the client, not a site
// asking not to be read: robots.txt on justhorseracing explicitly ALLOWS these paths
// (crawl-delay 600, and this cron runs once a day).
//
// So: identify honestly by default, and fall back to a real browser UA only on the specific
// adapters proven to need one. NOT used anywhere: a Googlebot UA. racingqueensland serves
// 200 to Googlebot and 403 to everything else, which is a deliberate block on non-search
// crawlers — impersonating a search engine to get round that is cloaking, so it stays out.
const UA_POOL = {
  honest: "StewardsRoom-Tout/1.0 (hammyLabs personal research tool)",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
const UA = UA_POOL.honest;

async function fetchWithTimeout(url, ms, asJson, opts) {
  const o = opts || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA_POOL[o.ua] || UA,
        Accept: o.accept || "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    return { ok: true, body: asJson ? await r.json() : await r.text() };
  } catch (e) {
    return {
      ok: false,
      error: e.name === "AbortError" ? "timeout " + ms + "ms" : String(e.message || e),
    };
  } finally {
    clearTimeout(t);
  }
}

// HTML -> readable text. Deliberately dumb and robust: the brain (Claude) reads
// prose, so we never regex-parse pundit pages into structures that can break.
// Race Coast exposes its previews via the WordPress REST API, which hands back an array of
// post objects rather than a page. Flatten them into the same plain-text shape every other
// adapter produces, so the rest of the pipeline does not care where a source came from.
// Titles matter here: they carry the pundit name and the meeting date ("Andrew Harrison's
// Form Preview: Wednesday, 15 July 2026 - Hollywoodbets Greyville"), which is exactly how
// the reader tells today's card from last week's.
function wpPostsToText(posts, cap) {
  if (!Array.isArray(posts)) return "";
  const out = [];
  for (const p of posts) {
    const title = htmlToText((p && p.title && p.title.rendered) || "", 300);
    const date = String((p && p.date) || "").slice(0, 10);
    const body = htmlToText((p && p.content && p.content.rendered) || "", cap || 9000);
    if (!title && !body) continue;
    out.push("[" + date + "] " + title + "\n" + body);
  }
  return out.join("\n\n---\n\n").slice(0, cap || 9000);
}

function htmlToText(html, cap) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(br|p|div|tr|li|h[1-6])[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&eacute;/g, "e").replace(/&egrave;/g, "e");
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.slice(0, cap || 9000);
}

// ---- region detection + adapter registry (scout manifest, stage A verdicts) ----
function regionOf(venue) {
  const v = String(venue || "").toLowerCase();
  if (v.includes("south africa")) return "SA";
  if (v.includes("france")) return "FR";
  if (v.includes("korea")) return "KR";
  if (v.includes("malaysia") || v.includes("selangor") || v.includes("penang")) return "MY";
  if (v.includes("turkey") || v.includes("türkiye")) return "TR";
  if (v.includes("hong kong") || v.includes("sha tin") || v.includes("happy valley")) return "HK";
  if (v.includes("united kingdom") || v.includes("ireland")) return "UK";
  if (v.includes("australia") || v.includes("new zealand")) return "AU";
  if (v.includes("japan")) return "JP";
  if (v.includes("singapore")) return "SG";
  return "OTHER";
}

// Only tier "server-html"/"endpoint" adapters live here; websearch-tier sources
// belong to the Stage C research pass.
// ADAPTERS. Every entry below was probed live on 16/07/2026: HTTP status, stripped-TEXT
// length (not raw bytes — a 200 with 78k of JS and 1 char of text is not a source), content
// signals, and 3-5x stability. `ua` and `ms` are set from what each source ACTUALLY needs,
// not from a uniform guess. The old flat 14s/honest-UA treatment silently lost SA, MY, AU
// and most of UK every single morning, and reported them as sourceHealth failures.
const ADAPTERS = {
  SA: [
    // THE BIG ONE. Race Coast runs WordPress and exposes an open REST API serving exactly
    // the pundits the Model Notes call "gold" (Andrew Harrison, Brandon Bailey, Mark van
    // Deventer) as structured JSON with full per-race body text and named selections.
    // Stable 4/4, sub-second. The /category/previews/ HTML page is JS-rendered and has NO
    // article links, which is why scraping it returned nav chrome — do not go back to it.
    // categories: 48=Previews (all), 115=KZN (Greyville/Scottsville), 114=Western Cape
    // (Durbanville/Kenilworth). All four SA courses Hammy actually bets.
    { id: "racecoast-api", url: "https://www.racecoast.co.za/wp-json/wp/v2/posts?categories=48&per_page=8", cap: 14000, ms: 30000, json: true },
    // GOLD CIRCLE — DEMOTED, kept as a bonus only. Its status changed twice in one day of
    // probing, which is exactly why it must not be depended on: at 09:00 it was a cold-start
    // (first hit aborts >20s, then warms to <1s, 4/5 at a 25s timeout); by 11:00 it was
    // 3/3 hard aborts even at 40s, i.e. genuinely down. It is LAST in the SA list and SA no
    // longer needs it — racecoast-api carries the region on its own. If it answers, good;
    // if it times out, the morning is unaffected. Do not restore it to priority without
    // fresh evidence, and do not write it off permanently either: it has recovered before.
    { id: "gold-circle", url: "https://www.goldcircle.co.za/", cap: 12000, ms: 25000, ua: "chrome" },
    // www. host, NOT the bare domain: racecoast.co.za (bare) aborted in probe, www. served
    // 8121 chars. Kept as the HTML fallback if the API ever moves.
    { id: "race-coast-html", url: "https://www.racecoast.co.za/", cap: 9000, ms: 30000, ua: "chrome" },
    { id: "raceform", url: "https://www.raceform.co.za/", cap: 9000, ms: 25000, ua: "chrome" },
  ],
  FR: [
    { id: "prono-turf-gratuit", url: "https://prono-turf-gratuit.fr/presse-pmu/", cap: 9000, ms: 14000 },
    { id: "frequence-turf", url: "https://frequence-turf.fr/", cap: 9000, ms: 14000 },
    { id: "canalturf", url: "https://www.canalturf.com/courses_liste_pronostics.php", cap: 9000, ms: 14000 },
  ],
  KR: [{ id: "korearacing-live", url: "https://korearacing.live/", cap: 9000, ms: 14000 }],
  MY: [
    // 403 to a desktop/honest UA on EVERY path; 200 + stable 3/3 on an iPhone UA. The WAF
    // is fingerprinting the client, not refusing readers.
    // Probed 16/07 on iPhone UA: race-card 39377 chars (the fat one, put it first),
    // /news/selection/ 2673 chars (Top Picks, compact but real). An earlier "404" on
    // /news/selection/ was a DESKTOP-UA artefact, not a moved path — the same URL returns
    // 200 to an iPhone. Every path here is 403 to a desktop UA.
    { id: "stc-racecard", url: "https://www.selangorturfclub.com/horse-racing/local-racing/race-card/", cap: 12000, ms: 20000, ua: "iphone" },
    { id: "stc-selections", url: "https://www.selangorturfclub.com/news/selection/", cap: 7000, ms: 20000, ua: "iphone" },
  ],
  // TJK — TESTED 16/07 and it is NOT reaching the card. EN bare and EN+date both return
  // exactly 1027 chars of nav chrome; the TR path with the date param returns 2401 chars,
  // still nav (menus, no runners). So the date param is NOT the fix, and the earlier
  // "likely just needs a date" hunch was wrong. The daily program is almost certainly
  // rendered client-side or behind a postback on this page. TR is 18 legs of real betting,
  // so this stays in as a cheap attempt rather than being deleted, but treat it as
  // UNRESOLVED: the card is not currently reachable this way and needs a different endpoint
  // (the Turkish GunlukYarisProgrami POST, or the per-race detail pages) before TR can be
  // said to have real coverage.
  TR: [{ id: "tjk-daily", url: "https://www.tjk.org/TR/yarissever/Info/Page/GunlukYarisProgrami", cap: 9000, ms: 20000, ua: "chrome" }],
  HK: [
    { id: "hkjc-racecard", url: "https://racing.hkjc.com/en-us/local/information/racecard", cap: 12000, ms: 14000 },
    // Highest-value single tipster-aggregation endpoint on the whole list. It returns only
    // ~1.8k of text, which LOOKS thin next to a 9k homepage — but it is 1.8k of pure
    // signal: "15/07/2026 HAPPY VALLEY, 6:30 PM, TURF, C, 1650m, GOOD, Class 5" plus the
    // tipster grid. Short is not broken. Judge a source by what it carries, not its size.
    { id: "hkjc-tips-index", url: "https://racing.hkjc.com/racing/English/tipsindex/tips_index.asp", cap: 9000, ms: 14000 },
  ],
  UK: [
    // The press-consensus grid for UK/IE — the same role prono-turf-gratuit plays for
    // France. Stable 3/3. This is the UK spine now.
    { id: "sporting-life-naps", url: "https://www.sportinglife.com/racing/naps-table", cap: 9000, ms: 20000, ua: "chrome" },
    { id: "sporting-life-cards", url: "https://www.sportinglife.com/racing/racecards", cap: 9000, ms: 20000, ua: "chrome" },
    { id: "timeform-tips", url: "https://www.timeform.com/horse-racing/tips", cap: 7000, ms: 20000, ua: "chrome" },
    { id: "irishracing", url: "https://www.irishracing.com/", cap: 9000, ms: 20000, ua: "chrome" },
    // RATE-LIMITED: served 979k on first hit then 3k/305-chars on every fetch after, and
    // stayed there. Kept last and low-cap; treat anything it returns as a bonus.
    { id: "at-the-races", url: "https://www.attheraces.com/", cap: 7000, ms: 14000, ua: "chrome" },
  ],
  AU: [
    // The only real AU tipster source found. iPhone UA (desktop = 403). Serves dated
    // per-track tips with named per-race selections AND horse numbers, plus track
    // condition and rail position. robots.txt allows it; crawl-delay 600 and this runs
    // once a day. racenet/punters/racing.com/skyracing all 403 to every UA tried — they
    // are gone, and leaving them in just manufactured a failure every morning.
    { id: "justhorseracing", url: "https://www.justhorseracing.com.au/", cap: 9000, ms: 20000, ua: "iphone" },
    { id: "racing-nsw", url: "https://www.racingnsw.com.au/", cap: 7000, ms: 20000, ua: "chrome" },
  ],
  JP: [
    // JP legs are Urawa/Mombetsu = NAR local tracks, NOT JRA (and jra.go.jp is 403 anyway).
    { id: "rakuten-keiba", url: "https://keiba.rakuten.co.jp/", cap: 9000, ms: 20000, ua: "chrome" },
    { id: "netkeiba", url: "https://www.netkeiba.com/", cap: 7000, ms: 20000, ua: "chrome" },
  ],
  DE: [
    { id: "deutscher-galopp", url: "https://www.deutscher-galopp.de/", cap: 9000, ms: 20000, ua: "chrome" },
  ],
};

// ---- pack storage ----
function packKey(dateStr) {
  return "stw:pack:" + String(dateStr || "").replace(/\//g, "");
}
async function loadPack(dateStr) {
  const [raw] = await redis([["GET", packKey(dateStr)]]);
  return raw ? JSON.parse(raw) : null;
}
async function savePack(pack) {
  const key = packKey(pack.date);
  await redis([
    ["SET", key, JSON.stringify(pack)],
    ["SET", "stw:pack:latest", key],
  ]);
}

// ---- stage 1: triage via the proven engine, with the data-edge gate in code ----
// ---- today's date in Phuket time (UTC+7, no daylight saving all year) ----
// The 8am cron is anchored to Phuket, so "today" must be computed in that zone,
// never left to a downstream default. Returns DD/MM/YYYY as triage2 expects.
function phuketToday() {
  const now = new Date();
  const phuket = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const dd = String(phuket.getUTCDate()).padStart(2, "0");
  const mm = String(phuket.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = phuket.getUTCFullYear();
  return dd + "/" + mm + "/" + yyyy;
}

async function stageTriage(dateParam) {
  const url =
    BASE + "/api/triage2" + (dateParam ? "?date=" + encodeURIComponent(dateParam) : "");
  const r = await fetchWithTimeout(url, 25000, true);
  if (!r.ok) throw new Error("triage2 failed: " + r.error);
  const t = r.body;
  if (t.error) throw new Error("triage2: " + t.error);

  const gated = [];
  const deselected = [];
  for (const m of t.meets || []) {
    const hasDocs = (m.docCount || 0) > 0;
    const hasMap = Array.isArray(m.raceMap) && m.raceMap.length > 0;
    if (hasDocs && hasMap) gated.push(m);
    else
      deselected.push({
        venue: m.venue,
        why:
          (!hasDocs ? "no analysis docs" : "") +
          (!hasDocs && !hasMap ? " + " : "") +
          (!hasMap ? "no runner map" : "") +
          " (data-edge gate, locked 30/06)",
      });
  }
  const top = gated.slice(0, 5);
  return {
    date: t.date,
    scanned: t.count,
    deselected,
    meets: top.map((m) => ({
      venue: m.venue,
      region: regionOf(m.venue),
      score: m.score,
      reason: m.reason,
      races: m.races,
      avgField: m.avgField,
      maxField: m.maxField,
      coupon: m.coupon || null,
      featureRaces: m.featureRaces || [],
      raceMap: m.raceMap || [],
      url: m.url,
      docCount: m.docCount || 0,
    })),
  };
}

// ---- stage 2: deep-read SGPools tipster PDFs per gated meet ----
async function stageDocs(pack) {
  await Promise.all(
    pack.meets.map(async (m) => {
      const r = await fetchWithTimeout(
        BASE + "/api/deep2?url=" + encodeURIComponent(m.url), 30000, true);
      if (!r.ok) { m.docs = [{ label: "deep2", error: r.error }]; return; }
      if (r.body.error) { m.docs = [{ label: "deep2", error: r.body.error }]; return; }
      m.docs = (r.body.docs || []).map((d) => ({
        label: d.label,
        error: d.error || null,
        chars: d.text ? d.text.length : 0,
        text: d.text ? String(d.text).slice(0, 8000) : "",
      }));
    })
  );
  return pack;
}

// ---- stage 3: pundit sources per region (scout manifest adapters) ----
async function stageSources(pack) {
  const regions = [...new Set(pack.meets.map((m) => m.region))];
  const jobs = [];
  for (const reg of regions) {
    for (const a of ADAPTERS[reg] || []) {
      // Each adapter carries the timeout and user-agent it actually needs (see the probe
      // notes on ADAPTERS). A flat 14s honest-UA fetch silently lost gold-circle to its
      // cold start and every WAF-guarded source to a 403, every single morning.
      jobs.push(
        fetchWithTimeout(a.url, a.ms || 14000, !!a.json, { ua: a.ua }).then((r) => ({
          region: reg, id: a.id, url: a.url,
          ok: r.ok, error: r.ok ? null : r.error,
          text: r.ok ? (a.json ? wpPostsToText(r.body, a.cap) : htmlToText(r.body, a.cap)) : "",
        }))
      );
    }
  }
  const results = await Promise.all(jobs);
  const byRegion = {};
  for (const s of results) (byRegion[s.region] = byRegion[s.region] || []).push(s);
  for (const m of pack.meets)
    m.sources = (byRegion[m.region] || []).map((s) => ({
      id: s.id, ok: s.ok, error: s.error, chars: s.text.length, text: s.text,
    }));
  pack.sourceHealth = results.map((s) => ({
    id: s.id, region: s.region, ok: s.ok, chars: s.text.length, error: s.error,
  }));
  return pack;
}

// ---- stage 4: weather at each track via Open-Meteo (keyless, geocoded) ----
function venueCity(venue) {
  const m = /\(([^)]+)\)/.exec(String(venue || ""));
  let c = (m ? m[1] : venue || "").trim();
  c = c.replace(/\b(poly|polytrack|turf|aw|all weather)\b/gi, "").trim();
  return c;
}
async function stageWeather(pack) {
  await Promise.all(
    pack.meets.map(async (m) => {
      const city = venueCity(m.venue);
      const g = await fetchWithTimeout(
        "https://geocoding-api.open-meteo.com/v1/search?count=1&name=" +
          encodeURIComponent(city), 9000, true);
      if (!g.ok || !g.body.results || !g.body.results.length) {
        m.weather = { city, error: g.ok ? "not geocoded" : g.error };
        return;
      }
      const { latitude, longitude, name, country } = g.body.results[0];
      const w = await fetchWithTimeout(
        "https://api.open-meteo.com/v1/forecast?latitude=" + latitude +
          "&longitude=" + longitude +
          "&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,wind_speed_10m_max&forecast_days=2&past_days=1&timezone=auto",
        9000, true);
      if (!w.ok) { m.weather = { city: name, error: w.error }; return; }
      const d = w.body.daily || {};
      m.weather = {
        city: name + ", " + country,
        yesterdayRainMm: d.precipitation_sum ? d.precipitation_sum[0] : null,
        todayRainMm: d.precipitation_sum ? d.precipitation_sum[1] : null,
        rainChancePct: d.precipitation_probability_max ? d.precipitation_probability_max[1] : null,
        maxTempC: d.temperature_2m_max ? d.temperature_2m_max[1] : null,
        maxWindKmh: d.wind_speed_10m_max ? d.wind_speed_10m_max[1] : null,
      };
    })
  );
  return pack;
}

// ---- the copy text: the whole pack in paste-to-Claude form ----
function buildCopyText(pack) {
  const L = [];
  L.push("THE TOUT — MORNING PACK  " + pack.date + "  (built " + pack.builtAt + ")");
  L.push("Gate: " + pack.meets.length + " meets survived of " + pack.scanned + " scanned.");
  (pack.deselected || []).forEach((d) => L.push("  deselected: " + d.venue + " — " + d.why));
  for (const m of pack.meets) {
    L.push("\n==== " + m.venue + "  [score " + m.score + ", " + m.races + " races] ====");
    L.push(m.reason);
    if (m.coupon) L.push("SGPools coupon: " + m.coupon);
    if (m.weather && !m.weather.error)
      L.push("Weather " + m.weather.city + ": rain yday " + m.weather.yesterdayRainMm +
        "mm, today " + m.weather.todayRainMm + "mm (" + m.weather.rainChancePct +
        "% chance), max " + m.weather.maxTempC + "C, wind " + m.weather.maxWindKmh + "km/h");
    (m.raceMap || []).forEach((r) => {
      const runners = (r.runners || []).map((h) => h.no + " " + h.name).join(", ");
      L.push("R" + r.raceNo + " (" + (r.dist || "?") + "): " + runners);
    });
    (m.docs || []).forEach((d) => {
      if (d.error) L.push("\n[SGPools " + d.label + "] failed: " + d.error);
      else L.push("\n[SGPools " + d.label + "]\n" + String(d.text).slice(0, 5000));
    });
    (m.sources || []).forEach((s) => {
      if (!s.ok) L.push("\n[" + s.id + "] failed: " + s.error);
      else L.push("\n[" + s.id + "]\n" + String(s.text).slice(0, 4500));
    });
  }
  return L.join("\n");
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    if (!R_URL || !R_TOK)
      return res.status(500).json({ error: "Redis env vars missing" });
    const action = (req.query.action || "pack").toString();

    if (action === "pack") {
      let key;
      if (req.query.date) key = "stw:pack:" + String(req.query.date).replace(/\//g, "");
      else {
        const [latest] = await redis([["GET", "stw:pack:latest"]]);
        key = latest;
      }
      if (!key) return res.status(404).json({ error: "No morning pack yet. Run the Tout." });
      const [raw] = await redis([["GET", key]]);
      if (!raw) return res.status(404).json({ error: "Pack not found for that date." });
      return res.status(200).json(JSON.parse(raw));
    }

    if (action === "run") {
      const stage = (req.query.stage || "all").toString();
      // Default to today in Phuket, computed here, never left to a downstream
      // default. An explicit ?date= still wins, for backfills.
      const dateParam = req.query.date ? String(req.query.date) : phuketToday();
      const t0 = Date.now();

      let pack;
      if (stage === "triage" || stage === "all") {
        const tri = await stageTriage(dateParam);
        pack = Object.assign(
          { builtAt: new Date().toISOString(), stages: {} }, tri);
        pack.stages.triage = { ok: true, ms: Date.now() - t0 };
        await savePack(pack);
      } else {
        pack = await loadPack(dateParam || null);
        if (!pack) {
          const [latest] = await redis([["GET", "stw:pack:latest"]]);
          if (latest) { const [raw] = await redis([["GET", latest]]); pack = raw ? JSON.parse(raw) : null; }
        }
        if (!pack)
          return res.status(409).json({ error: "Run stage=triage (or all) first." });
      }

      if (stage === "docs" || stage === "all") {
        const t = Date.now();
        await stageDocs(pack);
        pack.stages.docs = { ok: true, ms: Date.now() - t };
        await savePack(pack);
      }
      if (stage === "sources" || stage === "all") {
        const t = Date.now();
        await stageSources(pack);
        pack.stages.sources = { ok: true, ms: Date.now() - t };
        await savePack(pack);
      }
      if (stage === "weather" || stage === "all") {
        const t = Date.now();
        await stageWeather(pack);
        pack.stages.weather = { ok: true, ms: Date.now() - t };
        await savePack(pack);
      }

      pack.copyText = buildCopyText(pack);
      pack.builtAt = new Date().toISOString();
      await savePack(pack);

      return res.status(200).json({
        ok: true,
        date: pack.date,
        stagesRun: stage,
        totalMs: Date.now() - t0,
        meets: pack.meets.map((m) => ({
          venue: m.venue, region: m.region, score: m.score,
          docs: (m.docs || []).filter((d) => !d.error).length,
          sources: (m.sources || []).filter((s) => s.ok).length,
          weather: m.weather && !m.weather.error ? "ok" : "missing",
        })),
        deselected: pack.deselected,
        sourceHealth: pack.sourceHealth || [],
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
