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
// Map a meet's venue string to an adapter region.
//
// THIS WAS SILENTLY LOSING HALF THE BOOK. The old version only matched long-form country
// names ("south africa", "united kingdom"), but the ledger is full of short codes ("SA",
// "UK", "FR", "AU"), bracketed venues ("Ascot (UK)", "Kenilworth (SA)", "Greyville Poly
// (SA)") and bare course names. Every one of those fell through to "OTHER", which has no
// adapters, so the morning trawl fetched NOTHING for them and the day's read was built on
// air. Measured against the live ledger: 209 of 429 settled legs were in meets that
// resolved to OTHER. The single biggest source of blind spots in the whole pipeline, and
// it looked like a working trawl the entire time.
//
// Order matters: check the most specific signals first (course names, bracketed codes),
// then bare two-letter codes as a whole-word match so "SA" does not match "Saint-Cloud"
// and "MB" (Mombetsu) does not match a random word containing mb.
function regionOf(venue) {
  const v = String(venue || "").toLowerCase().trim();
  if (!v) return "OTHER";
  // whole-word code test: "SA", "(SA)", "[SGP SA3]", "SA "
  const code = (c) => new RegExp("(^|[^a-z])" + c + "([^a-z]|$)", "i").test(v);

  // COUNTRY LABEL WINS FIRST. SGPools meet labels are coupon containers, not venues
  // ("Australia (Perth)" held Grafton + Tasmania on 19/07/2026), and several course
  // names are dual-hemisphere (Perth, Newcastle, Sandown, Ascot, Wellington). An
  // explicit country word in the label must beat every course-name heuristic below,
  // otherwise "Australia (Perth)" resolves to UK via Perth, Scotland and all pundit
  // sources get withheld as wrong-meeting.
  if (/\baustralia\b|\bnew zealand\b/.test(v)) return "AU";
  if (/united kingdom|\bireland\b|\bengland\b|\bscotland\b|\bwales\b/.test(v)) return "UK";

  // --- South Africa: country, code, and every course actually bet
  if (v.includes("south africa") || code("sa") ||
      /greyville|scottsville|durbanville|kenilworth|turffontein|fairview|vaal|hollywoodbets/.test(v)) return "SA";
  // --- France
  if (v.includes("france") || code("fr") ||
      /chantilly|deauville|saint-cloud|longchamp|vincennes|dieppe|vittel|lyon-parilly|la teste|compiegne|clairefontaine|maisons-laffitte/.test(v)) return "FR";
  // --- Korea (SK = Seoul/Seongnam in the ledger's shorthand)
  if (v.includes("korea") || code("kr") || code("sk") || /seoul|busan|jeju/.test(v)) return "KR";
  // --- Malaysia
  if (/malaysia|selangor|penang|perak|ipoh|sungai besi/.test(v) || code("my")) return "MY";
  // --- Turkey
  if (/turkey|türkiye|turkiye|ankara|istanbul|bursa|izmir|adana|elazig|sanliurfa|diyarbakir|kocaeli/.test(v) || code("tr") || code("tur")) return "TR";
  // --- Hong Kong
  if (/hong kong|sha tin|happy valley/.test(v) || code("hk")) return "HK";
  // --- UK & Ireland (course list covers the bracketed "Ascot (UK)" style too)
  if (/united kingdom|ireland|england|scotland|wales/.test(v) || code("uk") || code("ire") || code("gb") ||
      /ascot|newcastle|musselburgh|ffos las|carlisle|curragh|hamilton|doncaster|ayr|pontefract|lingfield|wolverhampton|newmarket|goodwood|york|epsom|cheltenham|aintree|haydock|sandown|kempton|chepstow|bath|brighton|catterick|chester|leicester|nottingham|redcar|ripon|salisbury|thirsk|windsor|yarmouth|beverley|hexham|kelso|perth|southwell|stratford|uttoxeter|warwick|wetherby|worcester|down royal|leopardstown|fairyhouse|naas|navan|punchestown|tipperary|galway|gowran|dundalk|limerick|cork|killarney|listowel|roscommon|sligo|tramore|wexford|ballinrobe|bellewstown|clonmel|kilbeggan|laytown|thurles/.test(v)) return "UK";
  // --- Australia & NZ (MB = Muswellbrook / Melbourne-area shorthand in the ledger)
  if (/australia|new zealand/.test(v) || code("au") || code("nz") || code("qld") || code("nsw") || code("vic") || code("mb") ||
      /ipswich|taree|muswellbrook|tamworth|ballarat|wagga|wellington|northam|perth|melbourne|sydney|brisbane|adelaide|randwick|flemington|caulfield|moonee valley|rosehill|doomben|eagle farm|gold coast|sunshine coast|canberra|newcastle \(aus\)|gosford|hawkesbury|kembla|nowra|orange|scone|dubbo|goulburn|bathurst|grafton|lismore|coffs harbour|port macquarie|armidale|inverell|moree|narrandera|griffith|leeton|albury|corowa|wodonga|shepparton|bendigo|geelong|kilmore|kyneton|sale|seymour|swan hill|warrnambool|hanging rock|pakenham|cranbourne|sandown|mornington|yarra valley/.test(v)) return "AU";
  // --- Japan (NAR locals are what actually gets bet, not JRA)
  if (v.includes("japan") || code("jp") || /urawa|mombetsu|kawasaki|funabashi|ohi|oi |monbetsu|kanazawa|kochi|saga|nagoya|sonoda|himeji|morioka|mizusaki/.test(v)) return "JP";
  // --- Germany (adapter added 16/07; without this branch a German meet silently got none)
  if (/germany|deutschland|hamburg|baden-baden|cologne|köln|koln|dusseldorf|düsseldorf|munich|münchen|munchen|hannover|dortmund|krefeld|mulheim|mülheim|hoppegarten|frankfurt|bremen|leipzig|dresden|magdeburg/.test(v) || code("de") || code("ger")) return "DE";
  // --- Singapore: kept for card labelling. NOTE there is no SG adapter and no SG racing
  // since Kranji closed in Oct 2024, so this only ever tags historical/labelled rows.
  if (v.includes("singapore") || code("sg")) return "SG";
  return "OTHER";
}

// Exported because propose.js needs exactly this course-to-region knowledge to resolve a
// model-authored meet label ("Scottsville") back to the pack's coupon venue ("South Africa").
// Shared rather than copied: a second course list would drift from this one, and the whole
// point of the resolver is that it agrees with how the trawl regionalised the meet.
export { regionOf };

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

