// ============================================================================
// THE EXCHANGE — hunt discipline suite: real convergence + a HARD one-week window, enforced
// in CODE and enforced equally for SHORTS.
// Re-run any time with:  node tests/test_exchange_hunt.js
//
// Hammy holds NO position longer than a week. The hunt must only surface what fits:
//   (a) PROPER CONVERGENCE — >=2 genuine independent signals; a single source never clears.
//   (b) a catalyst that resolves INSIDE the one-week window (dated, verified where possible).
//   (c) target geometry reachable within a week.
// All three must hold for a SHORT thesis exactly as for a long.
//
// These gates run in CODE after the model responds (applyConvergenceCap, catalystCheck,
// checkLevels, ideaQualifies), so they cannot be dodged by what the model writes. This suite
// drives those real exported functions.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}
const TODAY = '2026-07-22';

(async () => {
  let E, N;
  try { E = await import('../api/exchange-engine.js'); N = await import('../api/exchange-news.js'); }
  catch (e) { console.error('Could not import modules:', e.message); process.exit(2); }
  const { applyConvergenceCap, ideaQualifies, catalystCheck, checkLevels } = E;
  const { nameMatchesStory } = N;
  for (const [n, f] of Object.entries({ applyConvergenceCap, ideaQualifies, catalystCheck, checkLevels, nameMatchesStory })) {
    if (typeof f !== 'function') { console.error(`Required export "${n}" missing. Hard stop.`); process.exit(3); }
  }

  // ---------------------------------------------------------------------------
  console.log('=== 1. CONVERGENCE is real, not coincidental ===');
  // The matcher that COUNTS convergence must not credit a coincidental word.
  check('"China Life" is NOT convergence from a "china" market headline',
    nameMatchesStory('China Life', 'China stocks slide as Shanghai declines') === false);
  check('"China Life" IS convergence from a story that names it',
    nameMatchesStory('China Life', 'China Life reports higher premium income') === true);
  check('a 3-letter ticker fragment does not count', nameMatchesStory('ENN Energy', 'the new energy policy passed') === false);

  console.log('=== 1b. SINGLE SOURCE can never clear the gate (mutation) ===');
  const cap = (conv, hits, ok = true) => { const i = { conviction: conv }; applyConvergenceCap(i, hits, ok); return i.conviction; };
  check('HIGH + 2 genuine hits => stays HIGH', cap('HIGH', 2) === 'HIGH');
  check('HIGH + 1 hit => capped to MED', cap('HIGH', 1) === 'MED');
  check('HIGH + 0 hits => capped to LOW', cap('HIGH', 0) === 'LOW');
  check('MED-HIGH + 1 hit => capped to MED', cap('MED-HIGH', 1) === 'MED');
  check('MED-HIGH + 0 hits => capped to LOW', cap('MED-HIGH', 0) === 'LOW');
  check('MED-HIGH + 2 hits => stays MED-HIGH', cap('MED-HIGH', 2) === 'MED-HIGH');
  check('MED is not inflated by many hits', cap('MED', 9) === 'MED');
  check('LOW is not inflated by many hits', cap('LOW', 9) === 'LOW');
  // one genuine mention is a single source, and a single source must not qualify
  check('a single-source idea (1 hit) does not qualify', (() => {
    const i = { conviction: 'HIGH', current_price: '100', entry: '99-100', tp: '105', sl: '96' };
    applyConvergenceCap(i, 1, true);
    return ideaQualifies(i) === false;
  })());
  check('a converged idea (2 hits) can qualify', (() => {
    const i = { conviction: 'HIGH', current_price: '100', entry: '99-100', tp: '105', sl: '96' };
    applyConvergenceCap(i, 2, true);
    return ideaQualifies(i) === true;
  })());
  // a failed news fetch must not silently pass a top-conviction claim through
  check('news-check failure caps a HIGH claim (does not trust it)', cap('HIGH', 0, false) !== 'HIGH');

  console.log('=== 2. THE ONE-WEEK CATALYST WINDOW, enforced for BOTH directions ===');
  const cat = (d, dir = 'BUY', type = 'EARNINGS') => ({ direction: dir, catalyst: 'Q2 results with fresh guidance', catalyst_date: d, catalyst_type: type });
  for (const dir of ['BUY', 'SELL']) {
    check(`${dir}: catalyst in 2 days => OK`, catalystCheck(cat('2026-07-24', dir), null, TODAY).ok === true);
    check(`${dir}: catalyst in 7 days => OK (edge)`, catalystCheck(cat('2026-07-29', dir), null, TODAY).ok === true);
    check(`${dir}: catalyst in 8 days => REJECTED`, catalystCheck(cat('2026-07-30', dir), null, TODAY).ok === false);
    check(`${dir}: catalyst 3 weeks out => REJECTED`, catalystCheck(cat('2026-08-12', dir), null, TODAY).ok === false);
    check(`${dir}: catalyst yesterday => OK (underway)`, catalystCheck(cat('2026-07-21', dir), null, TODAY).ok === true);
    check(`${dir}: undated catalyst => REJECTED`, catalystCheck(cat('', dir), null, TODAY).ok === false);
  }
  // the SHORT-specific worry: a short thesis that needs months must be rejected the same way
  check('SHORT months-out thesis is rejected exactly like a long', catalystCheck(cat('2026-10-01', 'SELL'), null, TODAY).ok === false);
  // the verified calendar date overrides a mislabelled near date, both directions
  check('SELL: calendar 3wk out overrides a claimed near date', catalystCheck(cat('2026-07-24', 'SELL'), { date: '2026-08-14' }, TODAY).ok === false);

  console.log('=== 3. GEOMETRY reachable within a week — SHORTS too ===');
  // SHORT entry 100: target BELOW, stop ABOVE. A quiet name (weekly vol ~2.7%) caps the target.
  const shortQuiet = { direction: 'SELL', current_price: '100', entry: '100-101', tp: '80', sl: '104' };
  check('SHORT 20% target on a quiet name => REJECTED as multi-month', checkLevels(shortQuiet, 100, { weeklyVolPct: 2.7 }).ok === false);
  const shortOk = { direction: 'SELL', current_price: '100', entry: '100-101', tp: '95', sl: '104' };
  check('SHORT ~5% target on a quiet name => OK', checkLevels(shortOk, 100, { weeklyVolPct: 2.7 }).ok === true);
  // the same 10% target: fine on a lively name, not on a quiet one — for a short as for a long
  const short10 = { direction: 'SELL', current_price: '100', entry: '100-101', tp: '90', sl: '104' };
  check('SHORT 10% target on a quiet name => REJECTED', checkLevels(short10, 100, { weeklyVolPct: 2.7 }).ok === false);
  check('SHORT 10% target on a lively name => OK', checkLevels(short10, 100, { weeklyVolPct: 6.5 }).ok === true);
  // wrong-side geometry for a short must fail (target above entry)
  const shortBad = { direction: 'SELL', current_price: '100', entry: '100-101', tp: '108', sl: '104' };
  check('SHORT with target ABOVE entry => REJECTED (wrong side)', checkLevels(shortBad, 100, { weeklyVolPct: 5 }).ok === false);

  console.log('=== 4. THE GATES COMPOSE: a short only qualifies when all three hold ===');
  // Build a short that passes convergence, catalyst window, and geometry.
  const goodShort = { direction: 'SELL', conviction: 'HIGH', current_price: '100', entry: '100-101', tp: '95', sl: '104',
    catalyst: 'Q2 miss expected, guidance cut', catalyst_date: '2026-07-24', catalyst_type: 'EARNINGS' };
  applyConvergenceCap(goodShort, 2, true);
  const gLevels = checkLevels(goodShort, 100, { weeklyVolPct: 2.7 });
  const gCat = catalystCheck(goodShort, null, TODAY);
  check('good short: convergence kept at HIGH', goodShort.conviction === 'HIGH');
  check('good short: catalyst in window', gCat.ok === true);
  check('good short: geometry ok', gLevels.ok === true);
  check('good short: qualifies', ideaQualifies(goodShort) === true);
  // break each leg in turn — qualification/validity must fail
  check('break convergence (1 hit) => no longer qualifies', (() => { const i = { ...goodShort, conviction: 'HIGH' }; applyConvergenceCap(i, 1, true); return ideaQualifies(i) === false; })());
  check('break catalyst (months out) => catalyst check fails', catalystCheck({ ...goodShort, catalyst_date: '2026-10-01' }, null, TODAY).ok === false);
  check('break geometry (30% target) => levels fail', checkLevels({ ...goodShort, tp: '70' }, 100, { weeklyVolPct: 2.7 }).ok === false);

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
