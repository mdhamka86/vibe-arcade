// api/terminal-screen.js
// THE OVERNIGHT SCREEN — The Terminal's own candidate universe, ranked.
//
// THE PROBLEM THIS EXISTS TO SOLVE
// actIdeas() named 19 pairs in a sentence and asked one model call to pick 2. There was no
// funnel: no screening, no ranking, no per-candidate measurement. It could not have one, either,
// because it runs synchronously inside a user-facing request — there is nowhere to put the work.
// So the "trawl the whole board" instruction was aspiration, and the model's attention went
// where the evidence was thickest, which was the 8 majors that got pattern feeds.
//
// This runs on a cron with a 300s budget and nobody waiting. It measures all 25 tradeable pairs
// on identical, deterministic factors, ranks them, and writes the board to Redis. actIdeas then
// reads a ranked shortlist WITH evidence instead of free-associating from a list of names.
//
// NO MODEL IS CALLED HERE. Every number is computed in code — the discipline forex-brain states
// as "the model never trawls; code never reasons", which is the right split and which The
// Terminal did not have. That also means a run costs nothing but Yahoo requests, so it can be
// re-run freely.
//
// SHARE, DON'T COUPLE. computeBox/computeAtr are imported from forex-brain because they are pure,
// exported and already unit-tested — reusing them is free. This module reads NONE of forex-brain's
// Redis state: `forex:*` belongs to a Phase-1 paper system heading toward auto-execution, and its
// 90-minute breakout verdicts answer a different question on a different horizon than a 2-3 day
// interday hold. Sharing code is safe; sharing state would couple this to a moving target.

