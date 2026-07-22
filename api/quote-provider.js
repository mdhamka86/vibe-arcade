// api/quote-provider.js
// THE EXCHANGE — the one place that knows where a price comes from.
//
// WHY (22/07/2026). The desk used to call Finnhub for everything. Finnhub's free tier
// quotes US symbols only — non-US is an Enterprise contract, not a paid checkbox — so
// every SGX/TSE/HKEX name came back either empty or, worse, as a DIFFERENT US company
// that the old sanitiser had manufactured out of the Asian code. The desk then quoted
// Sony at 2820 when Tokyo had it at 3425.
//
// ROUTING: US -> Finnhub (licensed, real-time, already paid for and working).
//          Everything else -> a delayed-quote provider, currently Yahoo.
//
// ON YAHOO, HONESTLY. query1/query2 `v7/finance/spark` is undocumented and Yahoo's
// robots.txt disallows all automated access. It was verified working from this project's
// actual Vercel region (syd1) on 22/07/2026 — 200s for TSE/SGX/HKEX/Bursa/Shanghai/US,
// with and without a UA header, no throttling across a burst. The realistic risk is that
// it BREAKS, not that anyone sues a personal dashboard: Yahoo enforces technically, and
// it has already killed v6/quote and v7/quote this way.
//
// THAT is why this file exists as an adapter with ONE provider object. When Yahoo breaks,
// swapping to EODHD (~$19.99/mo, licensed, 15-20min delayed, same three exchanges) is a
// change to ASIA_PROVIDER and nothing else. Callers never learn which source answered.
//
// EVERY failure path returns null rather than a number. A missing price is handled
// safely upstream (checkLevels hard-blocks it); a wrong price is the bug we are fixing.

import { classifyTicker, MARKETS } from './market-classifier.js';

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY || '';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Published delay per venue, used for the "SGX · 10min delayed" label. Measured from
// Vercel on 22/07/2026 and consistent with each exchange's free-display tier.
const DELAY_MINS = { SGX: 10, TSE: 15, HKEX: 15, BURSA: 15, CHINA: 15, US: 0 };

async function withTimeout(url, ms, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- US: Finnhub ----------
async function finnhubQuote(symbol) {
  if (!FINNHUB_KEY) return null;
  try {
    const r = await withTimeout(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`,
      8000, { Accept: 'application/json' },
    );
    if (!r.ok) return null;
    const j = await r.json();
    // c = current price. 0 means the symbol was not recognised on this plan.
    const c = typeof j.c === 'number' ? j.c : null;
    if (!c || c <= 0) return null;
    return { price: +c.toFixed(4), currency: 'USD', asOf: j.t ? j.t * 1000 : Date.now(), source: 'finnhub' };
  } catch {
    return null;
  }
}

// ---------- Non-US: Yahoo delayed spark (batched) ----------
// One request for every symbol, which matters: per-symbol fetching from a datacenter IP
// is what actually triggers throttling. query1 with a query2 fallback.
const ASIA_PROVIDER = {
  name: 'yahoo-spark',
  async fetchMany(yahooSymbols) {
    if (!yahooSymbols.length) return {};
    const qs = `symbols=${encodeURIComponent(yahooSymbols.join(','))}&range=1d&interval=1d`;
    for (const host of ['query1', 'query2']) {
      try {
        const r = await withTimeout(
          `https://${host}.finance.yahoo.com/v7/finance/spark?${qs}`,
          10000, { Accept: 'application/json', 'User-Agent': UA },
        );
        if (!r.ok) continue;
        const j = await r.json();
        const results = j?.spark?.result;
        if (!Array.isArray(results)) continue;
        const out = {};
        for (const row of results) {
          const meta = row?.response?.[0]?.meta;
          const px = meta?.regularMarketPrice;
          if (!meta || typeof px !== 'number' || !(px > 0)) continue;
          out[String(meta.symbol).toUpperCase()] = {
            price: +px.toFixed(4),
            currency: meta.currency || null,
            // regularMarketTime is the exchange's own stamp for the last trade. Trusting
            // it rather than wall-clock means a stale feed is VISIBLE instead of silent.
            asOf: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
            source: `yahoo:${host}`,
          };
        }
        if (Object.keys(out).length) return out;
      } catch { /* try the next host */ }
    }
    return {};
  },
};

