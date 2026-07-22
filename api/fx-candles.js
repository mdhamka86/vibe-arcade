// api/fx-candles.js
// SHARED FX CANDLE LAYER — the one place that knows how to fetch, aggregate and cache price
// history for both desks. Owns the symbol map for the UNION of The Terminal's universe and
// forex-brain's, so neither has to grow its own copy and drift.
//
// WHY YAHOO, AND NOT TWELVEDATA
// The brief allowed either. TwelveData is what forex-brain uses, on an 8-request/minute free
// tier with a 1200ms stagger, driven by 16 crons a weekday. The Terminal's screen needs ~50
// requests per run across 25 pairs and two intervals; on that tier it would take over six
// minutes on its own and would contend with forex-brain's crons for the same quota. Yahoo is
// keyless, has no documented per-key limit, and is already proven in this repo — terminal-engine
// has been pulling live quotes and daily OHLC from the same endpoint in production. Choosing it
// does not merely dodge the collision, it removes the shared resource that caused it.
//
// forex-brain is deliberately NOT rewired onto this module in this change. It works, it is a
// separate product on a separate horizon, and converting a live paper-trading engine's price
// feed is risk nobody asked for. The module exports everything that migration would need
// (getCandles returns the same newest-first shape its computeBox/computeAtr already expect), so
// it is a small, self-contained change whenever it is wanted.
//
// NOTHING HERE REASONS. It fetches, reshapes, caches and reports health. Judgement belongs to
// the callers.

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