// ---- PHASE 3.1: THE PRICE LAYER (OVERHAUL.md; endpoints scouted live 19/07/2026) ----
//
// Two adapters, both proven from syd1 with the probe:
//   TAB  (api.beta.tab.com.au)  — AU meets. iPhone UA mandatory (desktop UA = Akamai
//        "Access Denied"; geo unlocked by the syd1 region pin). Fixed odds + tote
//        approximates per runner.
//   PMU  (online.turfinfo.api.pmu.fr) — FR + DE meets (PMU carries German and some
//        Irish cards with French tote odds). rapportReference = opening line,
//        rapportDirect = latest tote. Pools open mid-morning Paris time, so this
//        stage runs at PROPOSE time, never inside the 8am trawl (03:00 in Paris).
//
// MATCHING LAW: meets are matched to source races by RUNNER NAMES, never by venue
// label or race number. SGPools labels are coupon containers ("Australia (Perth)"
// held Grafton + Tasmania on 19/07) and every source numbers races its own way.
// A race is matched only when >=50% of the card's runners appear in the source
// race by normalised name. Prices are then written per runner BY NAME.
// Dead ends, probed and buried: RAS/Hollywoodbets/Racenet-family (Cloudflare),
// TAB SA (JS shell), TAB AU on a desktop UA (Akamai).

