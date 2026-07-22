// ============================================================================
// THE EXCHANGE — horizon suite. Guards the ≤1-week discipline.
// Re-run any time with:  node tests/test_exchange_horizon.js
//
// THE PROBLEM THIS EXISTS FOR (22/07/2026). The user holds nothing longer than a week,
// but only the LABEL was ever enforced:
//
//   1. The hunt prompt demanded a one-week horizon while rule 4 asked for "genuine STEALS,
//      cheap-versus-worth" and rule 6 counted "Value & fundamentals" toward conviction.
//      A value + technical convergence scored MED-HIGH with nothing to move it for months.
//      The cached Sony idea was labelled "4-6 day trade" over a sum-of-parts re-rating.
//   2. "horizon" was free text nothing validated, and no idea carried a catalyst DATE, so
//      an earnings release three weeks out could sit behind a five-day trade.
//   3. checkLevels bounded the stop (2-15%) but put NO ceiling on the target, so a 40%
//      take-profit passed whenever the stop was wide enough to keep R:R above 1.
//   4. Once taken, actReview called every position a "long-term conviction" to be judged
//      "with patience", so a five-day swing became an open-ended hold and daysHeld — which
//      was printed in the prompt — was never acted on.
//
// Drives the REAL exported gates, not reimplementations. Offline and deterministic:
// every date is fixed, so this suite does not drift with the calendar.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}
const TODAY = '2026-07-22';