// ---------- Redis (best-effort cache; a cache failure must never break a fetch) ----------
async function cacheGet(key) {
  if (!R_URL || !R_TOK) return null;
  try {
    const r = await fetch(`${R_URL}/get/${key}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result == null ? null : JSON.parse(j.result);
  } catch { return null; }
}
async function cacheSet(key, val) {
  if (!R_URL || !R_TOK) return false;
  try {
    const r = await fetch(`${R_URL}/set/${key}`, {
      method: 'POST', headers: { Authorization: `Bearer ${R_TOK}` }, body: JSON.stringify(val),
    });
    return r.ok;
  } catch { return false; }
}

// ---------- The union universe ----------
// EVERY pair either desk may ask about, mapped to its Yahoo FX symbol. Yahoo's convention for
// FX is `XXXYYY=X`; the USD majors also answer to the short `YYY=X` form, but the six-letter
// form works for all of them and keeping one convention is worth more than the shorthand.
//
// SCOPE (Hammy's Phillip Nova MT5 book): the majors plus the liquid G10 crosses he can actually
// trade. Emerging-market exotics are deliberately absent — ZAR, TRY, MXN and the like carry
// spreads and gap risk that make a 2-3 day retail hold a different and worse proposition, and
// ranking a pair the desk should never propose is just noise in the screen.
//
// USDCNH is offered by Nova and is deliberately NOT enabled: offshore yuan is managed rather
// than freely floating, so the trend and volatility factors the screen scores on mean something
// different for it than for a G10 cross. Add it below if you want it, but read that caveat
// first. The definitive list is whatever his MT5 Market Watch shows; this is the confirmed
// liquid subset, and any missing pair is a one-line addition here.
export const FX_UNIVERSE = {
  // --- majors (7) ---
  EURUSD: 'EURUSD=X', USDJPY: 'USDJPY=X', GBPUSD: 'GBPUSD=X', USDCHF: 'USDCHF=X',
  AUDUSD: 'AUDUSD=X', NZDUSD: 'NZDUSD=X', USDCAD: 'USDCAD=X',
  // --- EUR crosses (6) ---
  EURGBP: 'EURGBP=X', EURJPY: 'EURJPY=X', EURCHF: 'EURCHF=X',
  EURAUD: 'EURAUD=X', EURCAD: 'EURCAD=X', EURNZD: 'EURNZD=X',
  // --- GBP crosses (5) ---
  GBPJPY: 'GBPJPY=X', GBPCHF: 'GBPCHF=X', GBPAUD: 'GBPAUD=X', GBPCAD: 'GBPCAD=X', GBPNZD: 'GBPNZD=X',
  // --- AUD / NZD crosses (5) ---
  AUDJPY: 'AUDJPY=X', AUDNZD: 'AUDNZD=X', AUDCAD: 'AUDCAD=X', NZDJPY: 'NZDJPY=X', NZDCAD: 'NZDCAD=X',
  // --- remaining JPY crosses (2) ---
  CADJPY: 'CADJPY=X', CHFJPY: 'CHFJPY=X',
  // --- index, for dollar context only; never proposed as a trade ---
  DXY: 'DX-Y.NYB',
};
// The tradeable set the screen ranks. DXY is context, not a trade, so it is excluded here.
export const SCREEN_PAIRS = Object.keys(FX_UNIVERSE).filter((p) => p !== 'DXY');

export const normPair = (p) => (p || '').replace(/[^A-Za-z]/g, '').toUpperCase();

// Pip size for a pair. terminal-engine.js carries its own copy of this rule and KEEPS it: that
// copy sits under an established test suite that extracts it from the engine source, and moving
// it would silently empty those extractions. Two copies of a rule is exactly the drift this
// codebase keeps getting bitten by, so the protection is not "don't duplicate" but a test —
// tests/test_terminal_screen.js asserts the two agree across the whole universe, which is a
// stronger guarantee than a shared function nobody checks.
export function pipSizeFor(pair, refPx) {
  const p = normPair(pair);
  const quote = p.length >= 6 ? p.slice(3, 6) : '';
  if (quote === 'JPY' || p.includes('JPY')) return 0.01;
  if (!quote && refPx != null && refPx > 20) return 0.01;
  return 0.0001;
}

// ---------- Yahoo fetch ----------
// Returns candles NEWEST-FIRST, which is the shape forex-brain's computeBox/computeAtr expect
// (they treat index 0 as the in-progress bar and skip it). Values are numbers; those functions
// parseFloat anyway, so either would work, but numbers keep the cache compact.
const INTERVALS = {
  '1d': { yf: '1d', range: '3mo', ttlMs: 3 * 3600e3 },   // daily: changes once a session
  '1h': { yf: '60m', range: '1mo', ttlMs: 45 * 60e3 },   // hourly: changes within the hour
};

function parseChart(json) {
  const res = json && json.chart && json.chart.result && json.chart.result[0];
  if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) return null;
  const q = res.indicators.quote[0] || {};
  const ts = res.timestamp;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    // Yahoo leaves nulls in the series across market closures. A null bar is a hole, not a
    // zero, and letting one through would poison every true-range that touches it.
    if (![o, h, l, c].every((v) => Number.isFinite(v))) continue;
    out.push({ datetime: new Date(ts[i] * 1000).toISOString(), open: o, high: h, low: l, close: c, t: ts[i] * 1000 });
  }
  out.reverse(); // newest-first
  return { candles: out, meta: res.meta || {} };
}

async function fetchYahoo(sym, interval) {
  const cfg = INTERVALS[interval];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${cfg.yf}&range=${cfg.range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (hammyLabs-fx-candles/1.0)' } });
  if (!r.ok) throw new Error(`yahoo ${sym} ${interval}: http ${r.status}`);
  const parsed = parseChart(await r.json());
  if (!parsed || parsed.candles.length < 3) throw new Error(`yahoo ${sym} ${interval}: no usable candles`);
  return parsed;
}

// Candles for one pair at one interval, Redis-cached. Returns
//   { pair, interval, candles (newest-first), last, meta, cached, at }
// or throws. Callers decide what a failure means for them; this module does not guess.
export async function getCandles(pair, interval = '1d') {
  const p = normPair(pair);
  const sym = FX_UNIVERSE[p];
  if (!sym) throw new Error(`${p} is not in the FX universe — add it to FX_UNIVERSE if it is tradeable`);
  if (!INTERVALS[interval]) throw new Error(`unsupported interval ${interval}`);
  const key = `fx:candles:${p}:${interval}`;
  const cached = await cacheGet(key);
  if (cached && Date.now() - cached.at < INTERVALS[interval].ttlMs) return { ...cached, cached: true };
  try {
    const { candles, meta } = await fetchYahoo(sym, interval);
    const pack = { pair: p, interval, candles, last: candles[0]?.close ?? null, meta: { regularMarketPrice: meta.regularMarketPrice ?? null, regularMarketTime: meta.regularMarketTime ?? null }, at: Date.now() };
    await cacheSet(key, pack);
    return { ...pack, cached: false };
  } catch (e) {
    // A stale cache beats nothing: for D1 factors a few hours of age changes little, and the
    // caller is told exactly how old it is so it can decide rather than being misled.
    if (cached) return { ...cached, cached: true, stale: true, fetchError: String(e.message || e) };
    throw e;
  }
}

// Aggregate N consecutive candles into one. Input and output are NEWEST-FIRST. Used to build H4
// from H1, which Yahoo does not serve directly.
//
// Aggregation starts from the OLDEST bar so the grouping is stable as new bars arrive: grouping
// from the newest end would re-cut every bucket each hour and make the H4 series jitter.
export function aggregate(candlesNewestFirst, factor) {
  if (!Array.isArray(candlesNewestFirst) || factor < 2) return candlesNewestFirst || [];
  const asc = [...candlesNewestFirst].reverse();
  const out = [];
  for (let i = 0; i + factor <= asc.length; i += factor) {
    const g = asc.slice(i, i + factor);
    out.push({
      datetime: g[0].datetime,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
      t: g[0].t,
    });
  }
  out.reverse();
  return out;
}

// Fetch a whole universe at one interval with bounded concurrency, reporting per-pair health so
// a dead symbol is VISIBLE rather than a silently missing row in the ranking.
export async function getUniverseCandles(pairs, interval = '1d', concurrency = 6) {
  const list = [...pairs];
  const out = {};
  const health = [];
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const p = list[idx++];
      try {
        const pack = await getCandles(p, interval);
        out[normPair(p)] = pack;
        health.push({ pair: normPair(p), ok: true, bars: pack.candles.length, cached: !!pack.cached, stale: !!pack.stale });
      } catch (e) {
        health.push({ pair: normPair(p), ok: false, error: String(e.message || e).slice(0, 90) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { candles: out, health };
}

export default { FX_UNIVERSE, SCREEN_PAIRS, getCandles, getUniverseCandles, aggregate, pipSizeFor, normPair };