function normName(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function nameOverlap(cardRunners, srcNames) {
  const src = new Set(srcNames.map(normName).filter(Boolean));
  const names = (cardRunners || []).map((h) => normName(h.name)).filter(Boolean);
  if (!names.length || !src.size) return 0;
  let hit = 0;
  for (const n of names) if (src.has(n)) hit++;
  return hit / names.length;
}
function parseDistM(d) {
  const m = /(\d{3,4})/.exec(String(d || ""));
  return m ? parseInt(m[1], 10) : 0;
}

// ============================================================================
// FRANCE: the PMU racecard adapter (FR ONLY — no other region is touched)
// ============================================================================
// WHY THIS EXISTS. The three French adapters above are dateless, trackless index
// pages: prono-turf-gratuit/presse-pmu, frequence-turf, canalturf. They serve
// whatever meeting the site is featuring, which is not the meeting SGPools carded,
// so on 22/07/2026 all three named 0 of 86 card runners and France went SSOT-blind.
// Nothing chose a meeting; the sites did. This adapter chooses.
//
// PMU's API is date-addressable (/programme/DDMMYYYY) and meeting-addressable
// (/R{n}/C{n}), returns structured runners, and is the same host pmuPrices already
// depends on. It is reachable from syd1 (it is CloudFront-geo-blocked from a dev
// box, which is why this was scouted through /api/probe rather than locally).
//
// WHAT IT IS AND IS NOT: this is a CARD source. It verifies and enriches the
// coupon — runners, distances, race titles, start times — and it carries no
// opinion. It is marked kind:"card" so a convergence rule can tell it apart from a
// tipster. It does NOT emit PMU horse numbers: SGPools numbering is the single
// source of truth for what the number means, and carrying PMU's numbering across
// is precisely the trap that put money on FAIRY KNIGHT instead of Sooty on 17/07.
const PMU_PROGRAMME = "https://online.turfinfo.api.pmu.fr/rest/client/61/programme/";

// Flatten a day's programme into a flat, start-time-ordered course list.
function pmuCoursesFromProgramme(prog) {
  const out = [];
  for (const r of ((prog || {}).programme || {}).reunions || []) {
    const hip = r.hippodrome || {};
    for (const c of r.courses || []) {
      out.push({
        R: r.numOfficiel,
        C: c.numOrdre,
        hippo: hip.libelleLong || hip.libelleCourt || "?",
        pays: (r.pays && r.pays.code) || "",
        dist: c.distance || 0,
        partants: c.nombreDeclaresPartants || 0,
        startMs: c.heureDepart || 0,
        discipline: c.discipline || "",
        libelle: c.libelle || "",
      });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// Match each SGPools race to one PMU course. `getNames(R, C)` is injected so the
// safety suite drives this exact function without touching the network.
//
// NAMES DECIDE. Distance and declared-runner count are a PREFILTER only, to avoid
// paying for participants on all ~60 courses. They are NOT a matching signal:
// verified across 16 days, réunion R2 at La Teste on 11/07 ran FOUR 1900m races
// (C3:7, C4:6, C5:6, C6:7 runners) and only C6 was the SGPools race. An earlier
// build matched on distance+field size and picked C3 — a confident, silent, wrong
// answer, which then dragged every later race out of alignment and cost five more
// on 08/07. This is the same law pmuPrices already follows and the same law the
// SSOT gate applies to every other source: >=50% of the card's runners by name.
//
// Coupon order is deliberately NOT an invariant. 08/07 matched 14/14 races at 100%
// of names with the assignments out of start-time order — SGPools numbers its
// coupon its own way. Ordering is reported for diagnosis and never gates anything.
async function matchCard(sgRaces, courses, getNames, opts) {
  const o = opts || {};
  const FLOOR = o.floor == null ? 0.5 : o.floor;   // house law: >=50% by name
  const SLACK = o.slack == null ? 2 : o.slack;     // declared vs carded runners
  const MAX_TRY = o.maxTry == null ? 8 : o.maxTry; // candidates tried per race
  const BUDGET = o.budget == null ? 40 : o.budget; // total participants fetches
  const assigned = [];
  const unresolved = [];
  const used = new Set();
  let fetches = 0;

  for (const sr of sgRaces || []) {
    const d = parseDistM(sr.dist);
    const n = sr.fieldSize || (sr.runners || []).length || 0;
    const runners = sr.runners || [];
    if (!runners.length) {
      unresolved.push({ raceNo: sr.raceNo, why: "the SGPools card lists no runners for this race, so there is nothing to match on" });
      continue;
    }
    const fresh = courses.filter((c) => !used.has(c.R + "|" + c.C));
    let cands = fresh.filter((c) => c.dist === d && Math.abs(c.partants - n) <= SLACK);
    if (!cands.length) cands = fresh.filter((c) => Math.abs(c.partants - n) <= SLACK);
    cands = cands
      .sort((a, b) => Math.abs(a.partants - n) - Math.abs(b.partants - n) || a.startMs - b.startMs)
      .slice(0, MAX_TRY);

    let best = null;
    for (const c of cands) {
      if (fetches >= BUDGET) break;
      const names = await getNames(c.R, c.C);
      fetches++;
      if (!names || !names.length) continue;
      const overlap = nameOverlap(runners, names);
      if (!best || overlap > best.overlap) best = { c, overlap, names };
      if (overlap === 1) break; // perfect — stop paying for more
    }
    if (best && best.overlap >= FLOOR) {
      used.add(best.c.R + "|" + best.c.C);
      assigned.push({
        raceNo: sr.raceNo, ...best.c,
        sgDist: d, sgField: n,
        overlap: Math.round(best.overlap * 100) / 100,
        pmuNames: best.names,
        tried: cands.length,
      });
    } else {
      // LOUD, PER RACE. Never assign below the floor: a wrong course is a bet on a
      // horse nobody analysed, which is strictly worse than one unmatched race.
      unresolved.push({
        raceNo: sr.raceNo, sgDist: d, sgField: n,
        why: best
          ? "best of " + cands.length + " candidate(s) was PMU R" + best.c.R + "/C" + best.c.C +
            " at " + Math.round(best.overlap * 100) + "% runner-name overlap, under the " +
            Math.round(FLOOR * 100) + "% floor — treated as a different race"
          : (cands.length
              ? "none of " + cands.length + " candidate course(s) returned runners"
              : "no PMU course at " + d + "m with " + n + "±" + SLACK + " runners anywhere in the day's programme"),
      });
    }
  }

  let monotonic = true;
  for (let i = 1; i < assigned.length; i++)
    if (assigned[i].startMs < assigned[i - 1].startMs) monotonic = false;
  const byReunion = {};
  for (const a of assigned) (byReunion[a.R] = byReunion[a.R] || []).push(a);
  return {
    assigned, unresolved, monotonic, fetches,
    confidence: (sgRaces || []).length ? assigned.length / sgRaces.length : 0,
    // SGPools France is a COUPON CONTAINER and routinely merges several PMU
    // réunions (22/07 = R4+R5, 08/07 = R3+R4, 07/07 = R1+R4). Never assume one.
    reunions: Object.keys(byReunion).map(Number).sort((a, b) => a - b),
    venues: [...new Set(assigned.map((a) => a.hippo))],
  };
}

// Render the matched card as source text for the model + the SSOT gate. Runner
// NUMBERS are SGPools', never PMU's (see the numbering note above).
function pmuSourceText(pack, meet, m) {
  const L = [];
  L.push("PMU OFFICIAL RACECARD for " + meet.venue + ", card date " + pack.date +
    " — matched to the SGPools coupon by runner name, race by race.");
  L.push("Matched " + m.assigned.length + " of " + (meet.raceMap || []).length +
    " SGPools races across PMU " +
    (m.reunions.length > 1 ? "reunions " : "reunion ") + m.reunions.map((r) => "R" + r).join(" + ") +
    " (" + m.venues.join(" + ") + ").");
  L.push("Horse numbers below are the SGPools card's own. PMU numbering is deliberately not carried across.");
  for (const a of m.assigned) {
    const sg = (meet.raceMap || []).find((r) => r.raceNo === a.raceNo) || {};
    const when = a.startMs ? new Date(a.startMs).toISOString().slice(11, 16) + "Z" : "?";
    L.push("");
    L.push("SGPools R" + a.raceNo + " = PMU R" + a.R + "/C" + a.C + "  " + (a.libelle || "") +
      "  " + a.dist + "m  " + (a.discipline || "") + "  off " + when +
      "  [" + Math.round(a.overlap * 100) + "% runner-name agreement]");
    L.push("  " + (sg.runners || []).map((h) => h.no + " " + h.name).join(", "));
    // Runners PMU declares that the SGPools card does not name, and vice versa —
    // usually a late scratching, and worth the model seeing rather than hiding.
    const card = new Set((sg.runners || []).map((h) => normName(h.name)));
    const extra = (a.pmuNames || []).filter((x) => !card.has(normName(x)));
    if (extra.length) L.push("  PMU also declares (not on the SGPools card, likely scratched/added): " + extra.join(", "));
  }
  for (const u of m.unresolved)
    L.push("\nSGPools R" + u.raceNo + ": NO PMU COURSE MATCHED — " + u.why);
  return L.join("\n");
}

// Build the FR card source for one meet. Returns a source object, or null if the
// programme itself could not be read (caller then leaves the meet as it was).
async function pmuFranceSource(pack, meet) {
  const d = String(pack.date || "").split("/");
  if (d.length !== 3) return null;
  const pmuDate = d[0] + d[1] + d[2];
  const prog = await fetchWithTimeout(PMU_PROGRAMME + pmuDate, 20000, true);
  if (!prog.ok)
    return { id: "pmu-racecard", kind: "card", ok: false, error: "PMU programme: " + prog.error, chars: 0, text: "" };
  const courses = pmuCoursesFromProgramme(prog.body);
  if (!courses.length)
    return { id: "pmu-racecard", kind: "card", ok: false, error: "PMU programme carried no courses for " + pack.date, chars: 0, text: "" };

  const cache = {};
  const getNames = async (R, C) => {
    const k = R + "|" + C;
    if (cache[k] !== undefined) return cache[k];
    const r = await fetchWithTimeout(PMU_PROGRAMME + pmuDate + "/R" + R + "/C" + C + "/participants", 12000, true);
    return (cache[k] = r.ok && r.body ? (r.body.participants || []).map((p) => p.nom) : null);
  };

  const sgRaces = (meet.raceMap || []).map((r) => ({
    raceNo: r.raceNo, dist: r.dist, fieldSize: r.fieldSize, runners: r.runners,
  }));
  const m = await matchCard(sgRaces, courses, getNames);
  const text = pmuSourceText(pack, meet, m);
  return {
    id: "pmu-racecard",
    kind: "card",
    ok: m.assigned.length > 0,
    error: m.assigned.length ? null : "PMU carried no course matching any SGPools race on this card",
    chars: text.length,
    text: m.assigned.length ? text : "",
    // structured, for the morning reader and any later price/odds work
    pmu: {
      reunions: m.reunions, venues: m.venues, monotonic: m.monotonic,
      matched: m.assigned.length, of: sgRaces.length, fetches: m.fetches,
      races: m.assigned.map((a) => ({
        sgRaceNo: a.raceNo, R: a.R, C: a.C, dist: a.dist,
        startMs: a.startMs, libelle: a.libelle, overlap: a.overlap,
      })),
      unresolved: m.unresolved,
    },
  };
}

// TAB: AU meets. One meetings call, then lazy race fetches gated by distance and
// capped, with a learned venue+offset shortcut (SGPools integrates venues in
// contiguous renumbered blocks, so once R5=venue X race 2, R6 is very likely
// venue X race 3 — try that first and save a scan).
async function tabPrices(pack, stats) {
  const auMeets = (pack.meets || []).filter((m) => m.region === "AU" && (m.raceMap || []).length);
  if (!auMeets.length) return;
  const d = pack.date.split("/"); // DD/MM/YYYY -> YYYY-MM-DD
  const tabDate = d[2] + "-" + d[1] + "-" + d[0];
  const listUrl = "https://api.beta.tab.com.au/v1/tab-info-service/racing/dates/" + tabDate + "/meetings?jurisdiction=NSW";
  const list = await fetchWithTimeout(listUrl, 15000, true, { ua: "iphone" });
  if (!list.ok) { stats.errors.push("tab meetings: " + list.error); return; }
  const meetings = (list.body.meetings || []).filter((m) => m.raceType === "R" && m.venueMnemonic);
  const raceCache = {};
  let fetches = 0;
  const FETCH_CAP = 50;
  async function getRace(venue, n) {
    const key = venue + "|" + n;
    if (raceCache[key] !== undefined) return raceCache[key];
    if (fetches >= FETCH_CAP) return (raceCache[key] = null);
    fetches++;
    const u = "https://api.beta.tab.com.au/v1/tab-info-service/racing/dates/" + tabDate +
      "/meetings/R/" + encodeURIComponent(venue) + "/races/" + n + "?jurisdiction=NSW";
    const r = await fetchWithTimeout(u, 12000, true, { ua: "iphone" });
    return (raceCache[key] = r.ok ? r.body : null);
  }
  function runnerPrice(rn) {
    const fo = rn.fixedOdds || {};
    const pm = rn.parimutuel || {};
    // tote approximates first (this IS a tote operation), fixed as fallback
    const win = num(pm.returnWin) || num(fo.returnWin) || 0;
    const pla = num(pm.returnPlace) || num(fo.returnPlace) || 0;
    if (String(fo.bettingStatus || "").toLowerCase() === "scratched") return null;
    if (!win && !pla) return null;
    return { win: win || null, pla: pla || null, ref: num(fo.returnWin) || null, src: "tab" };
  }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  for (const m of auMeets) {
    let last = null; // { venue, offset }
    for (const race of m.raceMap || []) {
      const dist = parseDistM(race.dist);
      let matched = null;
      // 1. learned-offset shortcut
      if (last) {
        const rb = await getRace(last.venue, race.raceNo + last.offset);
        if (rb && nameOverlap(race.runners, (rb.runners || []).map((x) => x.runnerName)) >= 0.5)
          matched = { venue: last.venue, body: rb };
      }
      // 2. distance-gated scan
      if (!matched) {
        for (const mt of meetings) {
          const cand = (mt.races || []).filter((r) =>
            !r.raceDistance || !dist || Math.abs(parseDistM(r.raceDistance) - dist) <= 40);
          for (const c of cand) {
            const rb = await getRace(mt.venueMnemonic, c.raceNumber);
            if (rb && nameOverlap(race.runners, (rb.runners || []).map((x) => x.runnerName)) >= 0.5) {
              matched = { venue: mt.venueMnemonic, body: rb };
              break;
            }
          }
          if (matched) break;
        }
      }
      if (!matched) { stats.misses.push(m.venue + " R" + race.raceNo + " (tab)"); last = null; continue; }
      last = { venue: matched.venue, offset: (matched.body.raceNumber || 0) - race.raceNo };
      // persist the match so the Results Wire can come back for finals without re-matching
      race.priceRef = { src: "tab", venue: matched.venue, srcRaceNo: matched.body.raceNumber || 0 };
      const byName = {};
      (matched.body.runners || []).forEach((rn) => { byName[normName(rn.runnerName)] = rn; });
      for (const h of race.runners || []) {
        const rn = byName[normName(h.name)];
        const p = rn && runnerPrice(rn);
        if (p) { p.srcNo = rn.runnerNumber != null ? rn.runnerNumber : rn.number; h.price = p; stats.pricedRunners++; }
      }
      stats.matchedRaces++;
    }
  }
}

// PMU: FR + DE meets. One programme call, participants per distance-matched
// course to verify names, then win + place rapports for matched courses.
async function pmuPrices(pack, stats) {
  const frde = (pack.meets || []).filter((m) => (m.region === "FR" || m.region === "DE") && (m.raceMap || []).length);
  if (!frde.length) return;
  const d = pack.date.split("/"); // DD/MM/YYYY -> DDMMYYYY
  const pmuDate = d[0] + d[1] + d[2];
  const base = "https://online.turfinfo.api.pmu.fr/rest/client/61/programme/" + pmuDate;
  const prog = await fetchWithTimeout(base, 15000, true);
  if (!prog.ok) { stats.errors.push("pmu programme: " + prog.error); return; }
  const courses = [];
  for (const r of (prog.body.programme || {}).reunions || [])
    for (const c of r.courses || [])
      courses.push({ R: r.numOfficiel, C: c.numOrdre, dist: c.distance || 0, n: c.nombreDeclaresPartants || 0 });
  const partCache = {};
  let fetches = 0;
  const FETCH_CAP = 40;
  async function getParts(R, C) {
    const key = R + "|" + C;
    if (partCache[key] !== undefined) return partCache[key];
    if (fetches >= FETCH_CAP) return (partCache[key] = null);
    fetches++;
    const r = await fetchWithTimeout(base + "/R" + R + "/C" + C + "/participants", 12000, true);
    return (partCache[key] = r.ok ? (r.body.participants || []) : null);
  }
  async function getRapports(R, C, type) {
    const r = await fetchWithTimeout(base + "/R" + R + "/C" + C + "/rapports/" + type, 12000, true);
    if (!r.ok || !r.body) return {};
    const arr = Array.isArray(r.body) ? r.body : [r.body];
    const map = {};
    for (const t of arr)
      for (const x of t.rapportsParticipant || [])
        map[x.numPmu] = { direct: x.rapportDirect, ref: x.rapportReference };
    return map;
  }
  for (const m of frde) {
    for (const race of m.raceMap || []) {
      const dist = parseDistM(race.dist);
      const fs = (race.runners || []).length;
      let matched = null;
      const cand = courses.filter((c) =>
        (!dist || !c.dist || Math.abs(c.dist - dist) <= 60) &&
        (!fs || !c.n || Math.abs(c.n - fs) <= 4));
      for (const c of cand) {
        const parts = await getParts(c.R, c.C);
        if (parts && nameOverlap(race.runners, parts.map((p) => p.nom)) >= 0.5) {
          matched = { c, parts };
          break;
        }
      }
      if (!matched) { stats.misses.push(m.venue + " R" + race.raceNo + " (pmu)"); continue; }
      race.priceRef = { src: "pmu", R: matched.c.R, C: matched.c.C };
      const win = await getRapports(matched.c.R, matched.c.C, "E_SIMPLE_GAGNANT");
      const pla = await getRapports(matched.c.R, matched.c.C, "E_SIMPLE_PLACE");
      const numByName = {};
      matched.parts.forEach((p) => { numByName[normName(p.nom)] = p.numPmu; });
      for (const h of race.runners || []) {
        const np = numByName[normName(h.name)];
        if (np == null) continue;
        const w = win[np] || {};
        const p = pla[np] || {};
        if (w.direct == null && p.direct == null && w.ref == null) continue;
        h.price = {
          win: w.direct != null ? w.direct : null,
          pla: p.direct != null ? p.direct : null,
          ref: w.ref != null ? w.ref : null,
          src: "pmu",
          srcNo: np,
        };
        stats.pricedRunners++;
      }
      stats.matchedRaces++;
    }
  }
}

// SA press-forecast prices. The bookmaker sites are Cloudflare walls, but the Race
// Coast preview prose we ALREADY fetch routinely carries betting forecasts in text
// ("should be around 9-2"). This scans each SA source's text for fractional odds
// within a short window after a card runner's name and stamps a LOW-FIDELITY price
// (src:"sapress"). Guardrails: only classic fractional denominators, never
// overwrite a real tote price, and the odds must sit within 90 chars of the name.
function fracToDec(a, b) { return b > 0 ? a / b + 1 : 0; }
function saPrices(pack, stats) {
  const DENOMS = { 1: 1, 2: 1, 4: 1, 5: 1, 8: 1, 10: 1 };
  const saMeets = (pack.meets || []).filter((m) => m.region === "SA" && (m.raceMap || []).length);
  for (const m of saMeets) {
    const texts = (m.sources || []).filter((s) => s.ok && !s.ssotFail && s.text).map((s) => String(s.text));
    if (!texts.length) continue;
    const blob = texts.join("\n").toUpperCase();
    for (const race of m.raceMap || []) {
      let hit = false;
      for (const h of race.runners || []) {
        if (h.price) continue; // never downgrade a real price
        const nm = String(h.name || "").toUpperCase();
        if (!nm) continue;
        let i = -1;
        while ((i = blob.indexOf(nm, i + 1)) !== -1) {
          const win = blob.slice(i + nm.length, i + nm.length + 90);
          const mt = /(\d{1,2})\s*[-\/]\s*(\d{1,2})/.exec(win);
          if (mt) {
            const a = parseInt(mt[1], 10), b = parseInt(mt[2], 10);
            if (DENOMS[b] && a >= 1 && a <= 40 && !(a <= 31 && b > 10)) {
              h.price = { win: Math.round(fracToDec(a, b) * 100) / 100, pla: null, ref: null, src: "sapress" };
              stats.pricedRunners++;
              hit = true;
              break;
            }
          }
        }
      }
      if (hit) stats.matchedRaces++;
    }
  }
}

async function stagePrices(pack) {
  const stats = { at: new Date().toISOString(), matchedRaces: 0, pricedRunners: 0, misses: [], errors: [] };
  try { await tabPrices(pack, stats); } catch (e) { stats.errors.push("tab: " + String(e.message || e)); }
  try { await pmuPrices(pack, stats); } catch (e) { stats.errors.push("pmu: " + String(e.message || e)); }
  try { saPrices(pack, stats); } catch (e) { stats.errors.push("sapress: " + String(e.message || e)); }
  stats.misses = stats.misses.slice(0, 60);
  pack.prices = stats;
  return stats;
}

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
  // THE SGPools RACE CARD IS THE SINGLE SOURCE OF TRUTH. Everything downstream — every
  // tipster, every preview, every selection — is checked against what comes back here.
  //
  // TWO THINGS THIS MUST NEVER DO AGAIN:
  //
  // 1. Call triage2 WITHOUT a date. It silently defaults to the FIRST available date on
  //    the SGPools list, which is usually days stale (asked on 17/07, returned 11/07).
  //    A stale card is worse than no card: it looks authoritative and is wrong.
  //
  // 2. Assume the runner map arrived. map=1 is now explicit rather than trusting a
  //    downstream default, and a meet with no runners is treated as having no card at all.
  const want = dateParam || phuketToday();
  const url = BASE + "/api/triage2?map=1&date=" + encodeURIComponent(want);
  const r = await fetchWithTimeout(url, 25000, true);
  if (!r.ok) throw new Error("triage2 failed: " + r.error);
  const t = r.body;
  if (t.error) throw new Error("triage2: " + t.error);

  // THE CARD MUST BE FOR THE DAY WE ASKED FOR. If SGPools has no card for today, the
  // honest answer is "no racing to bet", not "here is some other day's racing".
  if (t.date && String(t.date).trim() !== String(want).trim())
    throw new Error(
      "SGPools card date mismatch: asked for " + want + ", got " + t.date +
      ". Refusing to build a book against another day's card. Available: " +
      (t.dates || []).join(", ")
    );

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

  // ---- FRANCE ONLY: the PMU racecard, attached PER MEET ----
  // Everything above is fanned out by REGION, so every meet in a region gets the
  // identical text — which is why three Australian meets all received the same
  // racingnsw homepage. This adapter cannot work that way: it matches against THIS
  // meet's runner map, so it is built per meet and appended after the fan-out.
  // Scoped to FR by design; no other region's sources are touched.
  await Promise.all(
    pack.meets
      .filter((m) => m.region === "FR")
      .map(async (m) => {
        try {
          const src = await pmuFranceSource(pack, m);
          if (src) m.sources.push(src);
        } catch (e) {
          m.sources.push({
            id: "pmu-racecard", kind: "card", ok: false,
            error: "PMU adapter threw: " + String(e.message || e), chars: 0, text: "",
          });
        }
      })
  );
  // ============================================================================
  // THE SSOT GATE — the SGPools race card is the single source of truth.
  // ============================================================================
  // Standing instruction from Hammy, given repeatedly and violated on 17/07/2026:
  // the SGPools race card at RaceCards.aspx is the ULTIMATE source of truth, and
  // EVERY tip source must reference back to it. Verify on date, meet, venue, race
  // number, horse number and horse name. Nothing else is authoritative.
  //
  // What went wrong on 17/07: Race Coast's API served previews for 18/07, 19/07,
  // 15/07 — and NOTHING for 17/07, because their pundits cover Hollywoodbets
  // tracks and today's SGPools "South Africa" was a course they do not preview.
  // Gold Circle likewise served a Durbanville sheet for a meeting SGPools was not
  // carrying. The trawl fetched both successfully, and a source returning 14k of
  // rich pundit prose looks EXACTLY like a working source whether it describes
  // today's card or next Saturday's. Six legs were staked on horses nobody had
  // analysed: not one of the six tipped horses appeared on the SGPools SA card,
  // and five of six race distances disagreed.
  //
  // Fetching a source successfully is NOT the same as the source being about the
  // meeting we can bet. That question was never asked. It is asked here now.
  //
  // The card gives us every field needed to answer it, so we use all of them:
  //   - RUNNER NAMES: how many of this meet's actual runners does the source name?
  //     This is the strongest signal and cannot be faked by coincidence.
  //   - RACE DISTANCES: the card says R6 is 1400m; a source calling R6 "1250m" is
  //     describing a different race, however confident its prose sounds.
  //   - THE DATE: the card is for a specific day. A source naming a DIFFERENT date
  //     prominently is previewing another meeting.
  // A source that fails on runners is disqualified outright — its race and horse
  // numbers are meaningless for this coupon and any pick taken from it lands on an
  // unrelated horse.
  const ssotVerify = (meet, text) => {
    const names = [];
    const dists = [];
    (meet.raceMap || []).forEach((r) => {
      if (r.dist && /^\d+m$/.test(String(r.dist))) dists.push(String(r.dist).toLowerCase());
      (r.runners || []).forEach((h) => {
        const n = String(h.name || "").trim();
        if (n.length > 3) names.push(n);
      });
    });
    const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const body = norm(text);
    const raw = String(text || "").toLowerCase();

    const nameHits = names.filter((n) => body.includes(norm(n)));
    const namePct = names.length ? Math.round((nameHits.length / names.length) * 100) : 0;
    const distHits = [...new Set(dists)].filter((d) => raw.includes(d.replace("m", "m")) || raw.includes(d.replace("m", " m")));

    // Date check: does the source name a date OTHER than the card's, and not the card's?
    const cardDate = String(pack.date || "").trim(); // DD/MM/YYYY
    const dm = cardDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    let dateWarn = null;
    if (dm) {
      const MON = ["january","february","march","april","may","june","july","august","september","october","november","december"];
      const d = String(parseInt(dm[1], 10));
      const monthName = MON[parseInt(dm[2], 10) - 1] || "";
      const mentionsToday =
        raw.includes(cardDate) ||
        (monthName && new RegExp("\\b" + d + "\\s+" + monthName + "\\b").test(raw));
      // other dates of the same month named in the text
      const others = monthName
        ? [...raw.matchAll(new RegExp("\\b(\\d{1,2})\\s+" + monthName + "\\b", "g"))].map((x) => x[1])
        : [];
      const otherDays = [...new Set(others)].filter((x) => x !== d);
      if (!mentionsToday && otherDays.length)
        dateWarn =
          "names " + monthName + " " + otherDays.join(", ") + " but NOT " + d + " " + monthName +
          " (the card's date)";
    }

    return { names: names.length, nameHits: nameHits.length, namePct, distHits: distHits.length, dists: [...new Set(dists)].length, dateWarn };
  };

  // Run the gate over every source on every meet. A source that names NONE of the
  // card's runners is disqualified: `ssotFail` is set, and buildCopyText refuses
  // to hand its text to the model at all. Half-measures are what got us here — a
  // warning buried in 14k of prose is a warning the model reads past.
  for (const m of pack.meets) {
    for (const s of m.sources || []) {
      if (!s.ok || !s.text) continue;
      const v = ssotVerify(m, s.text);
      s.ssot = v;
      if (v.names >= 8 && v.nameHits === 0) {
        s.ssotFail =
          "names 0 of the " + v.names + " runners on the SGPools card for " + m.venue +
          (v.dateWarn ? "; " + v.dateWarn : "") +
          " — this source is about a DIFFERENT MEETING and its race/horse numbers do not " +
          "apply to this coupon";
      } else if (v.names >= 8 && v.namePct < 5 && v.dateWarn) {
        s.ssotFail =
          "names only " + v.nameHits + " of " + v.names + " card runners (" + v.namePct + "%) and " +
          v.dateWarn + " — treated as a different meeting";
      }
    }
    const live = (m.sources || []).filter((s) => s.ok && s.text && !s.ssotFail);
    const rejected = (m.sources || []).filter((s) => s.ssotFail);
    m.ssotRejected = rejected.map((s) => ({ id: s.id, why: s.ssotFail }));
    // A meet whose every source failed the gate is UNSOURCED, and must be said so
    // plainly. This is precisely the 17/07 South Africa case: sources fetched fine,
    // all of them described other meetings, and the model was handed them as if
    // they were today's homework.
    if ((m.sources || []).length && !live.length && rejected.length)
      m.ssotBlind =
        "EVERY source for " + m.venue + " failed verification against the SGPools card. " +
        "No source published analysis of this meeting. There is NO data edge here today: " +
        "do not select from this meet.";
  }

  pack.sourceHealth = results.map((s) => {
    const m = pack.meets.find((x) => (x.sources || []).some((y) => y.id === s.id));
    const src = m ? (m.sources || []).find((y) => y.id === s.id) : null;
    return {
      id: s.id, region: s.region, ok: s.ok, chars: s.text.length, error: s.error,
      ssot: src && src.ssot ? src.ssot.nameHits + "/" + src.ssot.names + " card runners" : null,
      ssotFail: src ? src.ssotFail || null : null,
    };
  });


  // BLIND MEETS. A meet whose region has no adapter (Peru, Mauritius — anything falling to
  // "OTHER") gets an empty sources array and would otherwise look identical to a meet whose
  // sources all happened to fail: silently sourceless, with the day's read built on nothing.
  // The Charter's data-edge-gate law says "only bet meets where we have a genuine data
  // edge"; this is what lets that gate actually see. Surfaced on the pack so the reader and
  // the slip-builder can both treat it as the hard signal it is.
  pack.blindMeets = pack.meets
    .filter((m) => !(m.sources || []).some((s) => s.ok && s.chars > 900))
    .map((m) => ({ venue: m.venue, region: m.region, reason: (ADAPTERS[m.region] || []).length ? "all sources failed today" : "no adapter for region " + m.region }));
  if (pack.blindMeets.length) {
    pack.blindWarning =
      pack.blindMeets.length + " meet(s) have NO usable source today (" +
      pack.blindMeets.map((b) => b.venue).join(", ") +
      "). The data-edge gate cannot be satisfied for these: treat any pick there as unevidenced.";
  }
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
      else if (s.ssotFail) {
        // WITHHELD, not warned. The 17/07 lesson: a caution banner sitting above 14k of
        // confident pundit prose is a caution the model reads straight past — it did, and
        // six legs went on horses nobody analysed. If a source cannot be verified against
        // the SGPools card, its text is not shown at all. There is nothing in it worth
        // reading: every race number and horse number in it belongs to another meeting.
        L.push(
          "\n[" + s.id + "] WITHHELD — FAILED VERIFICATION AGAINST THE SGPools CARD: " +
          s.ssotFail + ". Its text is deliberately not included. Do not ask for it and do " +
          "not select from it."
        );
      } else {
        const v = s.ssot;
        const note =
          v && v.names
            ? "\n(verified against the SGPools card: names " + v.nameHits + " of " + v.names +
              " runners" + (v.dateWarn ? "; NOTE it " + v.dateWarn : "") + ")"
            : "";
        L.push("\n[" + s.id + "]" + note + "\n" + String(s.text).slice(0, 4500));
      }
    });
    if (m.ssotBlind) L.push("\n*** " + m.ssotBlind + " ***");
  }
  return L.join("\n");
}

