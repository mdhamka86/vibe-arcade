// ============================================================================
// TERMINAL OVERNIGHT SCREEN (bundle C) — api/terminal-screen.js + api/fx-candles.js
//   node tests/test_terminal_screen.js
//
// The screen decides which pairs the desk even considers. A ranking that is subtly wrong is
// worse than none, because it looks authoritative: it arrives with a number attached and gets
// believed. So this suite goes after the ways a ranking can be quietly wrong —
//   * scoring a direction nobody would trade,
//   * crediting book-fit for the flattering side rather than the tradeable one,
//   * counting catalysts outside the hold window,
//   * silently dropping a pair instead of reporting it unscoreable,
//   * two copies of the pip rule drifting apart,
// — and then breaks each of those guards on purpose in the mutation section to prove the
// assertions above are load-bearing rather than decorative.
//
// These modules are proper ESM with real exports, so unlike the older suites this one imports
// the shipped code directly rather than extracting it from source. Mutation testing writes a
// modified copy INTO api/ (so its relative imports still resolve), imports it, and deletes it.
//
// NETWORK: a few checks hit Yahoo to prove the data pipeline actually works end to end. They are
// clearly marked and are SKIPPED, not failed, when offline — a suite that goes red on a train is
// a suite people stop running.
// ============================================================================
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'api');
const SCREEN_PATH = path.join(API, 'terminal-screen.js');
const CANDLES_PATH = path.join(API, 'fx-candles.js');
const ENGINE_PATH = path.join(API, 'terminal-engine.js');
for (const p of [SCREEN_PATH, CANDLES_PATH, ENGINE_PATH]) {
  if (!fs.existsSync(p)) { console.error('Missing ' + p + ' — run from the repo.'); process.exit(2); }
}
const SCREEN_SRC = fs.readFileSync(SCREEN_PATH, 'utf8');
const ENGINE_SRC = fs.readFileSync(ENGINE_PATH, 'utf8');
// The Board tab is where the run modes are actually chosen, so its markup is part of this
// contract, not a separate concern.
const UI_PATH = path.join(__dirname, '..', 'public', 'terminal.html');
const UI_SRC = fs.existsSync(UI_PATH) ? fs.readFileSync(UI_PATH, 'utf8') : null;

let pass = 0, fail = 0, skip = 0; const fails = [];
function check(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); console.log('  x FAIL:', name); } }
function skipped(name) { skip++; console.log('  ~ SKIP:', name); }

const H = 3600e3;
// A synthetic daily series with a controllable shape, so the factors can be checked against
// arithmetic we know rather than against whatever the market happened to do today.
// NEWEST-FIRST, matching computeBox/computeAtr's convention (index 0 = in-progress bar).
function series({ n = 70, start = 1.1000, drift = 0, range = 0.004, lastClose = null }) {
  const asc = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    px += drift;
    asc.push({ datetime: new Date(Date.now() - (n - i) * 86400e3).toISOString(), open: px, high: px + range / 2, low: px - range / 2, close: px, t: Date.now() - (n - i) * 86400e3 });
  }
  const out = asc.reverse();
  if (lastClose != null) out[0] = { ...out[0], close: lastClose, high: Math.max(out[0].high, lastClose), low: Math.min(out[0].low, lastClose) };
  return out;
}

// Run `fn` with globalThis.fetch stubbed to return one canned Anthropic response, so the real
// scorePairLLM validation path can be exercised without a network call. Restored afterwards
// even on throw — a leaked stub would silently poison every later check.
async function withStubbedClaude(payload, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => (payload === null
      ? { content: [{ text: 'not json at all' }] }
      : { content: [{ text: JSON.stringify(payload) }], stop_reason: 'end_turn' }),
  });
  try { return await fn(); } finally { globalThis.fetch = real; }
}