(async () => {
  let E, N;
  try {
    E = await import('../api/exchange-engine.js');
    N = await import('../api/exchange-news.js');
  } catch (e) {
    console.error('Could not import the exchange modules:', e.message);
    process.exit(2);
  }
  const { checkLevels, recomputeLevels, tpCeiling, catalystCheck, horizonStatus, addDays } = E;
  for (const [n, f] of Object.entries({ checkLevels, recomputeLevels, tpCeiling, catalystCheck, horizonStatus, addDays })) {
    if (typeof f !== 'function') {
      console.error(`Required export "${n}" is missing — these checks would be testing nothing. Hard stop.`);
      process.exit(3);
    }
  }

  // ---------------------------------------------------------------------------
  console.log('=== 1. TARGET CEILING scales to the name, and is never absent ===');
  check('unmeasured falls back to a cap, not to unlimited', tpCeiling(null).pct === 12);
  check('unmeasured cap is stated as such', /no volatility/.test(tpCeiling(null).basis));
  check('quiet name (2.66% wk) capped near 6.7%', Math.abs(tpCeiling(2.66).pct - 6.7) < 0.05);
  check('livelier name (6.49% wk) capped near 16.2%', Math.abs(tpCeiling(6.49).pct - 16.2) < 0.05);
  check('a quiet name gets a LOWER cap than a lively one', tpCeiling(2.66).pct < tpCeiling(6.49).pct);
  check('hard ceiling at 20% however wild', tpCeiling(50).pct === 20);
  check('floor at 4% however quiet', tpCeiling(0.2).pct === 4);
  for (const junk of [undefined, NaN, -3, 0, 'abc', {}]) {
    check(`junk vol (${JSON.stringify(junk)}) still yields a finite cap`, tpCeiling(junk).pct === 12);
  }

  console.log('=== 2. MUTATION: the 40% fantasy target must die ===');
  // Sized on a real name: SIA moves ~2.66% in a week, so its cap is ~6.7%.
  const base = { direction: 'BUY', current_price: '100', entry: '99-100' };
  const at = (tp, sl) => ({ ...base, tp: String(tp), sl: String(sl) });
  const vol = { weeklyVolPct: 2.66 };
  check('40% target REJECTED', checkLevels(at(140, 96), 100, vol).ok === false);
  check('...and says it is a multi-month target', /multi-month target/.test(checkLevels(at(140, 96), 100, vol).reason || ''));
  check('20% target REJECTED for a quiet name', checkLevels(at(120, 96), 100, vol).ok === false);
  check('10% target REJECTED for a quiet name', checkLevels(at(110, 96), 100, vol).ok === false);
  check('5% target ACCEPTED for a quiet name', checkLevels(at(105, 96), 100, vol).ok === true);
  // the SAME 10% target on a livelier name is fine — the whole point of scaling
  check('10% target ACCEPTED for a lively name', checkLevels(at(110, 96), 100, { weeklyVolPct: 6.49 }).ok === true);
  check('same levels, different name, different verdict',
    checkLevels(at(110, 96), 100, vol).ok === false && checkLevels(at(110, 96), 100, { weeklyVolPct: 6.49 }).ok === true);
  // the pre-fix hole: a wide stop used to buy an unlimited target via R:R
  check('wide stop can no longer buy a huge target', checkLevels(at(140, 87), 100, vol).ok === false);
  // with no vol reading at all the 12% fallback still bites
  check('40% target rejected even with NO vol reading', checkLevels(at(140, 96), 100, {}).ok === false);
  check('...and 5% still passes with no vol reading', checkLevels(at(105, 96), 100, {}).ok === true);
  // SELL side must be bounded identically
  const sell = { direction: 'SELL', current_price: '100', entry: '100-101', tp: '60', sl: '104' };
  check('SELL 40% target rejected too', checkLevels(sell, 100, vol).ok === false);

  console.log('=== 3. RECOMPUTED LEVELS must pass the gate they feed ===');
  // A recompute that produced levels its own validator rejects would loop forever.
  for (const v of [null, 1.0, 2.66, 3.38, 5.34, 6.49, 15]) {
    for (const dir of ['BUY', 'SELL']) {
      const rl = recomputeLevels({ direction: dir }, 100, v);
      check(`recompute ${dir} @vol=${v} yields levels`, !!rl);
      const verdict = checkLevels({ direction: dir, current_price: '100', ...rl }, 100, { weeklyVolPct: v });
      check(`recompute ${dir} @vol=${v} PASSES checkLevels`, verdict.ok === true);
    }
  }

  console.log('=== 4. CATALYST GATE: dated, and inside the window ===');
  const cat = (d, extra = {}) => ({ catalyst: 'Q2 results with fresh guidance', catalyst_date: d, catalyst_type: 'EARNINGS', ...extra });
  check('lands in 2 days ACCEPTED', catalystCheck(cat('2026-07-24'), null, TODAY).ok === true);
  check('lands today ACCEPTED', catalystCheck(cat('2026-07-22'), null, TODAY).ok === true);
  check('lands in 7 days ACCEPTED (window edge)', catalystCheck(cat('2026-07-29'), null, TODAY).ok === true);
  check('lands in 8 days REJECTED (just outside)', catalystCheck(cat('2026-07-30'), null, TODAY).ok === false);
  check('THREE WEEKS OUT rejected', catalystCheck(cat('2026-08-12'), null, TODAY).ok === false);
  check('...and says he would be closed before it', /outside a one-week hold/.test(catalystCheck(cat('2026-08-12'), null, TODAY).reason || ''));
  check('2 days ago ACCEPTED (already underway)', catalystCheck(cat('2026-07-20'), null, TODAY).ok === true);
  check('...described as underway', /underway/.test(catalystCheck(cat('2026-07-20'), null, TODAY).when || ''));
  check('5 days ago ACCEPTED (window edge)', catalystCheck(cat('2026-07-17'), null, TODAY).ok === true);
  check('6 days ago REJECTED as stale', catalystCheck(cat('2026-07-16'), null, TODAY).ok === false);

  console.log('=== 4b. MUTATION: no date, no trade ===');
  for (const [label, d] of [['empty', ''], ['null', null], ['undefined', undefined],
    ['garbage', 'not-a-date'], ['prose', 'next Tuesday'], ['wrong format', '22/07/2026'],
    ['partial', '2026-07'], ['number', 20260724]]) {
    check(`catalyst_date ${label} => REJECTED`, catalystCheck(cat(d), null, TODAY).ok === false);
  }
  check('missing catalyst TEXT rejected', catalystCheck({ catalyst_date: '2026-07-24' }, null, TODAY).ok === false);
  check('one-word catalyst rejected as unspecific', catalystCheck({ catalyst: 'cheap', catalyst_date: '2026-07-24' }, null, TODAY).ok === false);
  check('...naming the real problem', /no catalyst named/.test(catalystCheck({ catalyst: 'cheap', catalyst_date: '2026-07-24' }, null, TODAY).reason || ''));
  // The Sony shape: a genuine-sounding thesis with no dateable event.
  const sony = { catalyst: 'sum-of-the-parts re-rating as management unlocks value', catalyst_date: '', catalyst_type: 'VALUE' };
  check('THE SONY CASE: undated value re-rating rejected', catalystCheck(sony, null, TODAY).ok === false);

  console.log('=== 4c. The VERIFIED calendar date beats the model claim ===');
  const claimSoon = cat('2026-07-24');
  check('model says 2 days, calendar says 23 days => REJECTED',
    catalystCheck(claimSoon, { date: '2026-08-14' }, TODAY).ok === false);
  check('...and cites the calendar', /earnings calendar/.test(catalystCheck(claimSoon, { date: '2026-08-14' }, TODAY).reason || ''));
  check('model says 3 weeks, calendar says 3 days => ACCEPTED',
    catalystCheck(cat('2026-08-12'), { date: '2026-07-25' }, TODAY).ok === true);
  check('verified flag is set when the calendar spoke',
    catalystCheck(claimSoon, { date: '2026-07-24' }, TODAY).verified === true);
  check('verified flag is false when it did not',
    catalystCheck(claimSoon, null, TODAY).verified === false);
  check('a junk verified date does not override', catalystCheck(claimSoon, { date: 'soon' }, TODAY).ok === true);

  console.log('=== 5. TIME-STOP on taken swings, patience on long-term holds ===');
  const DAY = 86400000;
  const now = Date.parse('2026-07-22T00:00:00Z');
  const swing = (openedDaysAgo, planned) => ({
    isSwing: true, fromGem: true, horizonDays: planned, openedAt: now - openedDaysAgo * DAY,
  });
  check('day 2 of a 5-day swing: running', horizonStatus(swing(2, 5), now).overdue === false);
  check('...with days remaining', horizonStatus(swing(2, 5), now).remaining === 3);
  check('day 5 of a 5-day swing: DUE', horizonStatus(swing(5, 5), now).due === true);
  check('day 6 of a 5-day swing: OVERDUE', horizonStatus(swing(6, 5), now).overdue === true);
  check('...by one day', horizonStatus(swing(6, 5), now).remaining === -1);
  check('day 20 of a 5-day swing: badly overdue', horizonStatus(swing(20, 5), now).remaining === -15);
  // his seeded long-term book must NOT acquire a five-day clock
  check('a long-term holding is not a swing', horizonStatus({ openedAt: now - 200 * DAY }, now).isSwing === false);
  check('...and is never overdue', horizonStatus({ openedAt: now - 200 * DAY }, now).overdue === false);
  check('fromGem without a horizon is not clocked', horizonStatus({ fromGem: true, openedAt: now - 99 * DAY }, now).isSwing === false);
  check('missing openedAt does not crash', horizonStatus({ isSwing: true, horizonDays: 5 }, now).held === 0);

  console.log('=== 6. addDays underpins the window arithmetic ===');
  check('+7 days', addDays('2026-07-22', 7) === '2026-07-29');
  check('-5 days', addDays('2026-07-22', -5) === '2026-07-17');
  check('crosses a month end', addDays('2026-07-29', 7) === '2026-08-05');
  check('crosses a year end', addDays('2026-12-30', 7) === '2027-01-06');
  check('junk in, junk preserved (no crash)', addDays('nonsense', 7) === 'nonsense');

  console.log('=== 7. ASIAN COVERAGE is actually wired in ===');
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../api/exchange-news.js', import.meta.url), 'utf8'));
  for (const [label, needle] of [
    ['Business Times SG', 'businesstimes.com.sg'],
    ['Straits Times', 'straitstimes.com'],
    ['CNA', 'channelnewsasia.com'],
    ['SCMP', 'scmp.com'],
    ['Singapore locale', "ceid: 'SG:en'"],
    ['Hong Kong locale', "ceid: 'HK:en'"],
    ['Japan locale', "ceid: 'JP:en'"],
    ['Malaysia locale', "ceid: 'MY:en'"],
    ['China locale', "ceid: 'CN:en'"],
  ]) check(`${label} present in the wire`, src.includes(needle));
  check('Asian items are region-tagged for balancing', src.includes("'ASIA'"));
  check('the merge interleaves rather than truncating by recency', /region === 'ASIA'/.test(src));
  check('getNews is exported', typeof N.getNews === 'function');

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
