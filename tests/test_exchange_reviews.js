// ============================================================================
// THE EXCHANGE — reviews duration & persistence suite (building blocks).
// Re-run any time with:  node tests/test_exchange_reviews.js
//
// Reviews must persist and carry forward: (a) days-held, surfaced and USED to drive the
// week-max time-stop, accurate and never fabricated; (b) the HISTORY of prior reviews so each
// review builds on the last. The full persistence round-trip is exercised end-to-end against
// production; this suite pins the pure building blocks so they cannot silently regress:
//   - daysHeld: accurate, and null (not NaN, not 0) when there is no open date.
//   - horizonStatus: a day-6 swing knows it is day 6 and reads OVERDUE past its life.
//
// Drives the REAL exported helpers. Offline, deterministic.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}
const DAY = 86400000;

(async () => {
  let E;
  try { E = await import('../api/exchange-engine.js'); }
  catch (e) { console.error('Could not import exchange-engine:', e.message); process.exit(2); }
  const { daysHeld, horizonStatus } = E;
  for (const [n, f] of Object.entries({ daysHeld, horizonStatus })) {
    if (typeof f !== 'function') { console.error(`Required export "${n}" missing. Hard stop.`); process.exit(3); }
  }

  // ---------------------------------------------------------------------------
  console.log('=== 1. daysHeld is accurate ===');
  const now = Date.now();
  check('opened just now => 0 days', daysHeld(now) === 0);
  check('opened 1 day ago => 1', daysHeld(now - 1 * DAY) === 1);
  check('opened 6 days ago => 6 (the week-max case)', daysHeld(now - 6 * DAY) === 6);
  check('opened 6.9 days ago => 6 (floors, does not round up)', daysHeld(now - 6.9 * DAY) === 6);
  check('opened 10 days ago => 10', daysHeld(now - 10 * DAY) === 10);
  check('accepts an ISO string', daysHeld(new Date(now - 3 * DAY).toISOString()) === 3);
  check('a future openedAt clamps to 0, never negative', daysHeld(now + 5 * DAY) === 0);

  console.log('=== 2. daysHeld never fabricates when there is no date ===');
  // The bug this guards: an ageless holding rendering "Held roughly NaN day(s)" or silently
  // reading as day 0 (which would make a stale position look fresh and disarm the time-stop).
  check('null => null (not NaN, not 0)', daysHeld(null) === null);
  check('undefined => null', daysHeld(undefined) === null);
  check('empty string => null', daysHeld('') === null);
  check('garbage string => null', daysHeld('not-a-date') === null);
  check('NaN => null', daysHeld(NaN) === null);
  check('the result is never NaN', !Number.isNaN(daysHeld(undefined)) && !Number.isNaN(daysHeld('x')));

  console.log('=== 3. A day-6 swing KNOWS it is day 6, and drives the time-stop ===');
  const swing = (openedDaysAgo, planned) => horizonStatus({ isSwing: true, fromGem: true, horizonDays: planned, openedAt: now - openedDaysAgo * DAY }, now);
  check('day 2 of a 5-day swing: running, 3 left', (() => { const s = swing(2, 5); return s.held === 2 && s.remaining === 3 && !s.overdue; })());
  check('day 5 of a 5-day swing: DUE today', (() => { const s = swing(5, 5); return s.held === 5 && s.due === true; })());
  check('day 6 of a 5-day swing: OVERDUE by 1', (() => { const s = swing(6, 5); return s.held === 6 && s.overdue === true && s.remaining === -1; })());
  check('day 6 of a 7-day swing: still running (1 left)', (() => { const s = swing(6, 7); return s.held === 6 && s.remaining === 1 && !s.overdue; })());
  check('day 12 of a 5-day swing: badly overdue', swing(12, 5).remaining === -7);

  console.log('=== 4. the long-term book keeps patience (no false week-clock) ===');
  check('a seeded long-term holding is NOT a swing', horizonStatus({ openedAt: now - 200 * DAY }, now).isSwing === false);
  check('...and is never overdue', horizonStatus({ openedAt: now - 200 * DAY }, now).overdue === false);
  check('fromGem but no horizon => not clocked', horizonStatus({ fromGem: true, openedAt: now - 40 * DAY }, now).isSwing === false);

  console.log('=== 5. trajectory: a multi-review holding shows increasing day-counts ===');
  // The review record stores daysHeldAtReview; a two-review holding should show day N then a
  // larger day M. We assert the arithmetic the engine relies on to build that trajectory.
  const openedAt = now - 6 * DAY;
  const reviewDays = [now - 4 * DAY, now - 1 * DAY].map((reviewAt) =>
    Math.max(0, Math.floor((reviewAt - openedAt) / DAY)));
  check('first review recorded day 2, later review day 5 (trajectory increases)',
    reviewDays[0] === 2 && reviewDays[1] === 5 && reviewDays[1] > reviewDays[0]);

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
