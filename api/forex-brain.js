// api/forex-brain.js
// THE FOREX BRAIN — Phase 1 (paper only). See FOREX_BRAIN.md for the law.
// Trawl -> converge -> verdict pipeline for the seven USD majors.
// Price maths from Twelve Data (deterministic, in code). News/conviction from
// the web layer. Reasoning from claude-fable-5, called ONCE per pair per cycle
// with a pre-digested pack. The model never trawls; code never reasons.
//
// Actions:
//   GET/POST ?action=run&stage=prices|news|converge|all
//   GET      ?action=verdicts                  -> latest verdict per pair
//   GET      ?action=verdict&symbol=EURUSD     -> one verdict
//   GET      ?action=journal&n=50              -> recent decision log
//   GET      ?action=health                    -> config + env sanity
//
// Cron (vercel.json): session-weighted, see FOREX_BRAIN.md Section 6.
// Every stage is idempotent; a rerun only improves the pack.
//
// Env required: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//               ANTHROPIC_API_KEY, TWELVEDATA_API_KEY
//
// NOTHING in this file places an order. Phase 1 is paper. The hands do not exist yet.

// ---------------------------------------------------------------- CONFIG ----

export const CONFIG = {
  model: "claude-fable-5",
  boxCandles: 24,            // completed H1 candles forming the range
  atrPeriod: 14,
  minSources: 3,             // convergence floor: fewer reached => forced FLAT
  maxRiskPercent: 1.0,       // brain may never suggest above this
  defaultRiskPercent: 0.5,
  verdictTtlMinutes: 90,     // expiresAt = now + ttl
  redFolderGuardMinutes: 45, // high-impact event within this window => forced FLAT
  minConvictionToEmit: 0,    // paper phase: emit everything, we want to read it all
  pairs: [
    { symbol: "EURUSD", td: "EUR/USD", ccys: ["EUR", "USD"] },
    { symbol: "USDJPY", td: "USD/JPY", ccys: ["USD", "JPY"] },
    { symbol: "GBPUSD", td: "GBP/USD", ccys: ["GBP", "USD"] },
    { symbol: "USDCHF", td: "USD/CHF", ccys: ["USD", "CHF"] },
    { symbol: "AUDUSD", td: "AUD/USD", ccys: ["AUD", "USD"] },
    { symbol: "USDCAD", td: "USD/CAD", ccys: ["USD", "CAD"] },
    { symbol: "NZDUSD", td: "NZD/USD", ccys: ["NZD", "USD"] },
  ],
  // News/conviction layer. Every source declares how it is fetched so the
  // manifest can report exactly what was and wasn't reached.
  newsSources: [
    { id: "ff-calendar", kind: "json", url: "https://nfs.faireconomy.media/ff_calendar_thisweek.json" },
    { id: "forexlive",   kind: "rss",  url: "https://www.forexlive.com/feed/news" },
    { id: "investing",   kind: "rss",  url: "https://www.investing.com/rss/news_1.rss" },
    { id: "babypips",    kind: "rss",  url: "https://www.babypips.com/feed.rss" },
    { id: "fed-press",   kind: "rss",  url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  ],
};

// ----------------------------------------------------------------- REDIS ----

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const res = await fetch(`${R_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${R_TOK}` },
  });
  if (!res.ok) throw new Error(`redis ${cmd[0]} ${res.status}`);
  const j = await res.json();
  return j.result;
}
const rGet = (k) => redis(["GET", k]).then((v) => (v ? JSON.parse(v) : null));
const rSet = (k, v) => redis(["SET", k, JSON.stringify(v)]);
const rPush = (k, v) => redis(["LPUSH", k, JSON.stringify(v)]).then(() => redis(["LTRIM", k, "0", "499"]));
const rRange = (k, n) => redis(["LRANGE", k, "0", String(n - 1)]).then((a) => (a || []).map((s) => JSON.parse(s)));

const K = {
  prices: (s) => `forex:prices:${s}`,
  news: "forex:news",
  verdict: (s) => `forex:verdict:${s}`,
  journal: "forex:journal",
  executed: "forex:executedIds", // reserved for the hands (Phase 3+)
};

// --------------------------------------------------- DETERMINISTIC MATHS ----
// Pure functions. Everything here is unit-tested in tests/forex-brain.test.js.
// The model never does arithmetic; these do.

export function computeBox(candles, n) {
  // candles: newest-first array of {datetime, open, high, low, close} (strings ok).
  // Uses the n most recent COMPLETED candles: index 0 is assumed in-progress and skipped.
  if (!Array.isArray(candles) || candles.length < n + 1) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = 1; i <= n; i++) {
    const h = parseFloat(candles[i].high), l = parseFloat(candles[i].low);
    if (!isFinite(h) || !isFinite(l)) return null;
    if (h > hi) hi = h;
    if (l < lo) lo = l;
  }
  return { high: hi, low: lo, size: +(hi - lo).toFixed(6) };
}

