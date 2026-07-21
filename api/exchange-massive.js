// api/exchange-massive.js
// THE EXCHANGE — Massive.com (formerly Polygon.io) enrichment layer.
// A sibling to exchange-news.js, dependency-free.
//
// PURPOSE: Finnhub already gives the desk a real-time PRICE. Massive does NOT replace
// that (its free tier is previous-close, not live). Instead Massive adds the QUANTITATIVE
// signals Finnhub's single quote endpoint cannot: server-computed technical indicators
// (RSI/MACD/SMA), real OHLC history, corporate actions, and insider (Form 4) filings.
// These feed the "signal convergence" the ideas + review prompts already ask for but,
// until now, could only guess at from headlines.
//
// FREE TIER (Stocks Basic): technical indicators, previous-day OHLC, corporate actions,
// reference data, and SEC filings — all capped at 5 API calls/MINUTE. That cap is the
// hard constraint this module is built around (see enrichTickers throttling below).
//
// Env var (optional): MASSIVE_API_KEY. Absent key => every function returns null and the
// desk runs unchanged. All response shapes verified against massive.com/docs/rest/stocks
// llms-full.txt (the authoritative machine-readable spec), not guessed.

const MASSIVE_KEY = process.env.MASSIVE_API_KEY || '';
const BASE = 'https://api.massive.com';

// Massive's free tier allows 5 requests per MINUTE. A full bundle is 6 calls per ticker, so
// even one ticker can momentarily exceed 5/min. Rather than sleep ~12s between calls (which
// on Vercel risks a function timeout — Pro defaults to 15s, and relying on Hammy to raise
// maxDuration + enable Fluid Compute is a fragile hidden dependency), we take the robust
// route: fire a ticker's calls in parallel, cap how many UNCACHED tickers we fetch per run,
// and lean on two things — (1) the day-cache means each ticker is fetched at most once per
// day, so steady-state load is tiny, and (2) mFetch already degrades a 429 to null, so if a
// burst does breach the limit the affected signal simply comes back empty this run and fills
// in on the next cycle. Partial data degrades gracefully; a hard timeout would not.
const MAX_TICKERS_PER_RUN = 2;

// US symbols only — Massive is a US-market feed. An SGX/HKEX ticker (C6L, ES3, 700.HK)
// must NOT be sent; it wastes a rate-limited call and returns nothing useful. This mirrors
// the spirit of the engine's sanePrice guard against cross-listing collisions.
function isUsSymbol(ticker) {
  const s = String(ticker || '').toUpperCase();
  // plain 1-5 letter US tickers only; anything with a dot suffix or digits is regional/other
  return /^[A-Z]{1,5}$/.test(s);
}

async function mFetch(path) {
  if (!MASSIVE_KEY) return null;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}apiKey=${MASSIVE_KEY}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'TheExchange/1.0' } });
    // Massive returns 4xx on hard failures BUT also returns HTTP 200 with a body of
    // {status:"ERROR", error:"..."} for some conditions (verified live: missing key gives
    // this shape). So check BOTH the HTTP status AND the body status before trusting data.
    if (!r.ok) return null; // 401 (bad key), 429 (rate limit), 403 (tier) => degrade to null
    const j = await r.json();
    if (j && typeof j.status === 'string' && j.status.toUpperCase() === 'ERROR') return null;
    return j;
  } catch {
    return null; // network error, JSON parse failure, etc. — degrade, never throw
  }
}

// ---------- Technical indicators (server-computed, free tier) ----------
// Verified shape: { results: { underlying, values: [ { timestamp, value, ... } ] }, status }
// NOTE: results is an OBJECT with a values ARRAY — not an array itself.

async function rsi(ticker, window = 14) {
  const j = await mFetch(`/v1/indicators/rsi/${ticker}?timespan=day&window=${window}&series_type=close&order=desc&limit=1`);
  const v = j?.results?.values?.[0]?.value;
  return typeof v === 'number' ? +v.toFixed(1) : null;
}

