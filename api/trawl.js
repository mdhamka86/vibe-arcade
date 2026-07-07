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

const UA = "StewardsRoom-Tout/1.0 (hammyLabs personal research tool)";

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
async function fetchWithTimeout(url, ms, asJson) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "*/*" },
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
const ADAPTERS = {
  SA: [
    { id: "gold-circle", url: "https://www.goldcircle.co.za/", cap: 12000 },
    { id: "race-coast", url: "https://racecoast.co.za/", cap: 9000 },
    { id: "sky-racing-world-sa", url: "https://www.skyracingworld.com/news/international/south-africa/", cap: 7000 },
  ],
  FR: [
    { id: "prono-turf-gratuit", url: "https://prono-turf-gratuit.fr/presse-pmu/", cap: 9000 },
    { id: "frequence-turf", url: "https://frequence-turf.fr/", cap: 9000 },
    { id: "canalturf", url: "https://www.canalturf.com/courses_liste_pronostics.php", cap: 9000 },
  ],
  KR: [{ id: "korearacing-live", url: "https://korearacing.live/", cap: 9000 }],
  MY: [
    { id: "stc-selections", url: "https://www.selangorturfclub.com/news/selection/", cap: 7000 },
    { id: "stc-racecard", url: "https://www.selangorturfclub.com/horse-racing/local-racing/race-card/", cap: 9000 },
  ],
  TR: [{ id: "tjk-daily", url: "https://www.tjk.org/EN/yarissever/Info/Page/GunlukYarisProgrami", cap: 9000 }],
  HK: [
    { id: "hkjc-racecard", url: "https://racing.hkjc.com/en-us/local/information/racecard", cap: 12000 },
    { id: "hkjc-tips-index", url: "https://racing.hkjc.com/racing/English/tipsindex/tips_index.asp", cap: 9000 },
  ],
  UK: [{ id: "at-the-races", url: "https://www.attheraces.com/", cap: 7000 }],
  AU: [
    { id: "racenet", url: "https://www.racenet.com.au/", cap: 7000 },
    { id: "justhorseracing", url: "https://www.justhorseracing.com.au/", cap: 7000 },
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
      jobs.push(
        fetchWithTimeout(a.url, 14000, false).then((r) => ({
          region: reg, id: a.id, url: a.url,
          ok: r.ok, error: r.ok ? null : r.error,
          text: r.ok ? htmlToText(r.body, a.cap) : "",
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