export default async (req, res) => {
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

    if (action === "results") {
      // THE RESULTS WIRE (enhancement #1, 19/07/2026). For priced regions the same
      // endpoints that served morning odds serve final arrival orders and declared
      // dividends after the race. SGPools COMMINGLES into host totes for most
      // foreign meets, so host dividends are, to rounding and currency policy, the
      // dividends. This action PROPOSES settlements only — positions and results
      // are gospel, payouts are host-tote ESTIMATES the user confirms against the
      // SGPools slip. The commit still goes through stewards' settle with all its
      // guards. The wire taps; the stewards sign.
      const dateParam = req.query.date ? String(req.query.date) : phuketToday();
      const pack = await loadPack(dateParam);
      if (!pack) return res.status(409).json({ error: "No pack for " + dateParam });
      const [logRaw] = await redis([["GET", "stw:betlog"]]);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded" });
      const log = JSON.parse(logRaw);
      const rnum = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
      const rr2 = (v) => Math.round(rnum(v) * 100) / 100;
      const VENUE_CODE = {
        "South Africa": "SA", "France": "FR", "United Kingdom": "UK",
        "Australia": "AU", "Australia (Melbourne)": "MB", "Australia (Perth)": "PE",
        "Korea": "SK", "Japan": "JP", "Turkey": "TK", "Malaysia (Selangor)": "MY",
        "Malaysia": "MY", "Germany": "DE", "Hong Kong": "HK", "Singapore": "SG",
      };
      const raceIx = {};
      (pack.meets || []).forEach((m) => {
        const code = VENUE_CODE[m.venue] || m.venue;
        (m.raceMap || []).forEach((r) => { raceIx[code + "|" + r.raceNo] = r; });
      });
      const pend = log.filter((r) =>
        String(r.date) === dateParam &&
        (String(r.ledger || "Model").trim() === "Model") &&
        ["", "pending"].includes(String(r.result || "").trim().toLowerCase()));
      const placesFor = (fs) => (fs >= 8 ? 3 : fs >= 5 ? 2 : 1);
      const d = dateParam.split("/");
      const tabDate = d[2] + "-" + d[1] + "-" + d[0];
      const pmuBase = "https://online.turfinfo.api.pmu.fr/rest/client/61/programme/" + d[0] + d[1] + d[2];
      const cache = {};
      async function tabFinal(venue, n) {
        const k = "t|" + venue + "|" + n;
        if (cache[k] !== undefined) return cache[k];
        const u = "https://api.beta.tab.com.au/v1/tab-info-service/racing/dates/" + tabDate +
          "/meetings/R/" + encodeURIComponent(venue) + "/races/" + n + "?jurisdiction=NSW";
        const r = await fetchWithTimeout(u, 12000, true, { ua: "iphone" });
        if (!r.ok) return (cache[k] = null);
        const b = r.body || {};
        const pos = {};
        const resArr = b.results || b.raceResults || [];
        if (Array.isArray(resArr))
          resArr.forEach((slot, i) =>
            (Array.isArray(slot) ? slot : [slot]).forEach((num) => { if (num != null) pos[num] = i + 1; }));
        const winD = {}, plaD = {};
        (b.dividends || b.poolDividends || []).forEach((e) => {
          const t = String(e.wageringProduct || e.poolType || e.divType || e.betType || "").toUpperCase();
          const entries = e.poolDividends || e.dividends || [e];
          entries.forEach((x) => {
            const amt = rnum(x.amount != null ? x.amount : x.dividend);
            const sels = [].concat(x.selections != null ? x.selections : (x.numbers != null ? x.numbers : (x.number != null ? [x.number] : [])));
            if (!amt || !sels.length) return;
            sels.forEach((s) => {
              const numOnly = parseInt(String(s).replace(/[^0-9]/g, ""), 10);
              if (!numOnly) return;
              if (t.indexOf("WIN") !== -1) winD[numOnly] = amt;
              else if (t.indexOf("PLACE") !== -1) plaD[numOnly] = amt;
            });
          });
        });
        return (cache[k] = { done: Object.keys(pos).length > 0, pos, win: winD, pla: plaD, raw: !Object.keys(winD).length && !Object.keys(plaD).length ? "no dividends parsed" : null });
      }
      async function pmuFinal(R, C) {
        const k = "p|" + R + "|" + C;
        if (cache[k] !== undefined) return cache[k];
        const pr = await fetchWithTimeout(pmuBase + "/R" + R + "/C" + C + "/participants", 12000, true);
        const pos = {};
        if (pr.ok) (pr.body.participants || []).forEach((p) => { if (p.ordreArrivee) pos[p.numPmu] = p.ordreArrivee; });
        const rd = await fetchWithTimeout(pmuBase + "/R" + R + "/C" + C + "/rapports-definitifs", 12000, true);
        const winD = {}, plaD = {};
        if (rd.ok) {
          const arr = Array.isArray(rd.body) ? rd.body : [rd.body];
          arr.forEach((t) => {
            const type = String(t.typePari || "");
            (t.rapports || []).forEach((x) => {
              const numOnly = parseInt(String(x.combinaison).replace(/[^0-9]/g, ""), 10);
              const amt = rnum(x.dividendePourUnEuro != null ? x.dividendePourUnEuro : x.dividende) / 100;
              if (!numOnly || !amt) return;
              if (type === "SIMPLE_GAGNANT") winD[numOnly] = rr2(amt);
              else if (type === "SIMPLE_PLACE") plaD[numOnly] = rr2(amt);
            });
          });
        }
        return (cache[k] = { done: Object.keys(pos).length > 0, pos, win: winD, pla: plaD });
      }
      const settlements = [], skipped = [];
      for (const leg of pend) {
        const race = raceIx[leg.meet + "|" + leg.raceNo];
        if (!race) { skipped.push({ leg: leg.horseName, why: "no pack race for " + leg.meet + " R" + leg.raceNo }); continue; }
        const ref = race.priceRef;
        if (!ref) { skipped.push({ leg: leg.horseName, why: "race was never price-matched (unpriced region or no sweep)" }); continue; }
        const runner = (race.runners || []).find((h) => String(h.no) === String(leg.horseNo));
        const srcNo = runner && runner.price && runner.price.srcNo;
        if (srcNo == null) { skipped.push({ leg: leg.horseName, why: "runner not source-mapped" }); continue; }
        const fin = ref.src === "tab" ? await tabFinal(ref.venue, ref.srcRaceNo) : await pmuFinal(ref.R, ref.C);
        if (!fin || !fin.done) { skipped.push({ leg: leg.horseName, why: "race not resulted yet" }); continue; }
        const posN = fin.pos[srcNo] || null;
        const fs = race.fieldSize || (race.runners || []).length || 0;
        const places = placesFor(fs);
        let result, div = null;
        if (posN === 1) { result = leg.betType === "WIN" ? "Win" : "Place"; div = leg.betType === "WIN" ? fin.win[srcNo] : fin.pla[srcNo]; }
        else if (posN && posN <= places && leg.betType === "PLA") { result = "Place"; div = fin.pla[srcNo]; }
        else result = "Lose";
        // favourite = shortest pre-race win price in this race; its place div if it placed
        let favDiv = null;
        let fav = null;
        (race.runners || []).forEach((h) => {
          if (h.price && h.price.win != null && (!fav || h.price.win < fav.price.win)) fav = h;
        });
        if (fav && fav.price.srcNo != null) favDiv = fin.pla[fav.price.srcNo] != null ? fin.pla[fav.price.srcNo] : null;
        settlements.push({
          xlRow: leg.xlRow, meet: leg.meet, raceNo: leg.raceNo, horseNo: leg.horseNo,
          horseName: leg.horseName, betType: leg.betType, src: ref.src,
          result, position: posN, legDiv: div != null ? rr2(div) : null,
          favDiv: favDiv != null ? rr2(favDiv) : null, fieldSize: fs || null,
          payout: result === "Lose" ? 0 : (div != null ? rr2(rnum(leg.stake) * div) : null),
          note: "host-tote estimate \u2014 confirm vs SGPools slip",
        });
      }
      return res.status(200).json({ ok: true, date: dateParam, pending: pend.length, settlements, skipped });
    }

    if (action === "prices") {
      // PHASE 3.1: fetch/refresh prices onto the pack. Runs at PROPOSE time (pools
      // are shut at the 8am trawl — 03:00 in Paris). 10-minute freshness cache so
      // repeat opens cost nothing; &force=1 busts it.
      const dateParam = req.query.date ? String(req.query.date) : phuketToday();
      const pack = await loadPack(dateParam);
      if (!pack)
        return res.status(409).json({ error: "No pack for " + dateParam + ". Run the trawl first." });
      const fresh =
        pack.prices && pack.prices.at &&
        Date.now() - Date.parse(pack.prices.at) < 10 * 60 * 1000;
      let cached = true;
      if (!fresh || req.query.force) {
        await stagePrices(pack);
        await savePack(pack);
        cached = false;
      }
      return res.status(200).json({
        ok: true, date: pack.date, cached,
        prices: {
          at: pack.prices.at,
          matchedRaces: pack.prices.matchedRaces,
          pricedRunners: pack.prices.pricedRunners,
          misses: pack.prices.misses,
          errors: pack.prices.errors,
        },
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

// ---- Vercel function configuration ----
// The trawl's 300s used to be declared in vercel.json's "functions" block. That entry
// was removed (d625ca5) while chasing a build failure, which left the longest-running
// function in the project on the platform default — so a full ?action=run&stage=all
// sweep could be killed mid-flight with no local sign that anything was wrong, and the
// 00:15 cron would simply stop producing a morning pack.
//
// Declaring it here instead of re-adding it to vercel.json keeps ONE source of truth,
// next to the code whose runtime it bounds, matching odds2.js (45s) and stewards.js
// (120s). If a vercel.json entry for this file is ever restored, note that for plain
// Node /api routes the in-code value wins — so they must agree or the file will say
// one thing and the platform do another.
//
// WHY 300: the sweep fetches every meet's sources and PDFs serially with retries; the
// client's TRAWL_MAX_MS leash in stewards.html is derived from this number. 300 also
// exceeds the classic non-Fluid ceiling of 60s, so it depends on Fluid compute being
// enabled on this project (as stewards.js's 120 already does).
export const config = { maxDuration: 300 };

// The France card matcher, exported so the safety suite drives the SHIPPED functions
// rather than a copy of them. matchCard takes its runner-name lookup by injection
// precisely so it can be exercised without a network.
export { matchCard, pmuCoursesFromProgramme, pmuSourceText };