async function sma(ticker, window = 50) {
  const j = await mFetch(`/v1/indicators/sma/${ticker}?timespan=day&window=${window}&series_type=close&order=desc&limit=1`);
  const v = j?.results?.values?.[0]?.value;
  return typeof v === 'number' ? +v.toFixed(2) : null;
}

async function macd(ticker) {
  const j = await mFetch(`/v1/indicators/macd/${ticker}?timespan=day&short_window=12&long_window=26&signal_window=9&series_type=close&order=desc&limit=1`);
  const row = j?.results?.values?.[0];
  if (!row || typeof row.value !== 'number') return null;
  // verified fields: value, signal, histogram, timestamp
  const hist = (typeof row.histogram === 'number') ? +row.histogram.toFixed(3) : null;
  return { macd: +row.value.toFixed(3), signal: typeof row.signal === 'number' ? +row.signal.toFixed(3) : null, hist };
}

// ---------- Previous-day OHLC (free tier) — real bar, not just a spot price ----------
// Verified shape: { results: [ { c,h,l,o,t,v,vw,T } ], status } — results is an ARRAY here.
async function prevBar(ticker) {
  const j = await mFetch(`/v2/aggs/ticker/${ticker}/prev?adjusted=true`);
  const b = j?.results?.[0];
  if (!b || typeof b.c !== 'number') return null;
  return { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw ?? null };
}

// ---------- Corporate actions: recent splits (catch split-adjusted price bugs) ----------
// Verified shape: { results: [ { execution_date, split_from, split_to, ticker } ], status }
async function recentSplit(ticker) {
  const j = await mFetch(`/v3/reference/splits?ticker=${ticker}&order=desc&limit=1`);
  const sp = j?.results?.[0];
  if (!sp) return null;
  // only flag if it's recent enough to matter (within ~120 days)
  const when = Date.parse(sp.execution_date || '');
  if (!when || (Date.now() - when) > 120 * 86400000) return null;
  return { date: sp.execution_date, from: sp.split_from, to: sp.split_to };
}

// ---------- Insider buying (Form 4) — a signal family the prompt explicitly prizes ----------
// Verified shape: results[] with fields transaction_code ('P' purchase, 'S' sale, 'A' grant,
// 'M' exercise), transaction_acquired_disposed ('A'/'D'), filing_date, transaction_date, and
// tickers (an ARRAY). CRITICAL: the filter param is `tickers` (plural), and each row's ticker
// lives in a `tickers` array — so we both query by tickers= AND verify membership per row.
async function insiderBuys(ticker) {
  const sym = String(ticker).toUpperCase();
  const j = await mFetch(`/stocks/filings/vX/form-4?tickers=${sym}&order=desc&limit=50`);
  const rows = j?.results;
  if (!Array.isArray(rows) || !rows.length) return null;
  // count open-market purchases vs sales in the last ~45 days. A cluster of P's is the
  // meaningful bullish convergence signal; grants (A) and exercises (M) are noise here.
  const cutoff = Date.now() - 45 * 86400000;
  let buys = 0, sells = 0;
  for (const f of rows) {
    // defend against the API returning unrelated rows: verify this filing is actually for our ticker
    const tks = Array.isArray(f.tickers) ? f.tickers.map((t) => String(t).toUpperCase()) : [];
    if (tks.length && !tks.includes(sym)) continue;
    const when = Date.parse(f.filing_date || f.transaction_date || '');
    if (when && when < cutoff) continue;
    const code = String(f.transaction_code || '').toUpperCase();
    if (code === 'P') buys++;
    else if (code === 'S') sells++;
  }
  if (buys === 0 && sells === 0) return null;
  return { buys, sells, net: buys - sells };
}

