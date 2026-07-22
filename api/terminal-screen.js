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

import { computeBox, computeAtr, validateVerdict, settleVerdict } from './forex-brain.js';
import { SCREEN_PAIRS, getUniverseCandles, getCandles, aggregate, pipSizeFor, normPair } from './fx-candles.js';
import { getCalendar, currencyExposure, exposureLine, screenAge } from './terminal-engine.js';
import { getNews } from './terminal-news.js';

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

// ============================ TWO-STAGE LLM SCORING ============================
// The deterministic factors above measure a pair. They cannot JUDGE one — they cannot weigh a
// 2.8-ATR downtrend against an RBNZ decision landing inside the window, or notice that the trend
// and the news are pointing opposite ways. That judgement used to happen exactly once, in a
// single call that skimmed 8 shortlisted pairs at once and picked 2. Every pair got a fraction
// of one call's attention, and the 17 pairs outside the shortlist got none at all.
//
// Now:
//   STAGE 1  one Sonnet call PER PAIR, reasoning about that pair alone with its full evidence.
//   STAGE 2  one consolidation call that reads every Stage-1 verdict and compares the field.
//
// The shape is forex-brain's per-pair loop (forex-brain.js:374), which has been running this
// pattern affordably on four crons a day. It belongs on a cron with nobody waiting, which is
// exactly where this is.
//
// THE REAL RISK IS NOT COST, IT IS PARTIAL FAILURE. Twenty-odd network calls will not all
// succeed forever. One pair timing out must never tank a run — and a pair that failed must never
// be quietly indistinguishable from a pair that scored badly. Every failure is isolated, named,
// and shown.
const MODEL = 'claude-sonnet-4-6';

// Per-call ceiling. A pair that hangs must not eat the cron budget the other 24 need.
const PAIR_CALL_TIMEOUT_MS = 45000;
const STAGE2_CALL_TIMEOUT_MS = 90000;
// Wall-clock guard. Vercel kills the function at 300s with no chance to write anything, which
// would lose a run that had already scored 20 pairs. We stop cleanly well before that and ship
// what we have, marking the rest unscored.
const RUN_BUDGET_MS = 235000;
const PAIR_CONCURRENCY = 5;

async function claudeJSON(prompt, maxTokens, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'anthropic error');
    if (j.stop_reason === 'max_tokens') throw new Error('response truncated at the token limit');
    const text = (j.content || []).map((c) => c.text || '').join('\n').replace(/```json|```/g, '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON object in the response');
    return JSON.parse(m[0]);
  } finally { clearTimeout(timer); }
}

// News relevant to ONE pair. The full wire is 60 items; handing all of it to 25 separate calls
// would be wasteful and would bury the two articles that actually bear on the pair in front of
// it. Same currency-term matching the engine's convergence gate uses.
const CCY_TERMS = {
  EUR: ['eur', 'euro', 'ecb', 'lagarde', 'eurozone'], USD: ['usd', 'dollar', 'fed', 'fomc', 'powell'],
  GBP: ['gbp', 'pound', 'sterling', 'boe', 'bailey'], JPY: ['jpy', 'yen', 'boj', 'ueda', 'japan'],
  CHF: ['chf', 'franc', 'snb', 'swiss'], AUD: ['aud', 'aussie', 'rba', 'australia'],
  NZD: ['nzd', 'kiwi', 'rbnz', 'zealand'], CAD: ['cad', 'loonie', 'boc', 'canada'],
};
export function newsForPair(news, pair, limit = 6) {
  const p = normPair(pair);
  const a = p.slice(0, 3), b = p.slice(3, 6);
  const scored = [];
  for (const n of news || []) {
    const hay = ((n.title || '') + ' ' + (n.desc || '')).toLowerCase();
    const namesPair = hay.includes(p.toLowerCase()) || hay.includes(`${a}/${b}`.toLowerCase());
    const aHit = (CCY_TERMS[a] || []).some((t) => hay.includes(t));
    const bHit = (CCY_TERMS[b] || []).some((t) => hay.includes(t));
    if (!namesPair && !aHit && !bHit) continue;
    scored.push({ n, rank: namesPair ? 3 : (aHit && bHit) ? 2 : 1 });
  }
  return scored.sort((x, y) => y.rank - x.rank || (y.n.ts || 0) - (x.n.ts || 0)).slice(0, limit).map((x) => x.n);
}

