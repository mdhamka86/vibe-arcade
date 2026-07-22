// ============================================================================
// THE EXCHANGE — short-as-first-class suite.
// Re-run any time with:  node tests/test_exchange_direction.js
//
// THE BUG THIS EXISTS FOR (22/07/2026). A live SELL/short TSLA (entry 377.48, target 348
// BELOW) showed the banner "TAKE-PROFIT HIT at 348 — now 378.4". 378.4 is ABOVE entry, the
// short is underwater, and a short does NOT take profit when price rises. The hit-detection
// (in both api/exchange-engine.js actReview AND public/exchange.html liveHit) was written for
// a LONG: price >= TP fired take-profit. A short is the mirror — profit when price FALLS to
// target, stop when price RISES to stop.
//
// Two compounding faults surfaced with it: the holding carried NO direction field (so every
// fallback defaulted it to LONG), and its stop was locked at 365 — BELOW its 377.48 entry, on
// the profit side, where a short's stop can never act. So this suite also covers direction
// inference and direction-aware level geometry.
//
// Drives the REAL exported helpers, offline and deterministic.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}

(async () => {
  let E;
  try { E = await import('../api/exchange-engine.js'); }
  catch (e) { console.error('Could not import exchange-engine:', e.message); process.exit(2); }
  const { isShort, levelHitState, levelGeometryProblem, inferDirection } = E;
  for (const [n, f] of Object.entries({ isShort, levelHitState, levelGeometryProblem, inferDirection })) {
    if (typeof f !== 'function') {
      console.error(`Required export "${n}" is missing — these checks would test nothing. Hard stop.`);
      process.exit(3);
    }
  }

  // ---------------------------------------------------------------------------
  console.log('=== 1. isShort reads both vocabularies ===');
  for (const d of ['SHORT', 'short', 'Sell', 'SELL', 'S']) check(`"${d}" is short`, isShort(d) === true);
  for (const d of ['LONG', 'BUY', 'B', '', null, undefined, 'HOLD']) check(`"${d}" is not short`, isShort(d) === false);

  console.log('=== 2. HIT DETECTION — the mutation grid, both directions x TP/SL ===');
  // LONG entry 100: TP 110 (above), SL 95 (below). Profit above, stop below.
  check('LONG price at target => TP hit', levelHitState('LONG', 110, 95, 110).tp === true);
  check('LONG price past target => TP hit', levelHitState('LONG', 112, 95, 110).tp === true);
  check('LONG price at stop => SL hit', levelHitState('LONG', 95, 95, 110).sl === true);
  check('LONG price below stop => SL hit', levelHitState('LONG', 94, 95, 110).sl === true);
  check('LONG mid-range => neither', (() => { const r = levelHitState('LONG', 100, 95, 110); return !r.tp && !r.sl; })());
  check('LONG below target does NOT hit TP', levelHitState('LONG', 109, 95, 110).tp === false);
  // SHORT entry 100: TP 90 (below), SL 105 (above). Profit below, stop above.
  check('SHORT price falls to target => TP hit', levelHitState('SHORT', 90, 105, 90).tp === true);
  check('SHORT price past target => TP hit', levelHitState('SHORT', 88, 105, 90).tp === true);
  check('SHORT price rises to stop => SL hit', levelHitState('SHORT', 105, 105, 90).sl === true);
  check('SHORT price above stop => SL hit', levelHitState('SHORT', 107, 105, 90).sl === true);
  check('SHORT mid-range => neither', (() => { const r = levelHitState('SHORT', 100, 105, 90); return !r.tp && !r.sl; })());
  // THE CORE OF THE BUG: a short with price ABOVE its (below) target must NOT read take-profit.
  check('SHORT price ABOVE target does NOT fire TP (the bug)', levelHitState('SHORT', 378.4, 999, 348).tp === false);
  check('...whereas the old LONG logic WOULD have', levelHitState('LONG', 378.4, 999, 348).tp === true);
  // SELL vocabulary must behave identically to SHORT (ideas use BUY/SELL)
  check('SELL == SHORT for hit detection', (() => {
    const a = levelHitState('SELL', 88, 105, 90), b = levelHitState('SHORT', 88, 105, 90);
    return a.tp === b.tp && a.sl === b.sl;
  })());
  // null levels or price can never be hit
  check('null price => nothing hit', (() => { const r = levelHitState('LONG', null, 95, 110); return !r.tp && !r.sl; })());
  check('null TP => TP cannot hit', levelHitState('LONG', 200, 95, null).tp === false);
  check('null SL => SL cannot hit', levelHitState('SHORT', 1, null, 90).sl === false);

  console.log('=== 3. THE LIVE TSLA SHORT, exactly as stored ===');
  // avgCost 377.48, lockedSL 365, lockedTP 348, price 378.4, direction ABSENT.
  const tsla = { avgCost: 377.48, lastPrice: 378.4, unrealised: -0.92, lockedSL: 365, lockedTP: 348 };
  check('inferred SHORT from the P&L sign (price up + losing)', inferDirection(tsla) === 'SHORT');
  const dir = inferDirection(tsla);
  // raw short logic: TP not hit (378.4 not <= 348); SL "hit" only because 365 is mis-sided
  check('raw short TP not hit', levelHitState(dir, 378.4, 365, 348).tp === false);
  // the stored stop is geometrically invalid for a short (below entry) — that is WHY it would
  // otherwise fire, and why the guard must suppress it
  check('stored SL flagged as wrong-side for a short', !!levelGeometryProblem(dir, 377.48, 365, null));
  check('...naming that a short stops ABOVE entry', /must sit ABOVE entry/.test(levelGeometryProblem(dir, 377.48, 365, null)));
  check('stored TP (348 below) is correct for a short', levelGeometryProblem(dir, 377.48, null, 348) === null);
  // the review guard: a mis-sided stop is not treated as hit => LIVE HOLD, as the user expects
  const guardedSL = levelGeometryProblem(dir, 377.48, 365, null) ? null : 365;
  const guardedTP = levelGeometryProblem(dir, 377.48, null, 348) ? null : 348;
  const guarded = levelHitState(dir, 378.4, guardedSL, guardedTP);
  check('GUARDED: neither level fires => live hold', guarded.tp === false && guarded.sl === false);

  console.log('=== 4. A VALID short behaves correctly through its life ===');
  // entry 377.48, stop 390 ABOVE, target 348 BELOW — correct short geometry
  check('valid short geometry passes', levelGeometryProblem('SHORT', 377.48, 390, 348) === null);
  check('valid short at 378.4 => neither hit (live hold)', (() => { const r = levelHitState('SHORT', 378.4, 390, 348); return !r.tp && !r.sl; })());
  check('valid short falls to 348 => TP hit', levelHitState('SHORT', 348, 390, 348).tp === true);
  check('valid short falls below 348 => TP hit', levelHitState('SHORT', 345, 390, 348).tp === true);
  check('valid short rises to 390 => SL hit', levelHitState('SHORT', 390, 390, 348).sl === true);
  check('valid short rises past 390 => SL hit', levelHitState('SHORT', 395, 390, 348).sl === true);

  console.log('=== 5. LEVEL GEOMETRY, both directions ===');
  check('LONG stop below + target above => valid', levelGeometryProblem('LONG', 100, 95, 110) === null);
  check('LONG stop ABOVE entry => flagged', !!levelGeometryProblem('LONG', 100, 105, 110));
  check('LONG target BELOW entry => flagged', !!levelGeometryProblem('LONG', 100, 95, 90));
  check('SHORT stop above + target below => valid', levelGeometryProblem('SHORT', 100, 105, 90) === null);
  check('SHORT stop BELOW entry => flagged', !!levelGeometryProblem('SHORT', 100, 95, 90));
  check('SHORT target ABOVE entry => flagged', !!levelGeometryProblem('SHORT', 100, 105, 110));
  check('no entry reference => no judgement (null)', levelGeometryProblem('SHORT', null, 95, 90) === null);
  check('only one level supplied is fine', levelGeometryProblem('LONG', 100, 95, null) === null);

  console.log('=== 6. DIRECTION INFERENCE ===');
  check('explicit SHORT wins over any sign', inferDirection({ direction: 'SHORT', avgCost: 100, lastPrice: 90, unrealised: 5 }) === 'SHORT');
  check('explicit LONG wins', inferDirection({ direction: 'LONG', avgCost: 100, lastPrice: 110, unrealised: -5 }) === 'LONG');
  check('SELL normalises to SHORT', inferDirection({ direction: 'SELL' }) === 'SHORT');
  check('BUY normalises to LONG', inferDirection({ direction: 'BUY' }) === 'LONG');
  check('price up + losing => SHORT', inferDirection({ avgCost: 100, lastPrice: 110, unrealised: -8 }) === 'SHORT');
  check('price down + winning => SHORT', inferDirection({ avgCost: 100, lastPrice: 90, unrealised: 8 }) === 'SHORT');
  check('price up + winning => LONG', inferDirection({ avgCost: 100, lastPrice: 110, unrealised: 8 }) === 'LONG');
  check('price down + losing => LONG', inferDirection({ avgCost: 100, lastPrice: 90, unrealised: -8 }) === 'LONG');
  check('no data => LONG (the safe common case)', inferDirection({}) === 'LONG');
  check('flat P&L => LONG (cannot tell, do not guess short)', inferDirection({ avgCost: 100, lastPrice: 100, unrealised: 0 }) === 'LONG');
  check('tiny noise P&L => LONG (below the threshold)', inferDirection({ avgCost: 100, lastPrice: 100.05, unrealised: 0.001 }) === 'LONG');

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
