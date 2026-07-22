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
    /import \{ computeBox, computeAtr \} from '\.\/forex-brain\.js'/.test(SCREEN_SRC));
  check('no import cycle: engine never imports the screen',
    !/from '\.\/terminal-screen\.js'/.test(ENGINE_SRC));

  console.log('\n=== 12. OPERATIONAL ===');
  check('screen declares maxDuration 300', /export const config = \{ maxDuration: 300 \}/.test(SCREEN_SRC));
  check('screen calls no model — it is deterministic', !/anthropic|claude|max_tokens/i.test(SCREEN_SRC));
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

  // ==========================================================================
  console.log('\n=== 14. MUTATION HARNESS — is the ranking actually guarded? ===');
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
      try { survived = !!m.probe(M); } catch { survived = false; }
    } catch { survived = false; }
    finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
    try { pristine = !!m.probe(S); } catch { pristine = false; }
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