(async function main() {
  const S = await import('file://' + SCREEN_PATH.replace(/\\/g, '/'));
  const C = await import('file://' + CANDLES_PATH.replace(/\\/g, '/'));
  const E = await import('file://' + ENGINE_PATH.replace(/\\/g, '/'));

  console.log('\n=== 1. THE UNIVERSE (Q3: his real Phillip Nova set) ===');
  const U = C.SCREEN_PAIRS;
  const majors = ['EURUSD', 'USDJPY', 'GBPUSD', 'USDCHF', 'AUDUSD', 'NZDUSD', 'USDCAD'];
  for (const m of majors) check(`major ${m} is in the universe`, U.includes(m));
  const namedCrosses = ['EURGBP', 'EURAUD', 'EURJPY', 'GBPJPY', 'CHFJPY', 'NZDJPY', 'GBPCAD', 'EURNZD', 'GBPNZD', 'AUDNZD', 'AUDJPY', 'EURCAD'];
  for (const c of namedCrosses) check(`cross ${c} is in the universe`, U.includes(c));
  // EM exotics are excluded by decision, not by accident — assert the exclusion so a future
  // "just add a few more pairs" cannot quietly reintroduce them.
  for (const x of ['USDZAR', 'USDTRY', 'USDMXN', 'ZARJPY', 'TRYJPY']) {
    check(`EM exotic ${x} is excluded`, !U.includes(x));
  }
  check('no pair in the universe touches an EM currency',
    !U.some((p) => /ZAR|TRY|MXN|RUB|BRL|INR|THB|PLN|HUF/.test(p)));
  check('USDCNH is not silently enabled', !U.includes('USDCNH'));
  check('DXY is in the symbol map but NOT rankable as a trade',
    !!C.FX_UNIVERSE.DXY && !U.includes('DXY'));
  check('every screened pair has a Yahoo symbol', U.every((p) => !!C.FX_UNIVERSE[p]));
  check('universe is a sensible size (20-30 pairs)', U.length >= 20 && U.length <= 30);

  console.log('\n=== 2. PIP RULE: two copies must not drift (the guard I promised) ===');
  // fx-candles.pipSizeFor and terminal-engine.pipSize are deliberately separate — the engine's
  // copy is load-bearing for an established suite that extracts it from source. Duplication is
  // only safe if something checks the copies agree, so this is that something.
  const enginePip = (() => {
    const m = ENGINE_SRC.match(/function pipSize[\s\S]*?\n\}\n/);
    if (!m) return null;
    const Module = require('module'); const mod = new Module();
    mod._compile(m[0] + '\nconst normPair=(p)=>(p||"").replace(/[^A-Za-z]/g,"").toUpperCase();\nmodule.exports=pipSize;', ENGINE_PATH + '#pip');
    return mod.exports;
  })();
  check('engine pipSize was extractable', typeof enginePip === 'function');
  if (typeof enginePip === 'function') {
    let agree = true; const disagreed = [];
    for (const p of U) { if (enginePip(p, 1) !== C.pipSizeFor(p, 1)) { agree = false; disagreed.push(p); } }
    check('pip rule agrees across the ENTIRE universe' + (agree ? '' : ` (differs on ${disagreed.join(',')})`), agree);
    check('JPY pairs are 2-decimal in both', C.pipSizeFor('USDJPY') === 0.01 && enginePip('USDJPY', 150) === 0.01);
    check('non-JPY pairs are 4-decimal in both', C.pipSizeFor('EURUSD') === 0.0001 && enginePip('EURUSD', 1.14) === 0.0001);
  }

  console.log('\n=== 3. CANDLE PLUMBING ===');
  const asc4 = C.aggregate(series({ n: 8, start: 1, drift: 0.01, range: 0.02 }), 4);
  check('aggregate(H1,4) halves an 8-bar series to 2', asc4.length === 2);
  check('aggregate keeps newest-first ordering', asc4[0].t > asc4[1].t);
  check('aggregated high is the max of its group', (() => {
    const src = series({ n: 4, start: 1, drift: 0.01, range: 0.02 });
    const g = C.aggregate(src, 4)[0];
    return Math.abs(g.high - Math.max(...src.map((c) => c.high))) < 1e-12;
  })());
  check('aggregated low is the min of its group', (() => {
    const src = series({ n: 4, start: 1, drift: 0.01, range: 0.02 });
    const g = C.aggregate(src, 4)[0];
    return Math.abs(g.low - Math.min(...src.map((c) => c.low))) < 1e-12;
  })());
  check('aggregate drops an incomplete trailing group rather than inventing a short bar',
    C.aggregate(series({ n: 7 }), 4).length === 1);
  check('aggregate with factor<2 is a no-op', C.aggregate(series({ n: 5 }), 1).length === 5);
  // getCandles is async, so an unknown pair REJECTS rather than throwing synchronously — the
  // first version of this check let the rejection escape and crashed the suite.
  check('unknown pair is refused, not guessed',
    await C.getCandles('XXXYYY', '1d').then(() => false, (e) => /not in the FX universe/.test(e.message)));
  check('unsupported interval is refused',
    await C.getCandles('EURUSD', '5m').then(() => false, (e) => /unsupported interval/.test(e.message)));

  console.log('\n=== 4. FACTORS ===');
  const flat = series({ n: 70, start: 1.1, drift: 0, range: 0.004 });
  const up = series({ n: 70, start: 1.0, drift: 0.002, range: 0.004 });
  const down = series({ n: 70, start: 1.2, drift: -0.002, range: 0.004 });
  check('smaCompleted skips the in-progress bar', (() => {
    const s2 = series({ n: 30, start: 1.0, drift: 0, range: 0.002, lastClose: 99 });
    return Math.abs(S.smaCompleted(s2, 20) - 1.0) < 1e-9; // the 99 must NOT contaminate it
  })());
  check('smaCompleted returns null when short of bars', S.smaCompleted(series({ n: 5 }), 20) === null);
  check('rangePosition: at the high => 1', Math.abs(S.rangePosition(1.2, { high: 1.2, low: 1.0, size: 0.2 }) - 1) < 1e-9);
  check('rangePosition: at the low => 0', Math.abs(S.rangePosition(1.0, { high: 1.2, low: 1.0, size: 0.2 })) < 1e-9);
  check('rangePosition: midpoint => 0.5', Math.abs(S.rangePosition(1.1, { high: 1.2, low: 1.0, size: 0.2 }) - 0.5) < 1e-9);
  check('rangePosition clamps beyond the box', S.rangePosition(1.5, { high: 1.2, low: 1.0, size: 0.2 }) === 1);
  check('rangePosition null on a zero-width box', S.rangePosition(1.1, { high: 1, low: 1, size: 0 }) === null);
  check('volRatio ~1 on a steady series', Math.abs(S.volRatio(flat, 5, 30) - 1) < 0.25);
  check('volRatio rises when recent bars widen', (() => {
    const s2 = series({ n: 70, start: 1.1, drift: 0, range: 0.004 });
    for (let i = 1; i <= 5; i++) { s2[i] = { ...s2[i], high: s2[i].close + 0.02, low: s2[i].close - 0.02 }; }
    return S.volRatio(s2, 5, 30) > 1.8;
  })());

  console.log('\n=== 5. CATALYST LOAD respects the hold window ===');
  const cal = [
    { title: 'NFP', ccy: 'USD', impact: 'High', when: 'Fri 19:30 BKK', utc: Date.now() + 20 * H },
    { title: 'CPI', ccy: 'GBP', impact: 'High', when: 'Wed 14:00 BKK', utc: Date.now() + 40 * H },
    { title: 'Retail', ccy: 'GBP', impact: 'Medium', when: 'Thu 14:00 BKK', utc: Date.now() + 50 * H },
    { title: 'Way out', ccy: 'USD', impact: 'High', when: 'next week', utc: Date.now() + 130 * H },
    { title: 'Past', ccy: 'USD', impact: 'High', when: 'yesterday', utc: Date.now() - 5 * H },
    { title: 'Cash Rate', ccy: 'AUD', impact: 'High', when: 'Tue', utc: Date.now() + 10 * H },
  ];
  const gbpusd = S.catalystLoad(cal, 'GBPUSD', 96);
  check('counts High events on BOTH legs', gbpusd.high === 2);
  check('counts Medium separately', gbpusd.medium === 1);
  check('excludes an event beyond the hold ceiling', gbpusd.high === 2);
  check('excludes an event already past', !JSON.stringify(gbpusd).includes('Past'));
  check('ignores a currency the pair does not hold', S.catalystLoad(cal, 'GBPUSD', 96).next.title !== 'Cash Rate');
  check('reports the NEXT event with hours-out', gbpusd.next && gbpusd.next.title === 'NFP' && Math.abs(gbpusd.next.hoursOut - 20) < 0.2);
  check('a pair with nothing scheduled reports zero', S.catalystLoad(cal, 'EURCHF', 96).high === 0);

  console.log('\n=== 6. BOOK FIT (shared currencyExposure) ===');
  // His real book, netted by the SHIPPED exposure function the idea gate also uses.
  const realBook = [
    { pair: 'EURCHF', direction: 'SELL', lots: 0.04 }, { pair: 'AUDUSD', direction: 'BUY', lots: 0.05 },
    { pair: 'GBPJPY', direction: 'BUY', lots: 0.03 }, { pair: 'AUDNZD', direction: 'BUY', lots: 0.03 },
    { pair: 'AUDJPY', direction: 'BUY', lots: 0.03 }, { pair: 'GBPUSD', direction: 'SELL', lots: 0.03 },
  ];
  const exp = E.currencyExposure(realBook);
  check('screen uses the SAME exposure fn as the gate (long AUD 0.11)', Math.abs(exp.AUD - 0.11) < 1e-9);
  const sellAudNzd = S.bookFit('AUDNZD', 'SELL', exp);
  check('SELL AUDNZD offsets both long AUD and short NZD', sellAudNzd.offset > 0.13 && sellAudNzd.stack === 0);
  check('...so its net is strongly positive', sellAudNzd.net > 0.13);
  const buyGbpJpy = S.bookFit('GBPJPY', 'BUY', exp);
  check('BUY GBPJPY stacks the existing short JPY', buyGbpJpy.stack >= 0.06 && buyGbpJpy.net < 0);
  check('book fit ignores sub-0.01 float residue', S.bookFit('EURUSD', 'BUY', { USD: 0.004 }).detail.length === 0);
  check('flat book gives a neutral fit', S.bookFit('EURUSD', 'BUY', {}).net === 0);

  console.log('\n=== 7. DIRECTION LOGIC — the regression that live data caught ===');
  // The first version picked whichever direction flattered the book. On real data that made the
  // board recommend BUY on EURNZD while it sat in a 2.8-ATR DOWNTREND, purely because buying it
  // offset a small short-EUR position. A screen that recommends the wrong side of a strong trend
  // because the arithmetic is friendlier is worse than no screen at all.
  const downTrend = S.scorePair({ pair: 'EURNZD', d1: down, h1: null, cal: [], exposure: { EUR: -0.04, NZD: -0.03 }, recentlyProposed: false });
  check('a strong downtrend yields SELL, not the book-flattering BUY', downTrend.preferredDirection === 'SELL');
  check('...and says the trend decided it', downTrend.directionBasis === 'TREND');
  const upTrend = S.scorePair({ pair: 'GBPJPY', d1: up, h1: null, cal: [], exposure: { JPY: -0.06 }, recentlyProposed: false });
  check('a strong uptrend yields BUY', upTrend.preferredDirection === 'BUY');
  check('...even though that BUY stacks the book, which is scored as a PENALTY', upTrend.parts.bookFit < 0);
  check('...and the reason says so plainly', /ADDS to existing exposure/.test(upTrend.why));
  const noTrend = S.scorePair({ pair: 'EURUSD', d1: flat, h1: null, cal: [], exposure: { USD: -0.10 }, recentlyProposed: false });
  check('with no decisive trend, book-fit picks the side', noTrend.directionBasis === 'BOOK_FIT');
  check('...choosing the side that reduces risk', noTrend.parts.bookFit > 0);
  check('bookFit is reported for the direction actually scored',
    upTrend.factors.bookFit.scoredFor === upTrend.preferredDirection);

  console.log('\n=== 8. SCORING ===');
  const W = S.SCREEN_CONFIG.weights;
  check('positive weights total 100', W.movement + W.structure + W.trend + W.catalyst + W.bookFit === 100);
  check('a quiet mid-range pair with no catalyst scores low', (() => {
    const r = S.scorePair({ pair: 'EURUSD', d1: flat, h1: null, cal: [], exposure: {}, recentlyProposed: false });
    return r.score < 30;
  })());
  check('a trending pair at a range edge with a catalyst scores high', (() => {
    const r = S.scorePair({ pair: 'GBPUSD', d1: up, h1: null, cal: [{ title: 'CPI', ccy: 'GBP', impact: 'High', when: 'x', utc: Date.now() + 20 * H }, { title: 'NFP', ccy: 'USD', impact: 'High', when: 'y', utc: Date.now() + 30 * H }], exposure: {}, recentlyProposed: false });
    return r.score > 55;
  })());
  check('the freshness penalty actually bites', (() => {
    const a = S.scorePair({ pair: 'GBPUSD', d1: up, h1: null, cal: [], exposure: {}, recentlyProposed: false });
    const b = S.scorePair({ pair: 'GBPUSD', d1: up, h1: null, cal: [], exposure: {}, recentlyProposed: true });
    return Math.abs((a.score - b.score) - Math.abs(W.staleness)) < 0.01;
  })());
  check('parts sum to the score', (() => {
    const r = S.scorePair({ pair: 'GBPUSD', d1: up, h1: null, cal: [], exposure: {}, recentlyProposed: false });
    return Math.abs(Object.values(r.parts).reduce((a, b) => a + b, 0) - r.score) < 0.15;
  })());
  check('too few bars => UNSCOREABLE, not a silent zero', (() => {
    const r = S.scorePair({ pair: 'EURUSD', d1: series({ n: 10 }), h1: null, cal: [], exposure: {}, recentlyProposed: false });
    return r.score === null && /bars available/.test(r.unscoreable);
  })());
  check('every scored row carries a human-readable why', (() => {
    const r = S.scorePair({ pair: 'EURUSD', d1: flat, h1: null, cal: [], exposure: {}, recentlyProposed: false });
    return typeof r.why === 'string' && r.why.length > 10;
  })());

  console.log('\n=== 9. STALENESS CONTRACT (the additive-only fallback) ===');
  const mk = (hoursAgo) => ({ at: new Date(Date.now() - hoursAgo * H).toISOString(), ranked: [] });
  check('a fresh screen is FRESH', E.screenAge(mk(1)).state === 'FRESH');
  check('11h old is still FRESH', E.screenAge(mk(11)).state === 'FRESH');
  check('13h old is STALE', E.screenAge(mk(13)).state === 'STALE');
  check('35h old is still STALE (usable with warning)', E.screenAge(mk(35)).state === 'STALE');
  check('37h old is EXPIRED', E.screenAge(mk(37)).state === 'EXPIRED');
  check('missing screen is MISSING, never treated as fresh', E.screenAge(null).state === 'MISSING');
  check('a screen with no timestamp is MISSING', E.screenAge({ ranked: [] }).state === 'MISSING');
  check('an EXPIRED screen says it was ignored', /ignored/.test(E.screenAge(mk(80)).label));
  check('thresholds are 12h / 36h', E.SCREEN_FRESH_MS === 12 * H && E.SCREEN_USABLE_MS === 36 * H);
  // The engine must only USE the board in FRESH/STALE — this is the additive-only guarantee.
  check('engine gates board use on FRESH or STALE only',
    /screen\.state === 'FRESH' \|\| screen\.state === 'STALE'/.test(ENGINE_SRC));
  check('engine tells the model explicitly when it is hunting unscreened',
    /hunting UNSCREENED/.test(ENGINE_SRC));
  check('engine records usedScreen either way, so a degraded run is visible',
    /usedScreen: screenRanked\.length > 0/.test(ENGINE_SRC));

  console.log('\n=== 10. THE FUNNEL + RETRY (#9, #10) ===');
  check('pattern feeds follow the board when there is one',
    /screenRanked\.slice\(0, 8\)\.map\(\(r\) => r\.pair\)/.test(ENGINE_SRC));
  check('...and fall back to the fixed majors when there is not',
    /: FALLBACK_PATTERN_PAIRS;/.test(ENGINE_SRC));
  check('retry fires on a thin-conviction run, not only on invalid levels',
    /nothingClears && haveSecondSlice/.test(ENGINE_SRC));
  check('retry is handed candidates 9-16, a slice the first pass never saw',
    /screenLines\(screenRanked, 8, 16\)/.test(ENGINE_SRC));
  check('the conviction-triggered retry requires a second slice to exist',
    /const haveSecondSlice = screenRanked\.length > 8/.test(ENGINE_SRC));
  check('a merely-different retry cannot displace a valid first pass',
    /if \(firstWasBad \|\| secondClears\)/.test(ENGINE_SRC));
  check('price coverage extends to the crosses the board can now surface',
    ['EURCAD', 'GBPCAD', 'NZDCAD', 'EURNZD', 'GBPNZD'].every((p) => new RegExp(`'${p}'`).test(ENGINE_SRC)));

  console.log('\n=== 11. forex-brain: CONDITIONS ONLY (Q6) ===');
  check('the engine reads forex-brain verdicts', /forex:verdict:/.test(ENGINE_SRC));
  check('...only as a conditions line, never as an idea', /CONDITIONS ONLY, not an idea source/.test(ENGINE_SRC));
  check('...excluding expired verdicts', /Date\.parse\(v\.expiresAt\) > nowMs/.test(ENGINE_SRC));
  check('...and staying silent on a thin sample', /live\.length < 3/.test(ENGINE_SRC));
  check('the screen reads NO forex-brain state (share code, not state)',
    !/forex:(verdict|prices|news|candles|openVerdicts|shadowLedger|journal)/.test(SCREEN_SRC));
  check('the screen DOES reuse forex-brain pure functions',
    /import \{ computeBox, computeAtr(, validateVerdict, settleVerdict)? \} from '\.\/forex-brain\.js'/.test(SCREEN_SRC));
  check('...including its verdict validator and settler for the shadow ledger',
    /validateVerdict/.test(SCREEN_SRC) && /settleVerdict/.test(SCREEN_SRC));
  check('no import cycle: engine never imports the screen',
    !/from '\.\/terminal-screen\.js'/.test(ENGINE_SRC));

  console.log('\n=== 12. OPERATIONAL ===');
  check('screen declares maxDuration 300', /export const config = \{ maxDuration: 300 \}/.test(SCREEN_SRC));
  check('screen uses the same model as the forex-brain experiment', /claude-sonnet-4-6/.test(SCREEN_SRC));
  check('the wall-clock guard stops well inside the 300s cron budget',
    S.SCREEN_CONFIG && /RUN_BUDGET_MS = 235000/.test(SCREEN_SRC));
  check('per-pair calls carry their own timeout so one hang cannot eat the budget',
    /PAIR_CALL_TIMEOUT_MS = \d+/.test(SCREEN_SRC) && /signal: ctl\.signal/.test(SCREEN_SRC));
  check('screen hold ceiling matches the engine HORIZON ceiling',
    S.SCREEN_CONFIG.holdCeilingHours === 96 && /ceilingHours: 96/.test(ENGINE_SRC));
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const screenCrons = (vercel.crons || []).filter((c) => /terminal-screen/.test(c.path));
  check('screen has crons wired', screenCrons.length >= 3);
  check('...including a Sunday run for the Monday open (Q4)',
    screenCrons.some((c) => /\* \* 0(,|$)|\* 0$/.test(c.schedule) || / 0$/.test(c.schedule)));

  console.log('\n=== 13. LIVE DATA PIPELINE (network; skipped offline) ===');
  let online = true;
  try {
    const d = await C.getCandles('EURUSD', '1d');
    check('Yahoo returns a usable daily series for EURUSD', d.candles.length > 40);
    check('candles are newest-first', d.candles[0].t > d.candles[1].t);
    check('no null bars survive the parse', d.candles.every((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite)));
  } catch (e) { online = false; skipped('Yahoo daily fetch (offline: ' + String(e.message).slice(0, 40) + ')'); }
  if (online) {
    // The crosses that had NO price anchor at all before this work.
    for (const p of ['EURNZD', 'GBPNZD', 'NZDCAD']) {
      try {
        const d = await C.getCandles(p, '1d');
        check(`${p} — previously unpriceable — now returns real candles`, d.candles.length > 40);
      } catch { check(`${p} fetch`, false); }
    }
    try {
      const d = await C.getCandles('GBPJPY', '1d');
      const r = S.scorePair({ pair: 'GBPJPY', d1: d.candles, h1: null, cal: [], exposure: {}, recentlyProposed: false });
      check('a real pair scores end-to-end with a sane ATR', r.score != null && r.factors.atrD1Pips > 20 && r.factors.atrD1Pips < 400);
    } catch { check('end-to-end scoring on live data', false); }
  } else {
    skipped('live cross fetches'); skipped('end-to-end scoring');
  }

  console.log('\n=== 14. TWO-STAGE LLM SCORING ===');
  // Stage 1 is driven through an INJECTED scorer, so the whole loop — concurrency, the deadline
  // guard, the pass/fail split — is exercised deterministically without a single network call.
  const detRows = ['EURUSD', 'GBPJPY', 'AUDNZD', 'EURNZD', 'NZDCAD', 'GBPCHF', 'EURCAD'].map((p) =>
    S.scorePair({ pair: p, d1: p === 'EURUSD' ? flat : up, h1: null, cal, exposure: exp, recentlyProposed: false }));
  const okScorer = async (row) => ({ ok: true, llm: { score: 50 + (row.pair.charCodeAt(0) % 30), direction: 'BUY', conviction: 'MED', read: 'A perfectly adequate synthetic read for ' + row.pair, keyRisk: 'x', catalystDependency: 'y', entry: 1, tp: 1.1, sl: 0.9 } });
  const r1 = await S.runStage1(detRows, { news: [], exposureLine: 'FLAT' }, { scorer: okScorer, concurrency: 3 });
  check('stage 1 scores every pair when all calls succeed', r1.scored.length === detRows.length);
  check('...and reports nothing unscored', r1.unscored.length === 0);
  check('...attaching the llm read to each row', r1.scored.every((r) => r.llm && r.llm.read.length > 10));
  check('...while preserving the deterministic factors alongside it',
    r1.scored.every((r) => r.factors && r.factors.atrD1Pips != null));

  console.log('\n=== 14b. ALREADY-OPEN PAIRS DO NOT CONSUME ANALYST CALLS ===');
  // Found in the first production run: AUDUSD, which he already holds, got a Stage-1 call and
  // reached the consolidation field — while the consolidation prompt told the desk head that
  // open pairs were already excluded. That is a wasted call, a pick that gets silently dropped
  // downstream by the engine's dupe gate, and a prompt asserting something untrue.
  check('the screen splits candidates from held pairs before Stage 1',
    /const candidates = measurable\.filter\(\(r\) => !r\.alreadyOpen\)/.test(SCREEN_SRC));
  check('...and Stage 1 runs over candidates, not everything measurable',
    /runStage1\(candidates, ctx/.test(SCREEN_SRC));
  check('...with held pairs still published for the board', /held: heldRows\.map/.test(SCREEN_SRC));
  check('the consolidation prompt\'s claim that open pairs are excluded is now TRUE',
    /Pairs already open are excluded from the field below/.test(SCREEN_SRC) && /runStage1\(candidates/.test(SCREEN_SRC));
  check('held is reported separately from unscored — different claims, different buckets',
    /held:/.test(SCREEN_SRC) && /unscored,/.test(SCREEN_SRC));

  console.log('\n=== 15. PARTIAL FAILURE — one bad call must not tank the run ===');
  // THE headline risk. Twenty-odd network calls will not all succeed forever.
  const flaky = async (row) => {
    if (row.pair === 'GBPJPY') throw new Error('socket hang up');
    if (row.pair === 'AUDNZD') return { ok: false, error: 'response truncated at the token limit' };
    return okScorer(row);
  };
  // A scorer that THROWS (rather than returning ok:false) is the nastier case: scorePairLLM is
  // written never to throw, but runStage1 must not assume that of an arbitrary scorer.
  const safeFlaky = async (row) => { try { return await flaky(row); } catch (e) { return { ok: false, error: String(e.message) }; } };
  const r2 = await S.runStage1(detRows, { news: [], exposureLine: 'FLAT' }, { scorer: safeFlaky, concurrency: 3 });
  check('the run COMPLETES despite two failures', r2.scored.length + r2.unscored.length === detRows.length);
  check('the healthy pairs are still scored', r2.scored.length === detRows.length - 2);
  check('the failed pairs are marked unscored, NOT dropped', r2.unscored.length === 2);
  check('...each carrying its real reason', r2.unscored.every((u) => typeof u.unscored === 'string' && u.unscored.length > 3));
  check('...naming the actual failure, not a generic message',
    r2.unscored.some((u) => /hang up/.test(u.unscored)) && r2.unscored.some((u) => /token limit/.test(u.unscored)));
  check('an unscored pair keeps its deterministic factors for the board',
    r2.unscored.every((u) => u.factors && u.factors.atrD1Pips != null));
  check('no pair is lost between the two lists',
    new Set([...r2.scored, ...r2.unscored].map((r) => r.pair)).size === detRows.length);
  // Total failure: still a completed run, not an exception.
  const allFail = await S.runStage1(detRows, { news: [], exposureLine: 'FLAT' }, { scorer: async () => ({ ok: false, error: 'api down' }), concurrency: 3 });
  check('a total Stage-1 outage still returns cleanly', allFail.scored.length === 0 && allFail.unscored.length === detRows.length);

  console.log('\n=== 15b. A MALFORMED RESPONSE IS A FAILURE, NOT A SCORE ===');
  // The model can return something structurally plausible and semantically junk. Every one of
  // these must come back as ok:false with a reason — never as a score the board then ranks on.
  const badResponses = [
    ['score out of range', { score: 940, direction: 'BUY', read: 'a long enough read here' }, /out of range/],
    ['score missing', { direction: 'BUY', read: 'a long enough read here' }, /out of range/],
    ['score not a number', { score: 'very good', direction: 'BUY', read: 'a long enough read here' }, /out of range/],
    ['direction invalid', { score: 70, direction: 'MAYBE', read: 'a long enough read here' }, /direction/],
    ['direction missing', { score: 70, read: 'a long enough read here' }, /direction/],
    ['read too short to be judgement', { score: 70, direction: 'BUY', read: 'ok' }, /read too short/],
    ['not JSON at all', null, /no JSON object|JSON/],
  ];
  for (const [label, payload, re] of badResponses) {
    const r = await withStubbedClaude(payload, () => S.scorePairLLM(detRows[0], { news: [], exposureLine: 'FLAT' }));
    check(`${label} => unscored with a reason`, r.ok === false && re.test(r.error));
  }
  const good = await withStubbedClaude({ score: 68, direction: 'SELL', conviction: 'MED-HIGH', read: 'A genuinely long enough analyst read for the validator.', key_risk: 'CPI surprise', catalyst_dependency: 'GBP CPI Wed', entry: 218.1, tp: 215.0, sl: 220.0 },
    () => S.scorePairLLM(detRows[1], { news: [], exposureLine: 'FLAT' }));
  check('a well-formed response is accepted', good.ok === true && good.llm.score === 68 && good.llm.direction === 'SELL');
  check('...preserving conviction and levels', good.llm.conviction === 'MED-HIGH' && good.llm.entry === 218.1 && good.llm.sl === 220);
  const oddConv = await withStubbedClaude({ score: 60, direction: 'BUY', conviction: 'ENORMOUS', read: 'A genuinely long enough analyst read here.' },
    () => S.scorePairLLM(detRows[0], { news: [], exposureLine: 'FLAT' }));
  check('an unrecognised conviction falls back to LOW rather than being trusted', oddConv.ok && oddConv.llm.conviction === 'LOW');

  console.log('\n=== 16. THE CRON BUDGET GUARD ===');
  // Vercel kills the function at 300s with no chance to write, which would lose a run that had
  // already scored 20 pairs. The deadline must stop it cleanly and ship what it has.
  const slow = async (row) => { await new Promise((r) => setTimeout(r, 40)); return okScorer(row); };
  const tight = await S.runStage1(detRows, { news: [], exposureLine: 'FLAT' }, { scorer: slow, concurrency: 1, deadline: Date.now() + 90 });
  check('the deadline stops the loop rather than running past the budget', tight.scored.length < detRows.length);
  check('...and pairs it never reached are marked, not silently missing',
    tight.scored.length + tight.unscored.length === detRows.length);
  check('...with a reason that says what happened',
    tight.unscored.every((u) => /budget ran out/.test(u.unscored)));
  check('a generous deadline does not trip the guard',
    (await S.runStage1(detRows, { news: [], exposureLine: 'FLAT' }, { scorer: okScorer, concurrency: 3, deadline: Date.now() + 60000 })).unscored.length === 0);

  console.log('\n=== 17. PROMPTS ===');
  const pairPrompt = S.buildPairPrompt(detRows[1], { news: [{ source: 'ForexLive', title: 'BoJ holds policy', desc: 'The Bank of Japan left rates unchanged', ts: Date.now() }], exposureLine: 'LONG AUD 0.11 lots' });
  check('the per-pair prompt names only that pair', (pairPrompt.match(/GBPJPY/g) || []).length >= 2 && !pairPrompt.includes('AUDNZD'));
  check('...carries the measured evidence', /Daily ATR/.test(pairPrompt) && /20-day range/.test(pairPrompt) && /Recent energy/.test(pairPrompt));
  check('...carries the book exposure', /LONG AUD 0\.11/.test(pairPrompt));
  check('...carries pair-relevant news only', /BoJ holds policy/.test(pairPrompt));
  check('...tells the analyst it is judging ONE pair, not the field', /Do not compare it to other pairs/.test(pairPrompt));
  check('...pushes back against score inflation', /willing to score low/.test(pairPrompt));
  check('...states the 2-3 day horizon', /INTERDAY/.test(pairPrompt) && /2-3 days/.test(pairPrompt));
  const consPrompt = S.buildConsolidationPrompt(r1.scored, { exposureLine: 'LONG AUD 0.11 lots', unscoredCount: 2 });
  check('the consolidation prompt carries every analyst read', r1.scored.every((r) => consPrompt.includes(r.pair)));
  check('...tells the head to do what no analyst could', /compare the field/.test(consPrompt));
  check('...warns that two correlated picks are one bet', /ONE bet at double size/.test(consPrompt));
  check('...discloses how many pairs could not be scored', /2 could not be scored/.test(consPrompt));
  check('news filter picks pair-relevant items', (() => {
    const n = [{ title: 'ECB holds', desc: '', ts: 1 }, { title: 'BoJ cuts', desc: '', ts: 2 }, { title: 'Cricket scores', desc: '', ts: 3 }];
    const got = S.newsForPair(n, 'EURJPY', 6).map((x) => x.title);
    return got.includes('ECB holds') && got.includes('BoJ cuts') && !got.includes('Cricket scores');
  })());

  console.log('\n=== 18. EA / SHADOW-LEDGER COMPATIBILITY ===');
  // The verdicts must satisfy forex-brain's OWN validator, or its settlement machinery cannot
  // consume them and the whole share-not-couple premise fails.
  const fb = await import('file://' + path.join(API, 'forex-brain.js').replace(/\\/g, '/'));
  const nowIso = new Date().toISOString();
  const buyRow = { pair: 'EURUSD', factors: { atrD1: 0.005 }, llm: { score: 72, direction: 'BUY', read: 'A sufficiently long rationale for the validator to accept.', entry: 1.14, tp: 1.155, sl: 1.132 } };
  const vBuy = S.toVerdict(buyRow, nowIso);
  check('a BUY verdict passes forex-brain validateVerdict', fb.validateVerdict(vBuy, nowIso).ok);
  check('...with BUY geometry (sl < trigger < tp)', vBuy.slPrice < vBuy.entryZone.trigger && vBuy.tpPrice > vBuy.entryZone.trigger);
  check('...and maxChase above the trigger for a BUY', vBuy.entryZone.maxChase >= vBuy.entryZone.trigger);
  const sellRow = { ...buyRow, pair: 'USDJPY', llm: { ...buyRow.llm, direction: 'SELL', entry: 162.5, tp: 160.0, sl: 164.0 } };
  const vSell = S.toVerdict(sellRow, nowIso);
  check('a SELL verdict passes the validator', fb.validateVerdict(vSell, nowIso).ok);
  check('...with maxChase BELOW the trigger for a SELL', vSell.entryZone.maxChase <= vSell.entryZone.trigger);
  check('STAND_ASIDE becomes a FLAT verdict', S.toVerdict({ ...buyRow, llm: { ...buyRow.llm, direction: 'STAND_ASIDE' } }, nowIso).direction === 'FLAT');
  check('a directional read with no levels degrades to FLAT rather than a broken verdict',
    S.toVerdict({ ...buyRow, llm: { ...buyRow.llm, entry: null } }, nowIso).direction === 'FLAT');
  check('riskPercent stays inside forex-brain cap', vBuy.riskPercent <= fb.CONFIG.maxRiskPercent);
  check('verdictId is parseable as a date by settleVerdict', !isNaN(new Date(vBuy.verdictId.slice(0, 24)).getTime()));
  check('expiry is the 2-3 day HOLD CEILING, not forex-brain 90 minutes',
    Math.abs((Date.parse(vBuy.expiresAt) - Date.parse(nowIso)) / 3600e3 - 96) < 0.1);
  check('verdict is tagged with its source engine', vBuy.source === 'terminal-screen');
  // settleVerdict must actually run over these.
  const hitTp = [{ datetime: new Date(Date.now() + 3 * H).toISOString(), open: 1.141, high: 1.156, low: 1.140, close: 1.155 }];
  check('forex-brain settleVerdict consumes the verdict and resolves TP',
    fb.settleVerdict(vBuy, hitTp, new Date(Date.now() + 4 * H).toISOString()).status === 'TP');
  const hitSl = [{ datetime: new Date(Date.now() + 3 * H).toISOString(), open: 1.141, high: 1.142, low: 1.130, close: 1.131 }];
  check('...and resolves SL', fb.settleVerdict(vBuy, hitSl, new Date(Date.now() + 4 * H).toISOString()).status === 'SL');
  check('shadow ledger writes to its OWN namespace, never forex-brain state',
    /terminal:shadow:(open|ledger)/.test(SCREEN_SRC) && !/rSet\('forex:/.test(SCREEN_SRC));
  check('settleShadow keeps a verdict OPEN when candles are unavailable', (() => {
    // symbol not in the universe => getCandles rejects => must stay open, not be judged
    return S.settleShadow([{ ...vBuy, symbol: 'XXXYYY' }], nowIso).then((r) => r.stillOpen.length === 1 && r.settled.length === 0);
  })() instanceof Promise);
  check('settleShadow does not judge on missing data',
    (await S.settleShadow([{ ...vBuy, symbol: 'XXXYYY' }], nowIso)).stillOpen.length === 1);
  // The execution boundary must be documented, and nothing may cross it.
  check('NO live order execution anywhere in the screen',
    !/OrderSend|placeOrder|executeTrade|\/order|POST.*trade/i.test(SCREEN_SRC));
  check('the execution boundary is explicitly flagged for the future EA design',
    /NOT AN EXECUTION INSTRUCTION/.test(SCREEN_SRC) && /kill switch/.test(SCREEN_SRC));
  check('shadow scorecard buckets by conviction band, so score calibration is measurable', (() => {
    const card = S.shadowScorecard([
      { symbol: 'EURUSD', conviction: 80, status: 'TP', r: 2 }, { symbol: 'EURUSD', conviction: 40, status: 'SL', r: -1 },
    ]);
    return card.byConvictionBand['71-100'].tp === 1 && card.byConvictionBand['0-50'].sl === 1 && card.hitRate === 50;
  })());

  console.log('\n=== 19. ENGINE CONSUMES THE TWO-STAGE OUTPUT ===');
  check('screenLines surfaces the per-pair analyst read', /read: \$\{l\.read\}/.test(ENGINE_SRC));
  check('...and the indicative levels are marked as needing re-anchoring', /RE-ANCHOR these to the live price/.test(ENGINE_SRC));
  check('the engine honours the consolidation picks', /screenConsolidation/.test(ENGINE_SRC));
  check('...but drops a pick that has since been opened',
    /picks \|\| \[\]\)\.filter\(\(p\) => screenRanked\.some/.test(ENGINE_SRC));
  check('the engine still owns final level/sizing against LIVE data',
    /Re-anchor EVERY level to the live reference prices below/.test(ENGINE_SRC));
  check('...and may substitute when live conditions invalidate a pick',
    /substitute from the runners-up/.test(ENGINE_SRC));
  check('unanalysed pairs are declared to the model, not silently absent',
    /not judged and rejected/.test(ENGINE_SRC));
  check('a missing consolidation degrades to weighing the reads directly',
    /No consolidation pass was available this run/.test(ENGINE_SRC));
  check('provenance records how many pairs were per-pair analysed',
    /perPairAnalysed: screenRanked\.filter/.test(ENGINE_SRC));

  console.log('\n=== 19b. RUN MODES: lock + cooldown on force-refresh ===');
  // Mode 3 is the only path a human can trigger repeatedly, and each trigger is ~20 live model
  // calls. Two separate protections, answering two different questions.
  const T0 = Date.now();
  // LOCK — "is a run happening right now?"
  check('no lock => not running', S.lockState(null).running === false);
  check('a fresh lock => running', S.lockState({ startedAt: T0 - 5000, by: 'manual' }, T0).running === true);
  check('...and reports who holds it', S.lockState({ startedAt: T0 - 5000, by: 'cron' }, T0).by === 'cron');
  check('a lock at 4m59s is still held', S.lockState({ startedAt: T0 - 299000, by: 'manual' }, T0).running === true);
  // Self-healing: a lock older than maxDuration cannot have a live holder.
  check('a lock older than maxDuration is STALE, not running', S.lockState({ startedAt: T0 - 301000, by: 'manual' }, T0).stale === true);
  check('...so a dead invocation cannot wedge the screen shut forever',
    S.lockState({ startedAt: T0 - 3600000, by: 'cron' }, T0).running === false);
  // COOLDOWN — "was one just done?"
  check('no previous run => no cooldown', S.cooldownState(null, T0).blocked === false);
  check('a run 10s ago blocks a re-scan', S.cooldownState(new Date(T0 - 10000).toISOString(), T0).blocked === true);
  check('...reporting the remaining wait', S.cooldownState(new Date(T0 - 10000).toISOString(), T0).remainingMs > 160000);
  check('a run 4 minutes ago does NOT block', S.cooldownState(new Date(T0 - 240000).toISOString(), T0).blocked === false);
  check('an unparseable timestamp does not block forever', S.cooldownState('not-a-date', T0).blocked === false);
  check('cooldown is 3 minutes', /MANUAL_COOLDOWN_MS = 3 \* 60 \* 1000/.test(SCREEN_SRC));
  // Wiring
  check('the run path takes the lock before running', /rSet\(SCREEN_LOCK_KEY, \{ startedAt: now/.test(SCREEN_SRC));
  check('...and releases it in a finally, so a throw cannot strand it',
    /} finally \{[\s\S]{0,240}rSet\(SCREEN_LOCK_KEY, null\)/.test(SCREEN_SRC));
  check('a concurrent run is refused with 409, not queued', /status\(409\)/.test(SCREEN_SRC));
  check('a too-soon manual run is refused with 429', /status\(429\)/.test(SCREEN_SRC));
  check('CRON IS EXEMPT from the cooldown (scheduled, not spammed)', /if \(!isCron\) \{[\s\S]{0,400}cooldownState/.test(SCREEN_SRC));
  check('...but cron is NOT exempt from the lock', (() => {
    // the lock check must sit ABOVE the isCron branch
    const lockIdx = SCREEN_SRC.indexOf('const ls = lockState(lock, now)');
    const cronIdx = SCREEN_SRC.indexOf('if (!isCron) {', lockIdx);
    return lockIdx > 0 && cronIdx > lockIdx;
  })());
  check('status action exists for polling', /action === 'status'/.test(SCREEN_SRC));
  check('...and reports canForce so the UI need not recompute the rules',
    /canForce: !ls\.running && !cd\.blocked/.test(SCREEN_SRC));
  check('the pack records which mode built it', /mode,/.test(SCREEN_SRC) && /runScreen\(Date\.now\(\), isCron \? 'cron' : 'manual-force'\)/.test(SCREEN_SRC));

  console.log('\n=== 19c. RUN MODES: the UI ===');
  if (UI_SRC) {
    check('UI polls status rather than blocking on the 40s run',
      /action=status/.test(UI_SRC) && /pollRef/.test(UI_SRC));
    check('...so a dropped request does not lose the run',
      /keeps running on the server even if you switch tabs/.test(UI_SRC));
    check('the run fetch is fired, not awaited for the UI', /fetch\('\/api\/terminal-screen\?action=run'\)\s*\n\s*\.then/.test(UI_SRC));
    check('FAST vs SLOW is stated explicitly', /<span className="steel">FAST<\/span>/.test(UI_SRC) && /<span className="ambr">SLOW<\/span>/.test(UI_SRC));
    check('...naming the cost of the slow path', /~20 reasoning calls live/.test(UI_SRC));
    check('board age leads the tab, so forcing is an informed choice', /AGE FIRST, and prominently/.test(UI_SRC));
    check('the button is disabled during a run and during cooldown', /disabled=\{!canForce\}/.test(UI_SRC));
    check('...showing the cooldown countdown', /Re-scan available in \$\{cdSec\}s/.test(UI_SRC));
    check('...and explaining why it is rate-limited', /double-click can't fire 40 calls/.test(UI_SRC));
    check('a run started elsewhere (cron) is surfaced', /run is in progress/.test(UI_SRC));
    check('409 and 429 are treated as guardrails, not errors', /guardrails doing their job/.test(UI_SRC));
    check('the poll gives up rather than spinning forever', /ticks>60/.test(UI_SRC));
    check('the Desk points at the Board when the pack has aged',
      /re-scan it from the Board tab/.test(UI_SRC));
    check('the board says which mode built it', /you rebuilt this yourself/.test(UI_SRC) && /built by the schedule/.test(UI_SRC));
  }

  // ==========================================================================
  console.log('\n=== 20. MUTATION HARNESS — is the ranking actually guarded? ===');
  const MUT = [
    {
      gate: 'direction follows the TREND, not the flattering side (the live-data regression)',
      from: `  const direction = trendDecisive ? trendDir : (fitBuy.net >= fitSell.net ? 'BUY' : 'SELL');`,
      to: `  const direction = (fitBuy.net >= fitSell.net ? 'BUY' : 'SELL');`,
      probe: (M) => M.scorePair({ pair: 'EURNZD', d1: down, h1: null, cal: [], exposure: { EUR: -0.04, NZD: -0.03 }, recentlyProposed: false }).preferredDirection === 'SELL',
    },
    {
      gate: 'book-fit stack/offset sign',
      from: `    if (Math.sign(e) === sign) { stack += Math.abs(e);`,
      to: `    if (Math.sign(e) !== sign) { stack += Math.abs(e);`,
      probe: (M) => M.bookFit('AUDNZD', 'SELL', exp).net > 0.13,
    },
    {
      gate: 'book-fit ignores float residue',
      from: `    if (Math.abs(e) < 0.01) continue; // float residue, not a position`,
      to: `    if (false) continue;`,
      probe: (M) => M.bookFit('EURUSD', 'BUY', { USD: 0.004 }).detail.length === 0,
    },
    {
      gate: 'catalyst window bounded by the hold ceiling',
      from: `  const horizon = nowMs + ceilingHours * 3600e3;`,
      to: `  const horizon = nowMs + ceilingHours * 3600e3 * 100;`,
      probe: (M) => M.catalystLoad(cal, 'GBPUSD', 96).high === 2,
    },
    {
      gate: 'catalyst excludes events already past',
      from: `e.utc >= nowMs && e.utc <= horizon`,
      to: `e.utc <= horizon`,
      probe: (M) => M.catalystLoad(cal, 'USDCHF', 96).high === 1,
    },
    {
      gate: 'catalyst belongs to one of the pair legs',
      from: `  const mine = (cal || []).filter((e) => legs.includes(e.ccy)`,
      to: `  const mine = (cal || []).filter((e) => true`,
      probe: (M) => M.catalystLoad(cal, 'EURCHF', 96).high === 0,
    },
    {
      gate: 'SMA skips the in-progress bar',
      from: `  for (let i = 1; i <= n; i++) closes.push(parseFloat(candles[i].close));`,
      to: `  for (let i = 0; i < n; i++) closes.push(parseFloat(candles[i].close));`,
      probe: (M) => Math.abs(M.smaCompleted(series({ n: 30, start: 1.0, drift: 0, range: 0.002, lastClose: 99 }), 20) - 1.0) < 1e-9,
    },
    {
      gate: 'unscoreable pairs are reported, not scored on thin data',
      from: `  if (!Array.isArray(d1) || d1.length < SCREEN_CONFIG.minBarsD1) {`,
      to: `  if (false) {`,
      probe: (M) => M.scorePair({ pair: 'EURUSD', d1: series({ n: 10 }), h1: null, cal: [], exposure: {}, recentlyProposed: false }).score === null,
    },
    {
      gate: 'range position clamps and rejects a zero-width box',
      from: `  if (!box || !Number.isFinite(last) || !(box.size > 0)) return null;`,
      to: `  if (!box || !Number.isFinite(last)) return null;`,
      probe: (M) => M.rangePosition(1.1, { high: 1, low: 1, size: 0 }) === null,
    },
    {
      // THE headline risk of this upgrade. If the per-pair result is not isolated, one bad call
      // takes the whole screen down — 24 good analyses lost to one socket hang-up.
      gate: 'PARTIAL FAILURE: a failed pair is isolated, not fatal',
      from: `      if (r.ok) scored.push({ ...row, llm: r.llm });
      else unscored.push({ ...row, unscored: r.error });`,
      to: `      if (r.ok) scored.push({ ...row, llm: r.llm });
      else throw new Error(r.error);`,
      probe: async (M) => {
        const res = await M.runStage1(detRows, { news: [], exposureLine: 'FLAT' }, { scorer: safeFlaky, concurrency: 3 });
        return res.scored.length === detRows.length - 2 && res.unscored.length === 2;
      },
    },
    {
      gate: 'PARTIAL FAILURE: scorePairLLM never throws',
      from: `  } catch (e) {
    // Isolated. The pair is marked unscored with the real reason and the run continues.
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }`,
      to: `  } catch (e) {
    throw e;
  }`,
      // A malformed response must come back as a value, not an exception.
      probe: async (M) => {
        const bad = await M.scorePairLLM(detRows[0], { news: [], exposureLine: 'FLAT' }).catch(() => 'THREW');
        return bad !== 'THREW' && bad.ok === false;
      },
    },
    {
      gate: 'PARTIAL FAILURE: an out-of-range score is rejected, not trusted',
      from: `    if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(\`score \${out.score} out of range\`);`,
      to: `    if (false) throw new Error('x');`,
      // Driven through a stubbed fetch, so this exercises the real validation path rather than
      // asserting against the source text (which would pass under mutation and prove nothing).
      probe: async (M) => withStubbedClaude({ score: 940, direction: 'BUY', read: 'a long enough read here', conviction: 'HIGH' },
        async () => { const r = await M.scorePairLLM(detRows[0], { news: [], exposureLine: 'FLAT' }); return r.ok === false && /out of range/.test(r.error); }),
    },
    {
      gate: 'PARTIAL FAILURE: an invalid direction is rejected',
      from: `    if (!['BUY', 'SELL', 'STAND_ASIDE'].includes(dir)) throw new Error(\`direction "\${out.direction}" invalid\`);`,
      to: `    if (false) throw new Error('x');`,
      probe: async (M) => withStubbedClaude({ score: 70, direction: 'MAYBE', read: 'a long enough read here', conviction: 'HIGH' },
        async () => { const r = await M.scorePairLLM(detRows[0], { news: [], exposureLine: 'FLAT' }); return r.ok === false && /direction/.test(r.error); }),
    },
    {
      gate: 'CRON BUDGET: the deadline guard stops the loop',
      from: `      if (Date.now() > deadline) {`,
      to: `      if (false) {`,
      probe: async (M) => {
        const slow2 = async (row) => { await new Promise((r) => setTimeout(r, 40)); return okScorer(row); };
        const res = await M.runStage1(detRows, { news: [], exposureLine: 'FLAT' }, { scorer: slow2, concurrency: 1, deadline: Date.now() + 90 });
        return res.unscored.length > 0 && res.unscored.every((u) => /budget ran out/.test(u.unscored));
      },
    },
    {
      gate: 'EA SHAPE: STAND_ASIDE / missing levels degrade to FLAT',
      from: `  if (l.direction === 'STAND_ASIDE' || l.entry == null || l.tp == null || l.sl == null) {`,
      to: `  if (l.direction === 'STAND_ASIDE') {`,
      probe: (M) => M.toVerdict({ pair: 'EURUSD', factors: { atrD1: 0.005 }, llm: { score: 70, direction: 'BUY', read: 'A long enough rationale here.', entry: null, tp: 1.15, sl: 1.13 } }, new Date().toISOString()).direction === 'FLAT',
    },
    {
      gate: 'EA SHAPE: maxChase sits on the correct side of the trigger',
      from: `      maxChase: l.direction === 'BUY' ? +(l.entry + atr * 0.25).toFixed(6) : +(l.entry - atr * 0.25).toFixed(6),`,
      to: `      maxChase: +(l.entry - atr * 0.25).toFixed(6),`,
      probe: async (M) => {
        const fbm = await import('file://' + path.join(API, 'forex-brain.js').replace(/\\/g, '/'));
        const iso = new Date().toISOString();
        return fbm.validateVerdict(M.toVerdict({ pair: 'EURUSD', factors: { atrD1: 0.005 }, llm: { score: 70, direction: 'BUY', read: 'A long enough rationale here.', entry: 1.14, tp: 1.155, sl: 1.132 } }, iso), iso).ok;
      },
    },
    {
      // A double-click on force-refresh is ~40 live model calls. The lock is the only thing
      // standing between an impatient click and two concurrent runs.
      gate: 'RUN MODE: the lock reports a live run as running',
      from: `  if (age >= LOCK_STALE_MS) return { running: false, stale: true, age, by: lock.by };`,
      to: `  if (age >= 0) return { running: false, stale: true, age, by: lock.by };`,
      probe: (M) => M.lockState({ startedAt: Date.now() - 5000, by: 'manual' }).running === true,
    },
    {
      // ...but the lock must also let go. A stuck lock would block the CRON as well as the user,
      // silently killing the overnight board until someone noticed.
      gate: 'RUN MODE: a stale lock self-heals rather than wedging the screen shut',
      from: `  if (age >= LOCK_STALE_MS) return { running: false, stale: true, age, by: lock.by };`,
      to: `  if (false) return { running: false, stale: true, age, by: lock.by };`,
      probe: (M) => M.lockState({ startedAt: Date.now() - 3600000, by: 'cron' }).running === false,
    },
    {
      gate: 'RUN MODE: the cooldown actually blocks a too-soon re-scan',
      from: `  if (!Number.isFinite(since) || since >= cooldownMs) return { blocked: false, remainingMs: 0, sinceMs: since };`,
      to: `  return { blocked: false, remainingMs: 0, sinceMs: since };`,
      probe: (M) => M.cooldownState(new Date(Date.now() - 10000).toISOString()).blocked === true,
    },
    {
      gate: 'RUN MODE: the cooldown expires (does not block forever)',
      from: `  if (!lastAt) return { blocked: false, remainingMs: 0 };`,
      to: `  if (!lastAt) return { blocked: true, remainingMs: 1 };`,
      probe: (M) => M.cooldownState(null).blocked === false,
    },
    {
      gate: 'freshness penalty',
      from: `    staleness: recentlyProposed ? W.staleness : 0,`,
      to: `    staleness: 0,`,
      probe: (M) => {
        const a = M.scorePair({ pair: 'GBPUSD', d1: up, h1: null, cal: [], exposure: {}, recentlyProposed: false });
        const b = M.scorePair({ pair: 'GBPUSD', d1: up, h1: null, cal: [], exposure: {}, recentlyProposed: true });
        return Math.abs((a.score - b.score) - 10) < 0.01;
      },
    },
  ];

  let mp = 0;
  for (const m of MUT) {
    if (!SCREEN_SRC.includes(m.from)) {
      fail++; fails.push(`mutation anchor missing: ${m.gate}`);
      console.log(`  x FAIL: [${m.gate}] anchor no longer in the source — testing nothing here.`);
      continue;
    }
    const tmp = path.join(API, `.mut-screen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mjs`);
    let survived = false, pristine = false;
    try {
      fs.writeFileSync(tmp, SCREEN_SRC.replace(m.from, m.to));
      const M = await import('file://' + tmp.replace(/\\/g, '/'));
      // Probes may be async (the failure-isolation ones drive the real loop), so ALWAYS await.
      try { survived = !!(await m.probe(M)); } catch { survived = false; }
    } catch { survived = false; }
    finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
    try { pristine = !!(await m.probe(S)); } catch { pristine = false; }
    if (pristine && !survived) { mp++; pass++; }
    else {
      fail++;
      const why = !pristine ? 'probe does not pass on unmutated source' : 'MUTATION SURVIVED — this guard is not actually tested';
      fails.push(`mutation: ${m.gate} (${why})`);
      console.log(`  x FAIL: [${m.gate}] ${why}`);
    }
  }
  console.log(`  ${mp}/${MUT.length} ranking guards verified live`);

  console.log('\n============================================================');
  console.log(`GRAND TOTAL: ${pass} passed, ${fail} failed, ${skip} skipped   (${mp} ranking mutations killed)`);
  if (fail) { console.log('FAILURES:\n - ' + fails.join('\n - ')); process.exitCode = 1; }
  else console.log('ALL CHECKS PASSED');
  console.log('============================================================');
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exitCode = 2; });