import { computeBox, computeAtr } from './forex-brain.js';
import { SCREEN_PAIRS, getUniverseCandles, aggregate, pipSizeFor, normPair } from './fx-candles.js';
import { getCalendar, currencyExposure, screenAge } from './terminal-engine.js';

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function rGet(key) {
  const r = await fetch(`${R_URL}/get/${key}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
  if (!r.ok) throw new Error(`Storage read failed (${r.status}) for ${key}`);
  const j = await r.json();
  if (j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}
async function rSet(key, val) {
  const r = await fetch(`${R_URL}/set/${key}`, {
    method: 'POST', headers: { Authorization: `Bearer ${R_TOK}` }, body: JSON.stringify(val),
  });
  if (!r.ok) throw new Error(`Storage write failed (${r.status}) for ${key}`);
  return true;
}

// ---------- Doctrine constants ----------
// These mirror terminal-engine's HORIZON. The screen scores pairs for a 2-3 day interday hold,
// so its lookbacks and its catalyst window are the hold window's, not a scalper's.
export const SCREEN_CONFIG = {
  holdCeilingHours: 96,   // must match HORIZON.ceilingHours in terminal-engine.js
  atrPeriod: 14,
  rangeDays: 20,          // the box the pair is currently sitting inside
  trendFast: 5,
  trendSlow: 20,
  volFast: 5,             // recent energy...
  volSlow: 30,            // ...against the pair's own baseline
  freshnessDays: 3,       // proposed this recently => stale as a "fresh" idea
  minBarsD1: 34,          // volSlow + atrPeriod headroom; below this the pair is unscoreable
  // Weights sum to 100 on the positive side. bookFit is signed (-15..+15) because reducing the
  // book's existing risk is a genuine reason to prefer a pair, not merely the absence of a
  // reason to avoid it.
  weights: { movement: 25, structure: 20, trend: 15, catalyst: 25, bookFit: 15, staleness: -10 },
};

const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ---------- Per-pair factors (all deterministic) ----------

// Simple moving average over COMPLETED bars. Index 0 is the in-progress bar and is skipped, the
// same convention computeBox/computeAtr use — mixing the two would make the trend read compare a
// partial bar against complete ones.
export function smaCompleted(candles, n) {
  if (!Array.isArray(candles) || candles.length < n + 1) return null;
  const closes = [];
  for (let i = 1; i <= n; i++) closes.push(parseFloat(candles[i].close));
  if (closes.some((c) => !Number.isFinite(c))) return null;
  return mean(closes);
}

// Where price sits inside its recent range: 0 = at the low, 1 = at the high.
export function rangePosition(last, box) {
  if (!box || !Number.isFinite(last) || !(box.size > 0)) return null;
  return clamp01((last - box.low) / box.size);
}

// Is this pair moving unusually FOR ITSELF? A raw ATR says GBPJPY moves more than EURGBP, which
// is true and useless. The ratio of recent energy to the pair's own baseline says whether
// something is actually happening in it right now, and that comparison is scale-free.
export function volRatio(candles, fast, slow) {
  const a = computeAtr(candles, fast);
  const b = computeAtr(candles, slow);
  if (!a || !b || b <= 0) return null;
  return a / b;
}

// Catalyst load for a pair over the hold window: what is scheduled that can move either leg.
export function catalystLoad(cal, pair, ceilingHours, nowMs = Date.now()) {
  const p = normPair(pair);
  const legs = [p.slice(0, 3), p.slice(3, 6)];
  const horizon = nowMs + ceilingHours * 3600e3;
  const mine = (cal || []).filter((e) => legs.includes(e.ccy) && Number.isFinite(e.utc) && e.utc >= nowMs && e.utc <= horizon);
  const high = mine.filter((e) => /high/i.test(e.impact || '')).length;
  const medium = mine.filter((e) => /medium/i.test(e.impact || '')).length;
  const next = mine.sort((a, b) => a.utc - b.utc)[0] || null;
  return {
    high, medium,
    next: next ? { title: next.title, ccy: next.ccy, when: next.when, impact: next.impact, hoursOut: +((next.utc - nowMs) / 3600e3).toFixed(1) } : null,
  };
}

// How a pair in a given direction sits against the book's existing currency posture.
// Positive net = it REDUCES the book's concentration; negative = it doubles down.
export function bookFit(pair, dir, exp) {
  const p = normPair(pair);
  if (p.length < 6) return { stack: 0, offset: 0, net: 0, detail: [] };
  const s = dir === 'BUY' ? 1 : -1;
  const legs = [[p.slice(0, 3), s], [p.slice(3, 6), -s]];
  let stack = 0, offset = 0; const detail = [];
  for (const [ccy, sign] of legs) {
    const e = (exp || {})[ccy] || 0;
    if (Math.abs(e) < 0.01) continue; // float residue, not a position
    if (Math.sign(e) === sign) { stack += Math.abs(e); detail.push(`stacks ${sign > 0 ? 'long' : 'short'} ${ccy} ${Math.abs(e).toFixed(2)}`); }
    else { offset += Math.abs(e); detail.push(`offsets ${sign > 0 ? 'short' : 'long'} ${ccy} ${Math.abs(e).toFixed(2)}`); }
  }
  return { stack: +stack.toFixed(2), offset: +offset.toFixed(2), net: +(offset - stack).toFixed(2), detail };
}

// Score one pair. Returns the full factor set alongside the score, because a ranking you cannot
// interrogate is just an opinion with a number on it — and this board is shown to the user.
export function scorePair({ pair, d1, h1, cal, exposure, recentlyProposed, nowMs = Date.now() }) {
  const W = SCREEN_CONFIG.weights;
  if (!Array.isArray(d1) || d1.length < SCREEN_CONFIG.minBarsD1) {
    return { pair: normPair(pair), score: null, unscoreable: `only ${(d1 || []).length} daily bars available, need ${SCREEN_CONFIG.minBarsD1}` };
  }
  const last = parseFloat(d1[0].close);
  const pip = pipSizeFor(pair, last);
  const atrD1 = computeAtr(d1, SCREEN_CONFIG.atrPeriod);
  const box = computeBox(d1, SCREEN_CONFIG.rangeDays);
  const rPos = rangePosition(last, box);
  const smaFast = smaCompleted(d1, SCREEN_CONFIG.trendFast);
  const smaSlow = smaCompleted(d1, SCREEN_CONFIG.trendSlow);
  const vr = volRatio(d1, SCREEN_CONFIG.volFast, SCREEN_CONFIG.volSlow);
  const h4 = h1 && h1.length >= 4 ? aggregate(h1, 4) : null;
  const atrH4 = h4 && h4.length >= SCREEN_CONFIG.atrPeriod + 2 ? computeAtr(h4, SCREEN_CONFIG.atrPeriod) : null;
  const cats = catalystLoad(cal, pair, SCREEN_CONFIG.holdCeilingHours, nowMs);

  // --- components, each normalised to 0..1 before weighting ---
  // movement: ratio 0.7 (quiet) -> 0, 1.5 (hot) -> 1
  const movement = vr == null ? 0 : clamp01((vr - 0.7) / 0.8);
  // structure: distance from the middle of the 20-day range. Mid-range is nowhere; the edges are
  // where a 2-3 day trade has something to push against or break out of.
  const structure = rPos == null ? 0 : clamp01(Math.abs(rPos - 0.5) * 2);
  // trend: separation of the fast and slow averages, measured in ATRs so it is comparable across
  // pairs. 1 ATR of separation is a decisive trend.
  const trendSep = (smaFast != null && smaSlow != null && atrD1) ? (smaFast - smaSlow) / atrD1 : null;
  const trend = trendSep == null ? 0 : clamp01(Math.abs(trendSep));
  // catalyst: a High print is worth 1, a Medium 0.4; two Highs saturates.
  const catalyst = clamp01((cats.high * 1 + cats.medium * 0.4) / 2);
  // bookFit — scored for the direction that is actually TRADEABLE, not the flattering one.
  //
  // The first version of this took whichever direction fitted the book better, which produced a
  // straight contradiction on live data: EURNZD sat in a 2.8-ATR downtrend and the board said
  // "prefer BUY", purely because buying it happened to offset a small short-EUR position. A
  // screen that recommends the wrong side of a strong trend because the arithmetic is friendlier
  // is worse than no screen. GBPJPY showed the mirror error — credited +9 for a SELL that fights
  // a 1.7-ATR uptrend, while the BUY anyone would actually take stacks his existing short JPY.
  //
  // So: when there is a real trend, the direction is the TREND's and book-fit is scored for that
  // direction, bonus or penalty as it falls. Only when the pair has no clear trend — a range edge
  // that could break either way — is the desk free to pick the side that suits the book.
  const TREND_DECISIVE = 0.5; // ATRs of fast/slow separation
  const fitBuy = bookFit(pair, 'BUY', exposure);
  const fitSell = bookFit(pair, 'SELL', exposure);
  const trendDir = trendSep == null ? null : trendSep > 0 ? 'BUY' : 'SELL';
  const trendDecisive = trendSep != null && Math.abs(trendSep) >= TREND_DECISIVE;
  const direction = trendDecisive ? trendDir : (fitBuy.net >= fitSell.net ? 'BUY' : 'SELL');
  const fit = direction === 'BUY' ? fitBuy : fitSell;
  const fitSigned = clamp01((fit.net + 0.1) / 0.2) * 2 - 1; // -1..+1

  const parts = {
    movement: +(W.movement * movement).toFixed(1),
    structure: +(W.structure * structure).toFixed(1),
    trend: +(W.trend * trend).toFixed(1),
    catalyst: +(W.catalyst * catalyst).toFixed(1),
    bookFit: +(W.bookFit * fitSigned).toFixed(1),
    staleness: recentlyProposed ? W.staleness : 0,
  };
  const score = +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(1);

  // A plain-language reason, built from whichever components actually carried the score. This is
  // shown on the board; "78" on its own is not an answer to "did you look everywhere".
  const why = [];
  if (movement > 0.6) why.push(`moving hot (${vr.toFixed(2)}x its own baseline)`);
  else if (movement < 0.25) why.push('unusually quiet');
  if (structure > 0.6) why.push(`at the ${rPos > 0.5 ? 'top' : 'bottom'} of its ${SCREEN_CONFIG.rangeDays}d range`);
  if (trend > 0.5) why.push(`clear ${trendSep > 0 ? 'up' : 'down'}trend (${Math.abs(trendSep).toFixed(1)} ATR separation)`);
  if (cats.high) why.push(`${cats.high} High-impact event${cats.high > 1 ? 's' : ''} in the window`);
  why.push(trendDecisive
    ? `direction ${direction} set by the trend`
    : `no decisive trend, so ${direction} chosen on book-fit`);
  if (fit.net > 0.02) why.push(`${direction} offsets book risk (${fit.detail.join('; ')})`);
  else if (fit.net < -0.02) why.push(`${direction} ADDS to existing exposure (${fit.detail.join('; ')})`);
  if (recentlyProposed) why.push(`proposed within the last ${SCREEN_CONFIG.freshnessDays} days`);

  return {
    pair: normPair(pair), score, parts,
    // The direction the board is actually pointing at, and WHY it was chosen — so a reader can
    // tell "the trend says this" from "nothing is trending, so we picked the tidier side".
    preferredDirection: direction,
    directionBasis: trendDecisive ? 'TREND' : 'BOOK_FIT',
    factors: {
      last: +last.toFixed(5),
      atrD1: atrD1 != null ? +atrD1.toFixed(6) : null,
      atrD1Pips: atrD1 != null ? Math.round(atrD1 / pip) : null,
      atrH4Pips: atrH4 != null ? Math.round(atrH4 / pip) : null,
      range20: box ? { high: box.high, low: box.low } : null,
      rangePos: rPos != null ? +rPos.toFixed(2) : null,
      volRatio: vr != null ? +vr.toFixed(2) : null,
      trendSeparationAtr: trendSep != null ? +trendSep.toFixed(2) : null,
      catalysts: cats,
      bookFit: { scoredFor: direction, basis: trendDecisive ? 'TREND' : 'BOOK_FIT', buy: fitBuy, sell: fitSell },
      recentlyProposed: !!recentlyProposed,
    },
    why: why.join(' · ') || 'nothing distinctive; ranked on baseline factors',
  };
}

// ---------- The run ----------
export async function runScreen(nowMs = Date.now()) {
  const started = Date.now();
  const [book, ledger, cal] = await Promise.all([
    rGet('terminal:book').catch(() => null),
    rGet('terminal:ledger').catch(() => []),
    getCalendar().catch(() => []),
  ]);
  const exposure = currencyExposure((book && book.positions) || []);
  const openPairs = new Set(((book && book.positions) || []).map((p) => normPair(p.pair)));
  const freshCutoff = nowMs - SCREEN_CONFIG.freshnessDays * 86400e3;
  const recent = new Set(((ledger) || [])
    .filter((r) => r.idea && r.ts > freshCutoff)
    .map((r) => normPair(r.idea.pair)));

  // Two passes over the universe: daily is required, hourly is best-effort. A pair with no H1
  // data still scores — it just carries a null H4 ATR, stated rather than silently zeroed.
  const d1 = await getUniverseCandles(SCREEN_PAIRS, '1d', 6);
  const h1 = await getUniverseCandles(SCREEN_PAIRS, '1h', 6).catch(() => ({ candles: {}, health: [] }));

  const rows = [];
  for (const pair of SCREEN_PAIRS) {
    const p = normPair(pair);
    const dPack = d1.candles[p];
    if (!dPack) { rows.push({ pair: p, score: null, unscoreable: 'no daily candles this run' }); continue; }
    const row = scorePair({
      pair: p,
      d1: dPack.candles,
      h1: h1.candles[p] ? h1.candles[p].candles : null,
      cal, exposure,
      recentlyProposed: recent.has(p),
      nowMs,
    });
    // A pair already open is not a fresh idea — the gate blocks it anyway, so it is marked here
    // rather than ranked into a shortlist it can never be picked from.
    if (openPairs.has(p)) { row.alreadyOpen = true; row.score = row.score == null ? null : row.score - 100; row.why = `ALREADY OPEN in the book — not a fresh idea. ${row.why}`; }
    if (dPack.stale) row.priceDataStale = true;
    rows.push(row);
  }

  const ranked = rows.filter((r) => r.score != null).sort((a, b) => b.score - a.score);
  const unscoreable = rows.filter((r) => r.score == null);
  const pack = {
    at: new Date(nowMs).toISOString(),
    tookMs: Date.now() - started,
    universeSize: SCREEN_PAIRS.length,
    scored: ranked.length,
    ranked,
    unscoreable,
    exposureAtScreen: exposure,
    health: { d1: d1.health, h1: h1.health },
    config: { weights: SCREEN_CONFIG.weights, holdCeilingHours: SCREEN_CONFIG.holdCeilingHours },
  };
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  pack.dateKey = dateKey;
  // `terminal:screen` is the latest-pointer actIdeas reads; the dated key is the archive, so a
  // board can be looked back at when reviewing why an idea was or wasn't proposed.
  await rSet('terminal:screen', pack);
  await rSet(`terminal:screen:${dateKey}`, pack).catch(() => {});
  return pack;
}

// ---------- Handler ----------
// NOTE ON DEPENDENCY DIRECTION: this module imports from terminal-engine, and terminal-engine
// imports NOTHING from here — its only knowledge of the screen is a Redis key and a timestamp.
// That is deliberate and one-directional. A cycle between two ESM handlers resolves at
// module-init in an order neither file states, which is how you get an undefined binding that
// only shows up in production. It is also the same loose coupling argued for against reading
// forex-brain's state: the consumer should not be welded to the producer.
// The staleness contract therefore lives in terminal-engine (the consumer decides what is too
// old for its purposes) and is imported here for the handler's benefit.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const q = req.query || {};
    const isCron = !!req.headers['x-vercel-cron'];
    const action = q.action || (isCron ? 'run' : 'get');

    if (action === 'run') {
      const pack = await runScreen();
      return res.status(200).json({
        ok: true, at: pack.at, tookMs: pack.tookMs, scored: pack.scored, universeSize: pack.universeSize,
        top: pack.ranked.slice(0, 8).map((r) => ({ pair: r.pair, score: r.score, dir: r.preferredDirection, why: r.why })),
        unscoreable: pack.unscoreable,
      });
    }
    if (action === 'get') {
      const pack = await rGet('terminal:screen');
      return res.status(200).json({ ok: true, age: screenAge(pack), screen: pack });
    }
    if (action === 'archive') {
      const pack = await rGet(`terminal:screen:${q.date}`);
      return res.status(200).json({ ok: true, screen: pack });
    }
    return res.status(400).json({ ok: false, error: `unknown action ${action}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

// Fan-out of ~50 Yahoo requests plus the calendar, all network-bound. Same budget as forex-brain,
// declared here next to the code it bounds per the lesson in stewards.js:2245.
export const config = { maxDuration: 300 };