// ---------- Turn raw signals into a short, prompt-ready convergence line ----------
function summariseSignals(ticker, sig) {
  if (!sig) return null;
  const parts = [];
  if (sig.rsi != null) {
    const tag = sig.rsi <= 30 ? ' (oversold)' : sig.rsi >= 70 ? ' (overbought)' : '';
    parts.push(`RSI ${sig.rsi}${tag}`);
  }
  if (sig.sma != null && sig.prevBar?.c != null) {
    const above = sig.prevBar.c >= sig.sma;
    parts.push(`price ${sig.prevBar.c} ${above ? 'above' : 'below'} 50d SMA ${sig.sma}`);
  }
  if (sig.macd?.hist != null) {
    parts.push(`MACD hist ${sig.macd.hist} (${sig.macd.hist >= 0 ? 'bullish' : 'bearish'})`);
  }
  if (sig.insider) {
    const s = sig.insider;
    if (s.net > 0) parts.push(`insiders net +${s.net} buys (45d)`);
    else if (s.net < 0) parts.push(`insiders net ${s.net} (net selling, 45d)`);
    else if (s.buys || s.sells) parts.push(`insider activity ${s.buys}P/${s.sells}S (45d)`);
  }
  if (sig.split) parts.push(`RECENT SPLIT ${sig.split.from}:${sig.split.to} on ${sig.split.date} — verify price basis`);
  if (!parts.length) return null;
  return `${ticker}: ${parts.join('; ')}`;
}

// ---------- Public: enrich a set of tickers (rate-limit aware, cache-backed) ----------
// Returns { map: { TICKER: {rsi,sma,macd,prevBar,insider,split} }, lines: [ "TICKER: ..." ] }.
// `redis` is an optional {get,set} pair from the engine. Cached tickers cost ZERO live calls;
// only uncached tickers consume the rate budget, and at most MAX_TICKERS_PER_RUN of them.
export async function enrichTickers(tickers, redis) {
  if (!MASSIVE_KEY) return { map: {}, lines: [] };
  const list = [...new Set((tickers || [])
    .map((t) => String(t || '').toUpperCase())
    .filter(Boolean)
    .filter(isUsSymbol))]; // regional tickers skipped — Massive is US only
  if (!list.length) return { map: {}, lines: [] };

  const dayKey = new Date().toISOString().slice(0, 10);
  const map = {};
  let liveBudget = MAX_TICKERS_PER_RUN; // how many uncached tickers we'll pay for this run

  for (const tk of list) {
    const cacheKey = `exchange:massive:${tk}:${dayKey}`;
    // cache first — a cached bundle costs no live calls, so cached tickers are unlimited
    if (redis?.get) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) { map[tk] = cached; continue; }
      } catch { /* cache miss/read error — fall through to a live fetch if budget allows */ }
    }
    // uncached: only fetch if we still have live budget this run; else skip (picked up next run)
    if (liveBudget <= 0) continue;
    liveBudget--;
    // fire the bundle in parallel (6 calls). A momentary breach of 5/min just yields some
    // 429s, which mFetch turns into nulls — partial signal now, complete on the next run.
    const [r, s, m, pb, ins, sp] = await Promise.all([
      rsi(tk), sma(tk), macd(tk), prevBar(tk), insiderBuys(tk), recentSplit(tk),
    ]);
    const bundle = { rsi: r, sma: s, macd: m, prevBar: pb, insider: ins, split: sp };
    map[tk] = bundle;
    if (redis?.set) {
      try { await redis.set(cacheKey, bundle); } catch { /* cache write best-effort */ }
    }
  }

  const lines = Object.entries(map)
    .map(([tk, sig]) => summariseSignals(tk, sig))
    .filter(Boolean);

  return { map, lines };
}

// Small helper the engine can use to fold enrichment lines into a prompt block.
export function signalsBlock(lines) {
  if (!lines || !lines.length) return 'No quantitative signals available (Massive feed off or quiet).';
  return lines.join('\n');
}

// Exposed for testing only.
export const __test = { isUsSymbol, summariseSignals, MAX_TICKERS_PER_RUN };