// ---------- Public: quotes ----------
// items: array of tickers, or of {ticker, exchange} objects.
// Returns a map keyed by the ORIGINAL uppercased ticker, so callers look up what they
// asked for and never have to know about Yahoo suffixes.
export async function getQuotes(items) {
  const reqs = [];
  const seen = new Set();
  for (const it of items || []) {
    const ticker = typeof it === 'string' ? it : (it && (it.ticker || it.name));
    const hint = typeof it === 'string' ? null : (it && it.exchange);
    if (!ticker) continue;
    const key = String(ticker).toUpperCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    reqs.push({ key, cls: classifyTicker(ticker, hint) });
  }
  if (!reqs.length) return {};

  const out = {};
  // Unclassifiable names get an explicit record rather than silent absence, so the
  // engine can explain WHY it has no price instead of just lacking one.
  for (const r of reqs) {
    if (!r.cls.ok) out[r.key] = { price: null, unpriced: true, reason: r.cls.reason, market: null };
  }

  const usReqs = reqs.filter((r) => r.cls.ok && r.cls.isUS);
  const asiaReqs = reqs.filter((r) => r.cls.ok && !r.cls.isUS);

  const [usResults, asiaMap] = await Promise.all([
    Promise.all(usReqs.map(async (r) => [r, await finnhubQuote(r.cls.yahooSymbol)])),
    ASIA_PROVIDER.fetchMany(asiaReqs.map((r) => r.cls.yahooSymbol)),
  ]);

  for (const [r, q] of usResults) out[r.key] = shape(r, q);
  for (const r of asiaReqs) out[r.key] = shape(r, asiaMap[r.cls.yahooSymbol.toUpperCase()] || null);
  return out;
}

function shape(r, q) {
  const market = r.cls.market;
  if (!q) {
    return {
      price: null, unpriced: true, market, currency: r.cls.currency,
      yahooSymbol: r.cls.yahooSymbol,
      reason: `no quote returned for ${r.cls.yahooSymbol}`,
    };
  }
  const declaredDelay = DELAY_MINS[market] ?? null;
  const ageMins = q.asOf ? Math.max(0, Math.round((Date.now() - q.asOf) / 60000)) : null;
  return {
    price: q.price,
    unpriced: false,
    market,
    label: MARKETS[market]?.label || market,
    // The feed's own currency wins over our table when present — it is authoritative
    // and catches a name that trades in a currency we did not expect.
    currency: q.currency || r.cls.currency,
    yahooSymbol: r.cls.yahooSymbol,
    asOf: q.asOf,
    ageMins,
    delayMins: declaredDelay,
    delayLabel: declaredDelay ? `${MARKETS[market]?.label || market} · ${declaredDelay}min delayed` : `${MARKETS[market]?.label || market} · real-time`,
    source: q.source,
  };
}

// ---------- Public: FX ----------
// Verified 22/07/2026: the same Yahoo spark endpoint quotes FX pairs, so currency
// conversion needs no second provider and no second failure mode.
//
// WHY THIS MATTERS. Nothing in the desk handled currency: every price was formatted
// "$x" and sized against a USD buying power. Sony at JPY 3425 was being weighed against
// dollars — a ~150x sizing error, and the kind that reads as plausible on a card.
const FX_TTL_MS = 10 * 60 * 1000;
let fxCache = { at: 0, rates: {} };

export async function getFxToUsd(currencies) {
  const want = [...new Set((currencies || []).filter(Boolean).map((c) => String(c).toUpperCase()))]
    .filter((c) => c !== 'USD');
  const rates = { USD: 1 };
  if (!want.length) return rates;
  if (Date.now() - fxCache.at < FX_TTL_MS) {
    const hit = want.every((c) => fxCache.rates[c] != null);
    if (hit) { for (const c of want) rates[c] = fxCache.rates[c]; return rates; }
  }
  const symbols = want.map((c) => `${c}USD=X`);
  const map = await ASIA_PROVIDER.fetchMany(symbols);
  for (const c of want) {
    const q = map[`${c}USD=X`];
    if (q && q.price > 0) rates[c] = q.price;
  }
  fxCache = { at: Date.now(), rates: { ...fxCache.rates, ...rates } };
  return rates;
}

// Convert to USD. Returns null when the rate is unknown — callers must treat that as
// "cannot size this", never as 1:1. A silent 1:1 fallback would reintroduce exactly the
// JPY-as-USD error this module was added to remove.
export function toUsd(amount, currency, rates) {
  const a = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!isFinite(a)) return null;
  const c = String(currency || 'USD').toUpperCase();
  if (c === 'USD') return a;
  const r = rates && rates[c];
  return r > 0 ? a * r : null;
}

export const __providerName = ASIA_PROVIDER.name;