// ---------- STAGE 1: one call per pair ----------
export function buildPairPrompt(row, ctx) {
  const f = row.factors || {};
  const c = f.catalysts || {};
  const news = newsForPair(ctx.news, row.pair, 6);
  const evStr = (c.high || c.medium)
    ? `${c.high} High-impact and ${c.medium} Medium-impact events for this pair's currencies inside the ${SCREEN_CONFIG.holdCeilingHours}h hold window.${c.next ? ` Next: ${c.next.ccy} ${c.next.title}, ${c.next.when}, in ${c.next.hoursOut}h [${c.next.impact}].` : ''}`
    : 'No scheduled High/Medium events for either currency inside the hold window.';
  return `You are a forex analyst on THE TERMINAL, a retail desk in Phuket (Phillip Nova MT5). Assess ONE pair for a ${SCREEN_CONFIG.holdCeilingHours / 24}-day-ceiling INTERDAY trade — opened now, intended to work over 2-3 days. Not a scalp, not a multi-week position.

PAIR: ${row.pair}

MEASURED EVIDENCE (computed in code from real price history — trust these numbers, do not re-estimate them):
- Spot ${f.last}
- Daily ATR ${f.atrD1Pips} pips${f.atrH4Pips != null ? `, H4 ATR ${f.atrH4Pips} pips` : ''}
- 20-day range ${f.range20 ? `${f.range20.low} to ${f.range20.high}` : 'n/a'}; price sits at ${f.rangePos != null ? (f.rangePos * 100).toFixed(0) + '% of that range (0% = the low, 100% = the high)' : 'n/a'}
- Recent energy ${f.volRatio}x the pair's own 30-day baseline (1.0 = normal for this pair; above 1.3 = unusually active; below 0.8 = unusually quiet)
- Trend: fast/slow moving averages separated by ${f.trendSeparationAtr} ATR (positive = up, negative = down; beyond ±0.5 is a decisive trend)

CALENDAR: ${evStr}

THE BOOK'S EXISTING CURRENCY EXPOSURE: ${ctx.exposureLine}
- Taking ${row.pair} long is a bet on ${row.pair.slice(0, 3)} and against ${row.pair.slice(3, 6)}; short is the reverse.
- BUY here would ${f.bookFit && f.bookFit.buy.net >= 0 ? 'REDUCE' : 'ADD TO'} existing concentration (${(f.bookFit && f.bookFit.buy.detail.join('; ')) || 'no overlap'}).
- SELL here would ${f.bookFit && f.bookFit.sell.net >= 0 ? 'REDUCE' : 'ADD TO'} existing concentration (${(f.bookFit && f.bookFit.sell.detail.join('; ')) || 'no overlap'}).

${news.length ? `NEWS TOUCHING THIS PAIR (freshest first):\n${news.map((n) => `- [${n.source}] ${n.title}${n.desc ? `\n    ${String(n.desc).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n')}` : 'NEWS: nothing on the wire specifically touching this pair right now. That is itself information — a pair with no story needs the technicals to be doing the work.'}

TASK: judge THIS pair on its own merits. Do not compare it to other pairs; you are seeing only this one, and something else will weigh the field.

Score 0-100 for how good a 2-3 day trade this pair offers RIGHT NOW:
  0-25   nothing here; no edge, or the evidence conflicts
  26-50  marginal; a trade exists but the case is thin
  51-70  a real setup with a coherent story
  71-85  strong: technicals and catalyst and news agree
  86-100 exceptional; reserve for genuine convergence, rare

Be honest and be willing to score low. Most pairs on most nights are not opportunities, and a field of inflated scores is worth nothing to the desk. If the technicals and the news point opposite ways, say so and score it down.

If you see a trade, give indicative levels anchored to the spot above and sized to the daily ATR — a 2-3 day stop is typically 1.5-2.5x the DAILY ATR, because the position must survive several sessions of noise. If you do not see a trade, set direction STAND_ASIDE and levels null.

JSON only, no markdown:
{"score":0-100,"direction":"BUY|SELL|STAND_ASIDE","conviction":"LOW|MED|MED-HIGH|HIGH","read":"your reasoning in 30-45 words: what the setup IS, and what the evidence actually says","key_risk":"the single thing most likely to break it, max 15 words","catalyst_dependency":"does this thesis depend on a scheduled event? name it, or say 'flow/technical, no event dependency', max 15 words","entry":number or null,"tp":number or null,"sl":number or null}`;
}

// Score one pair. NEVER throws: a failure is a value, so the caller's loop cannot be broken by it.
export async function scorePairLLM(row, ctx) {
  try {
    const out = await claudeJSON(buildPairPrompt(row, ctx), 700, PAIR_CALL_TIMEOUT_MS);
    const score = Number(out.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`score ${out.score} out of range`);
    const dir = String(out.direction || '').toUpperCase();
    if (!['BUY', 'SELL', 'STAND_ASIDE'].includes(dir)) throw new Error(`direction "${out.direction}" invalid`);
    const read = String(out.read || '').trim();
    if (read.length < 10) throw new Error('read too short to be a judgement');
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      ok: true,
      llm: {
        score: Math.round(score), direction: dir,
        conviction: ['LOW', 'MED', 'MED-HIGH', 'HIGH'].includes(String(out.conviction || '').toUpperCase()) ? String(out.conviction).toUpperCase() : 'LOW',
        read, keyRisk: String(out.key_risk || '').slice(0, 140) || null,
        catalystDependency: String(out.catalyst_dependency || '').slice(0, 140) || null,
        entry: n(out.entry), tp: n(out.tp), sl: n(out.sl),
      },
    };
  } catch (e) {
    // Isolated. The pair is marked unscored with the real reason and the run continues.
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}

// Run Stage 1 across the field with bounded concurrency and a wall-clock guard.
export async function runStage1(rows, ctx, { concurrency = PAIR_CONCURRENCY, deadline = Infinity, scorer = scorePairLLM } = {}) {
  const queue = [...rows];
  const scored = [], unscored = [];
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const row = queue[idx++];
      if (Date.now() > deadline) {
        unscored.push({ ...row, unscored: 'the cron budget ran out before this pair was reached' });
        continue;
      }
      const r = await scorer(row, ctx);
      if (r.ok) scored.push({ ...row, llm: r.llm });
      else unscored.push({ ...row, unscored: r.error });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return { scored, unscored };
}

// ---------- STAGE 2: one consolidation call over the whole field ----------
export function buildConsolidationPrompt(scored, ctx) {
  const field = [...scored].sort((a, b) => b.llm.score - a.llm.score).slice(0, 14).map((r, i) =>
    `${i + 1}. ${r.pair} — LLM score ${r.llm.score}, ${r.llm.direction}${r.llm.direction !== 'STAND_ASIDE' ? ` (${r.llm.conviction})` : ''}
     read: ${r.llm.read}
     risk: ${r.llm.keyRisk || 'n/a'} | catalyst: ${r.llm.catalystDependency || 'n/a'}
     measured: ATR ${r.factors.atrD1Pips}p/day, range pos ${r.factors.rangePos}, energy ${r.factors.volRatio}x, trend ${r.factors.trendSeparationAtr} ATR${r.llm.entry != null ? ` | indicative ${r.llm.entry} / TP ${r.llm.tp} / SL ${r.llm.sl}` : ''}`
  ).join('\n');
  return `You are the head of THE TERMINAL, a retail forex desk in Phuket. Each pair below was analysed INDEPENDENTLY by a separate analyst who saw only that pair. Your job is the one thing none of them could do: compare the field and decide where the desk's limited margin should go.

Trades are INTERDAY, 2-3 days, ${SCREEN_CONFIG.holdCeilingHours / 24}-day ceiling. Account is small; capital preservation beats bravado.

THE BOOK'S CURRENT CURRENCY EXPOSURE: ${ctx.exposureLine}
Pairs already open are excluded from the field below.

THE FIELD (${scored.length} pairs scored independently${ctx.unscoredCount ? `; ${ctx.unscoredCount} could not be scored this run` : ''}):
${field}

TASK: pick the best TWO candidates for the desk, and explain the field.

Judge across pairs, which the individual analysts could not:
- A 70 that duplicates the book's existing currency risk may well be worse than a 60 that diversifies it. Read the exposure line and mean it.
- Two picks that are effectively the same bet (both long the dollar, both short yen) are ONE bet at double size. Prefer genuine independence between your two.
- An analyst who saw only one pair could not know another pair offers the same story more cleanly. You can.
- A high score built on a scheduled event is a coin-flip if that event lands inside the hold; one built on structure is not. Weigh that.

HONESTY: if the field is genuinely poor tonight, say so plainly and mark your picks at their true low conviction. A quiet honest night is worth more to this desk than a manufactured one. Do not inflate to fill two slots — but do still name your two best, so the desk always has something to weigh.

JSON only, no markdown:
{"picks":[{"pair":"EURUSD","direction":"BUY|SELL","conviction":"LOW|MED|MED-HIGH|HIGH","why_this_one":"why it beat the rest of the field, 25-40 words","independence":"how it differs from the other pick, max 15 words"}],"runners_up":["PAIR — one clause on why it just missed"],"field_read":"the state of the board tonight in 40-60 words: is there opportunity out there or not, and where is the risk concentrated","field_quality":"RICH|MIXED|THIN"}`;
}

// ---------- forex-brain-compatible verdict (for the shadow ledger / EA testbed) ----------
// Emitted in EXACTLY the shape forex-brain's validateVerdict() and settleVerdict() expect, so its
// proven settlement machinery can score these calls without either side adapting to the other.
// Shared FUNCTIONS and a shared candle layer; separate STATE — these are written to
// `terminal:shadow:*`, never into `forex:*`.
//
// !! NOT AN EXECUTION INSTRUCTION !!  This is decision-support and shadow-testing only. Nothing
// here places an order and nothing reads it expecting to. Before any of this could drive a live
// EA it would need, at minimum: real-time spread and broker minimum-stop checks at fill time, a
// slippage/chase policy enforced against the live book rather than a daily candle, position
// sizing reconciled against live margin at the moment of entry rather than at screen time, and a
// kill switch. Those are a separate, deliberate design. None of them are built here.
export function toVerdict(row, nowIso, holdCeilingHours = SCREEN_CONFIG.holdCeilingHours) {
  const l = row.llm;
  const base = {
    verdictId: `${nowIso}-${row.pair.toLowerCase()}`,
    symbol: row.pair,
    source: 'terminal-screen',
    conviction: Math.round(l.score),
    // The hold ceiling, NOT forex-brain's 90 minutes: settlement must run over the life the idea
    // was actually given, which is the whole point of keeping the two engines' horizons separate.
    expiresAt: new Date(new Date(nowIso).getTime() + holdCeilingHours * 3600e3).toISOString(),
    sourcesReached: { hit: 1, expected: 1, missing: [] },
    rationale: l.read,
  };
  if (l.direction === 'STAND_ASIDE' || l.entry == null || l.tp == null || l.sl == null) {
    return { ...base, direction: 'FLAT' };
  }
  const atr = row.factors && row.factors.atrD1 ? row.factors.atrD1 : Math.abs(l.entry - l.sl) / 2;
  return {
    ...base,
    direction: l.direction,
    entryZone: {
      trigger: l.entry,
      // How far past the trigger a fill is still acceptable. Quarter of a daily ATR: beyond that
      // the move has left without you and the risk/reward you reasoned about no longer exists.
      maxChase: l.direction === 'BUY' ? +(l.entry + atr * 0.25).toFixed(6) : +(l.entry - atr * 0.25).toFixed(6),
    },
    slPrice: l.sl,
    tpPrice: l.tp,
    // Nominal, for shadow-settlement arithmetic only. REAL sizing is decided by the engine's
    // margin gate against live vitals at proposal time — never by this number.
    riskPercent: 0.5,
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
  const candlesStarted = Date.now();
  const d1 = await getUniverseCandles(SCREEN_PAIRS, '1d', 6);
  const h1 = await getUniverseCandles(SCREEN_PAIRS, '1h', 6).catch(() => ({ candles: {}, health: [] }));
  const candlesMs = Date.now() - candlesStarted;

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

  // Deterministically measurable rows, ordered by the computed score. This ordering no longer
  // decides anything on its own — it decides who Stage 1 reaches first if the budget gets tight.
  const measurable = rows.filter((r) => r.score != null).sort((a, b) => b.score - a.score);
  const unscoreable = rows.filter((r) => r.score == null);

  // A pair already open in the book is NOT a candidate: the engine's dupe gate blocks it and it
  // could never become a proposal. Spending an analyst call on it wastes a call, and letting it
  // into Stage 2's field lets the desk head spend a pick on something that will simply be
  // dropped downstream — while the consolidation prompt told it they were already excluded.
  // They stay on the board with their measured factors, clearly marked; they just do not
  // consume reasoning that the actual candidates need.
  const candidates = measurable.filter((r) => !r.alreadyOpen);
  const heldRows = measurable.filter((r) => r.alreadyOpen);

  // ---- STAGE 1: one Sonnet call per candidate ----
  const news = await getNews('forex').catch(() => []);
  const ctx = { news, exposureLine: exposureLine(exposure), holdCeilingHours: SCREEN_CONFIG.holdCeilingHours };
  const stage1Started = Date.now();
  const { scored, unscored } = await runStage1(candidates, ctx, {
    concurrency: PAIR_CONCURRENCY,
    deadline: started + RUN_BUDGET_MS,
  });
  const stage1Ms = Date.now() - stage1Started;

  // Ranked by the LLM's judgement, with the deterministic score kept alongside as the evidence
  // it was formed from. Both are shown; neither is hidden behind the other.
  const ranked = scored
    .map((r) => ({ ...r, detScore: r.score, score: r.llm.score }))
    .sort((a, b) => b.score - a.score || b.detScore - a.detScore);

  // ---- STAGE 2: one consolidation call over the whole field ----
  // Skipped rather than faked when Stage 1 produced too little to compare: a "field read" over
  // two surviving pairs would be a confident sentence about nothing.
  const stage2Started = Date.now();
  let consolidation = null, consolidationError = null;
  if (ranked.length >= 3 && Date.now() < started + RUN_BUDGET_MS) {
    try {
      consolidation = await claudeJSON(
        buildConsolidationPrompt(ranked, { ...ctx, unscoredCount: unscored.length }),
        1400, STAGE2_CALL_TIMEOUT_MS);
      if (!consolidation || !Array.isArray(consolidation.picks)) throw new Error('no picks array returned');
      // Only picks that correspond to a real scored pair survive — the consolidator must not be
      // able to introduce a pair the field never contained.
      consolidation.picks = consolidation.picks
        .filter((p) => p && ranked.some((r) => r.pair === normPair(p.pair)))
        .map((p) => ({ ...p, pair: normPair(p.pair) }))
        .slice(0, 2);
      if (!consolidation.picks.length) throw new Error('picks did not match any scored pair');
    } catch (e) {
      consolidationError = String(e.message || e).slice(0, 140);
      consolidation = null;
    }
  } else if (ranked.length < 3) {
    consolidationError = `only ${ranked.length} pair(s) scored — too thin a field to consolidate over`;
  } else {
    consolidationError = 'cron budget exhausted before the consolidation pass';
  }
  const stage2Ms = Date.now() - stage2Started;

  const pack = {
    at: new Date(nowMs).toISOString(),
    tookMs: Date.now() - started,
    timings: { candlesMs: candlesMs, stage1Ms, stage2Ms, budgetMs: RUN_BUDGET_MS },
    universeSize: SCREEN_PAIRS.length,
    candidateCount: candidates.length,
    scored: ranked.length,
    ranked,
    // Measured, shown on the board, deliberately NOT sent for analysis — see the candidates
    // split above. Separate from `unscored`: "we chose not to analyse this because you already
    // hold it" is a different statement from "the analysis failed".
    held: heldRows.map((r) => ({ pair: r.pair, detScore: r.score, factors: r.factors, why: r.why })),
    // THREE honest categories, deliberately not merged. "We had no price history" and "the
    // analyst call failed" and "we ran out of time" are different claims about a pair, and a
    // board that flattened them into one silence would be lying by omission.
    unscoreable,
    unscored,
    consolidation, consolidationError,
    exposureAtScreen: exposure,
    health: { d1: d1.health, h1: h1.health },
    model: MODEL,
    config: { weights: SCREEN_CONFIG.weights, holdCeilingHours: SCREEN_CONFIG.holdCeilingHours, pairConcurrency: PAIR_CONCURRENCY },
  };
  const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  pack.dateKey = dateKey;

  // ---- SHADOW LEDGER (the EA testbed feed) ----
  // Every directional Stage-1 call is recorded as a forex-brain-shaped verdict and settled
  // deterministically against real candles on later runs. This is how the per-pair scoring gets
  // PROVEN rather than assumed — the same discipline forex-brain applies to itself, pointed at
  // this engine's calls. Own namespace, shared functions, no execution.
  try {
    const openBefore = (await rGet('terminal:shadow:open').catch(() => null)) || [];
    const fresh = [];
    for (const r of ranked) {
      const v = toVerdict(r, pack.at);
      // forex-brain's OWN validator decides whether a verdict is coherent enough to track. If it
      // rejects one, the call is recorded as unsettleable rather than quietly dropped.
      const check = validateVerdict(v, pack.at);
      if (v.direction === 'FLAT') continue;
      if (!check.ok) { r.shadowRejected = check.errors.join('; '); continue; }
      fresh.push(v);
    }
    const settled = await settleShadow(openBefore, pack.at);
    await rSet('terminal:shadow:open', [...settled.stillOpen, ...fresh]);
    pack.shadow = { opened: fresh.length, settled: settled.settled.length, stillOpen: settled.stillOpen.length + fresh.length };
    if (settled.settled.length) {
      const ledger = (await rGet('terminal:shadow:ledger').catch(() => null)) || [];
      await rSet('terminal:shadow:ledger', [...ledger, ...settled.settled].slice(-500));
    }
  } catch (e) {
    // The shadow ledger is a measurement device. It must never be able to break the thing it
    // measures, so a failure here is recorded and the screen still ships.
    pack.shadowError = String(e.message || e).slice(0, 140);
  }
  // `terminal:screen` is the latest-pointer actIdeas reads; the dated key is the archive, so a
  // board can be looked back at when reviewing why an idea was or wasn't proposed.
  await rSet('terminal:screen', pack);
  await rSet(`terminal:screen:${dateKey}`, pack).catch(() => {});
  return pack;
}

// Settle previously-opened shadow verdicts against fresh candles, using forex-brain's own
// settleVerdict — pessimistic by design (a candle touching both SL and TP scores as SL).
// Returns { settled, stillOpen }. A pair whose candles cannot be fetched stays OPEN rather than
// being judged on missing data.
export async function settleShadow(open, nowIso) {
  const settled = [], stillOpen = [];
  for (const v of open || []) {
    let candles = null;
    try { candles = (await getCandles(v.symbol, '1h')).candles; } catch { /* keep it open */ }
    if (!candles) { stillOpen.push(v); continue; }
    let ruling;
    try { ruling = settleVerdict(v, candles, nowIso); }
    catch (e) { stillOpen.push(v); continue; }
    if (ruling.status === 'PENDING' || ruling.status === 'OPEN') { stillOpen.push(v); continue; }
    settled.push({
      at: nowIso, verdictId: v.verdictId, symbol: v.symbol, direction: v.direction,
      conviction: v.conviction, status: ruling.status,
      entry: ruling.entry ?? null, exit: ruling.exit ?? null, r: ruling.r ?? null,
      closedAt: ruling.closedAt ?? null, rationale: v.rationale,
    });
  }
  return { settled, stillOpen };
}

// Scorecard over the shadow ledger — the answer to "is the per-pair scoring any good?".
export function shadowScorecard(rows) {
  const card = { settled: rows.length, tp: 0, sl: 0, notTriggered: 0, chaseSkip: 0, sumR: 0, byPair: {}, byConvictionBand: {} };
  for (const r of rows) {
    const band = r.conviction >= 71 ? '71-100' : r.conviction >= 51 ? '51-70' : '0-50';
    card.byConvictionBand[band] = card.byConvictionBand[band] || { tp: 0, sl: 0, sumR: 0 };
    const p = card.byPair[r.symbol] = card.byPair[r.symbol] || { tp: 0, sl: 0, other: 0, sumR: 0 };
    if (r.status === 'TP') { card.tp++; card.sumR += r.r || 0; p.tp++; p.sumR += r.r || 0; card.byConvictionBand[band].tp++; card.byConvictionBand[band].sumR += r.r || 0; }
    else if (r.status === 'SL') { card.sl++; card.sumR += r.r || 0; p.sl++; p.sumR += r.r || 0; card.byConvictionBand[band].sl++; card.byConvictionBand[band].sumR += r.r || 0; }
    else if (r.status === 'NOT_TRIGGERED') { card.notTriggered++; p.other++; }
    else if (r.status === 'CHASE_SKIP') { card.chaseSkip++; p.other++; }
  }
  const resolved = card.tp + card.sl;
  card.hitRate = resolved ? +((card.tp / resolved) * 100).toFixed(1) : null;
  card.avgR = resolved ? +(card.sumR / resolved).toFixed(2) : null;
  card.sumR = +card.sumR.toFixed(2);
  return card;
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
        ok: true, at: pack.at, tookMs: pack.tookMs, timings: pack.timings, model: pack.model,
        scored: pack.scored, universeSize: pack.universeSize,
        candidateCount: pack.candidateCount, held: (pack.held || []).map((h) => h.pair),
        top: pack.ranked.slice(0, 8).map((r) => ({ pair: r.pair, score: r.score, detScore: r.detScore, dir: r.llm.direction, conviction: r.llm.conviction, read: r.llm.read })),
        consolidation: pack.consolidation, consolidationError: pack.consolidationError,
        unscoreable: pack.unscoreable.map((u) => ({ pair: u.pair, reason: u.unscoreable })),
        unscored: pack.unscored.map((u) => ({ pair: u.pair, reason: u.unscored })),
        shadow: pack.shadow, shadowError: pack.shadowError,
      });
    }
    if (action === 'shadow') {
      const [open, ledger] = await Promise.all([
        rGet('terminal:shadow:open').catch(() => null),
        rGet('terminal:shadow:ledger').catch(() => null),
      ]);
      const rows = ledger || [];
      return res.status(200).json({ ok: true, open: open || [], settled: rows.length, scorecard: shadowScorecard(rows), ledger: rows.slice(-60) });
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