export function computeAtr(candles, period) {
  // Simple ATR over completed candles (indices 1..period+1).
  if (!Array.isArray(candles) || candles.length < period + 2) return null;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const h = parseFloat(candles[i].high), l = parseFloat(candles[i].low);
    const pc = parseFloat(candles[i + 1].close);
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (!isFinite(tr)) return null;
    sum += tr;
  }
  return +(sum / period).toFixed(6);
}

export function convergenceFloorOk(sourcesReached, minSources) {
  return !!(sourcesReached && typeof sourcesReached.hit === "number" && sourcesReached.hit >= minSources);
}

export function isStale(verdict, nowIso) {
  if (!verdict || !verdict.expiresAt) return true;
  return new Date(nowIso) >= new Date(verdict.expiresAt);
}

export function redFolderImminent(events, nowIso, guardMinutes, ccys) {
  // events: [{time (ISO), impact, currency, title}]. True if a High-impact
  // event for either currency of the pair lands within the guard window.
  if (!Array.isArray(events)) return false;
  const now = new Date(nowIso).getTime();
  const win = guardMinutes * 60 * 1000;
  return events.some((e) => {
    if (!e || String(e.impact).toLowerCase() !== "high") return false;
    if (!ccys.includes(e.currency)) return false;
    const t = new Date(e.time).getTime();
    return isFinite(t) && t >= now && t - now <= win;
  });
}

export function validateVerdict(v, nowIso) {
  // The full Section-4 gauntlet, minus the live-market checks that belong to
  // the hands (spread, broker min-stop, chase). Returns {ok, errors[]}.
  const errors = [];
  if (!v || typeof v !== "object") return { ok: false, errors: ["not an object"] };
  if (!v.verdictId || typeof v.verdictId !== "string") errors.push("verdictId missing");
  if (!v.symbol || typeof v.symbol !== "string") errors.push("symbol missing");
  if (!["BUY", "SELL", "FLAT"].includes(v.direction)) errors.push("direction invalid");
  if (!(Number.isInteger(v.conviction) && v.conviction >= 0 && v.conviction <= 100)) errors.push("conviction out of range");
  if (!v.expiresAt || isNaN(new Date(v.expiresAt).getTime())) errors.push("expiresAt invalid");
  else if (isStale(v, nowIso)) errors.push("already stale");
  if (typeof v.rationale !== "string" || v.rationale.length < 10) errors.push("rationale missing");
  if (!v.sourcesReached || typeof v.sourcesReached.hit !== "number") errors.push("sourcesReached missing");

  if (v.direction === "FLAT") {
    return { ok: errors.length === 0, errors };
  }
  // Directional verdicts must carry coherent trade geometry.
  const ez = v.entryZone || {};
  const nums = { trigger: ez.trigger, maxChase: ez.maxChase, sl: v.slPrice, tp: v.tpPrice, risk: v.riskPercent };
  for (const [name, val] of Object.entries(nums)) {
    if (!(typeof val === "number" && isFinite(val) && val > 0)) errors.push(`${name} not a positive number`);
  }
  if (errors.length) return { ok: false, errors };

  if (!(v.riskPercent <= CONFIG.maxRiskPercent)) errors.push(`riskPercent above cap ${CONFIG.maxRiskPercent}`);
  if (v.direction === "BUY") {
    if (!(v.slPrice < ez.trigger)) errors.push("BUY: sl must be below trigger");
    if (!(v.tpPrice > ez.trigger)) errors.push("BUY: tp must be above trigger");
    if (!(ez.maxChase >= ez.trigger)) errors.push("BUY: maxChase must be >= trigger");
  } else {
    if (!(v.slPrice > ez.trigger)) errors.push("SELL: sl must be above trigger");
    if (!(v.tpPrice < ez.trigger)) errors.push("SELL: tp must be below trigger");
    if (!(ez.maxChase <= ez.trigger)) errors.push("SELL: maxChase must be <= trigger");
  }
  return { ok: errors.length === 0, errors };
}

export function forceFlat(symbol, nowIso, reason, sourcesReached) {
  return {
    verdictId: `${nowIso}-${symbol.toLowerCase()}`,
    symbol,
    direction: "FLAT",
    conviction: 0,
    expiresAt: new Date(new Date(nowIso).getTime() + CONFIG.verdictTtlMinutes * 60000).toISOString(),
    sourcesReached: sourcesReached || { hit: 0, expected: 0, missing: [] },
    rationale: `FORCED FLAT (code, not model): ${reason}`,
  };
}

// ------------------------------------------------------------ PRICE STAGE ----

async function fetchCandles(tdSymbol) {
  const key = process.env.TWELVEDATA_API_KEY;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=1h&outputsize=60&timezone=UTC&apikey=${key}`;
  const res = await fetch(url);
  const j = await res.json();
  if (j.status === "error" || !Array.isArray(j.values)) throw new Error(`twelvedata ${tdSymbol}: ${j.message || "no values"}`);
  return j.values; // newest first
}

async function stagePrices() {
  const out = { ok: [], failed: [] };
  for (const p of CONFIG.pairs) {
    try {
      const candles = await fetchCandles(p.td);
      const box = computeBox(candles, CONFIG.boxCandles);
      const atr = computeAtr(candles, CONFIG.atrPeriod);
      const last = parseFloat(candles[0].close);
      if (!box || !atr || !isFinite(last)) throw new Error("maths failed on candle data");
      const snap = {
        symbol: p.symbol, at: new Date().toISOString(), last, box, atr,
        distToHigh: +(box.high - last).toFixed(6),
        distToLow: +(last - box.low).toFixed(6),
      };
      await rSet(K.prices(p.symbol), snap);
      out.ok.push(p.symbol);
    } catch (e) {
      out.failed.push({ symbol: p.symbol, error: String(e.message || e) });
    }
    // 8 req/min free-tier limit: 7 pairs fit in one minute with a stagger.
    await new Promise((r) => setTimeout(r, 1200));
  }
  return out;
}

// ------------------------------------------------------------- NEWS STAGE ----

function parseRssTitles(xml, max = 12) {
  const items = [];
  const re = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < max) items.push(m[1].trim());
  return items;
}

function parseFfCalendar(json) {
  // faireconomy weekly calendar: [{title, country, date, impact, ...}]
  if (!Array.isArray(json)) return [];
  return json
    .filter((e) => e && e.country && e.date)
    .map((e) => ({ time: e.date, currency: e.country, impact: e.impact || "", title: e.title || "" }));
}

async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "hammyLabs-forex-brain/1.0" } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function stageNews() {
  const pack = { at: new Date().toISOString(), events: [], headlines: {}, manifest: { hit: 0, expected: CONFIG.newsSources.length, missing: [] } };
  for (const src of CONFIG.newsSources) {
    try {
      const body = await fetchWithTimeout(src.url);
      if (src.kind === "json") {
        pack.events = parseFfCalendar(JSON.parse(body));
      } else {
        pack.headlines[src.id] = parseRssTitles(body);
      }
      pack.manifest.hit++;
    } catch (e) {
      pack.manifest.missing.push({ id: src.id, error: String(e.message || e) });
    }
  }
  await rSet(K.news, pack);
  return pack.manifest;
}

// --------------------------------------------------------- CONVERGE STAGE ----

function buildPrompt(pair, prices, news) {
  const rel = (news.events || []).filter((e) => pair.ccys.includes(e.currency)).slice(0, 20);
  const heads = Object.entries(news.headlines || {}).map(([id, t]) => `${id}: ${t.slice(0, 8).join(" | ")}`).join("\n");
  return `You are the convergence judge for a forex breakout system. Paper phase: no orders exist.

PAIR: ${pair.symbol}
PRICE SNAPSHOT (deterministic, trust it): ${JSON.stringify(prices)}
UPCOMING EVENTS FOR ${pair.ccys.join("/")}: ${JSON.stringify(rel)}
RECENT HEADLINES:\n${heads}

Rules you must obey:
- FLAT is the default and the common answer. Only go directional if the range box plus news genuinely favour a breakout with follow-through.
- riskPercent must be <= ${CONFIG.maxRiskPercent}; default ${CONFIG.defaultRiskPercent}.
- All prices absolute. For BUY: slPrice < trigger < tpPrice, maxChase >= trigger. Reverse for SELL.
- Anchor trigger to the box edge; anchor SL/TP sensibly to box size / ATR.
- If evidence is thin or conflicting, say FLAT and say why.

Respond with ONLY a JSON object, no markdown fences, exactly these keys:
{"direction":"BUY|SELL|FLAT","conviction":0-100,"entryZone":{"trigger":number,"maxChase":number},"slPrice":number,"tpPrice":number,"riskPercent":number,"rationale":"one paragraph"}
For FLAT, entryZone/slPrice/tpPrice/riskPercent may be null.`;
}

async function askModel(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CONFIG.model, max_tokens: 700, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await res.json();
  if (!j.content) throw new Error(`anthropic: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  const text = j.content.map((b) => b.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function stageConverge() {
  const nowIso = new Date().toISOString();
  const news = (await rGet(K.news)) || { events: [], headlines: {}, manifest: { hit: 0, expected: CONFIG.newsSources.length, missing: [{ id: "news-pack", error: "not in redis" }] } };
  const results = [];

  for (const pair of CONFIG.pairs) {
    const prices = await rGet(K.prices(pair.symbol));
    // Source accounting: price snapshot counts as one source; news manifest carries the rest.
    const sourcesReached = {
      hit: (prices ? 1 : 0) + news.manifest.hit,
      expected: 1 + news.manifest.expected,
      missing: [...(prices ? [] : [{ id: "prices", error: "no snapshot" }]), ...news.manifest.missing],
    };

    let verdict;
    // The three CODE-ENFORCED guards. The model is never trusted with these.
    if (!prices) {
      verdict = forceFlat(pair.symbol, nowIso, "no price snapshot", sourcesReached);
    } else if (!convergenceFloorOk(sourcesReached, CONFIG.minSources)) {
      verdict = forceFlat(pair.symbol, nowIso, `convergence floor: ${sourcesReached.hit}/${CONFIG.minSources} sources`, sourcesReached);
    } else if (redFolderImminent(news.events, nowIso, CONFIG.redFolderGuardMinutes, pair.ccys)) {
      verdict = forceFlat(pair.symbol, nowIso, "high-impact event inside guard window", sourcesReached);
    } else {
      try {
        const m = await askModel(buildPrompt(pair, prices, news));
        verdict = {
          verdictId: `${nowIso}-${pair.symbol.toLowerCase()}`,
          symbol: pair.symbol,
          direction: m.direction,
          conviction: Math.round(Number(m.conviction) || 0),
          entryZone: m.entryZone || undefined,
          slPrice: m.slPrice ?? undefined,
          tpPrice: m.tpPrice ?? undefined,
          riskPercent: m.riskPercent ?? undefined,
          expiresAt: new Date(Date.now() + CONFIG.verdictTtlMinutes * 60000).toISOString(),
          sourcesReached,
          rationale: String(m.rationale || ""),
        };
        const check = validateVerdict(verdict, nowIso);
        if (!check.ok) verdict = forceFlat(pair.symbol, nowIso, `model verdict failed validation: ${check.errors.join("; ")}`, sourcesReached);
      } catch (e) {
        verdict = forceFlat(pair.symbol, nowIso, `model call failed: ${String(e.message || e).slice(0, 140)}`, sourcesReached);
      }
    }

    await rSet(K.verdict(pair.symbol), verdict);
    await rPush(K.journal, { at: nowIso, symbol: pair.symbol, direction: verdict.direction, conviction: verdict.conviction, sources: `${sourcesReached.hit}/${sourcesReached.expected}`, rationale: verdict.rationale.slice(0, 240) });
    results.push({ symbol: pair.symbol, direction: verdict.direction, conviction: verdict.conviction });
  }
  return results;
}

// ---------------------------------------------------------------- HANDLER ----

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const isCron = !!req.headers["x-vercel-cron"];
    // A Vercel cron hit with no explicit action means: run the full pipeline.
    const action = q.action || (isCron ? "run" : "health");
    const stage = q.stage || "all";

    // Credit guard: if BRAIN_KEY is set, manual runs must present it. Cron is
    // always trusted (the header only exists on Vercel's own invocations).
    if (action === "run" && process.env.BRAIN_KEY && !isCron && q.key !== process.env.BRAIN_KEY) {
      return res.status(401).json({ ok: false, error: "run requires key" });
    }

    if (action === "health") {
      return res.status(200).json({
        ok: true, phase: "1-paper", model: CONFIG.model,
        pairs: CONFIG.pairs.map((p) => p.symbol),
        env: {
          redis: !!(R_URL && R_TOK),
          anthropic: !!process.env.ANTHROPIC_API_KEY,
          twelvedata: !!process.env.TWELVEDATA_API_KEY,
        },
      });
    }

    if (action === "run") {
      const out = {};
      if (stage === "prices" || stage === "all") out.prices = await stagePrices();
      if (stage === "news" || stage === "all") out.news = await stageNews();
      if (stage === "converge" || stage === "all") out.converge = await stageConverge();
      return res.status(200).json({ ok: true, stage, out });
    }

    if (action === "verdicts") {
      const all = {};
      for (const p of CONFIG.pairs) all[p.symbol] = await rGet(K.verdict(p.symbol));
      return res.status(200).json({ ok: true, verdicts: all });
    }

    if (action === "verdict") {
      const v = await rGet(K.verdict(String(q.symbol || "").toUpperCase()));
      return res.status(200).json({ ok: true, verdict: v });
    }

    if (action === "journal") {
      const n = Math.min(parseInt(q.n || "50", 10) || 50, 200);
      return res.status(200).json({ ok: true, journal: await rRange(K.journal, n) });
    }

    return res.status(400).json({ ok: false, error: `unknown action ${action}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
