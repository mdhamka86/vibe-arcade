// ============================================================================
// THE EXCHANGE — vitals fail-honest suite. Vitals is DEATHLY important: account, margin and
// buying power are what every sizing decision keys off, so vitals must be correct and must
// never present "unknown" as "zero/empty".
// Re-run any time with:  node tests/test_exchange_vitals.js
//
// THE RISK THIS EXISTS FOR (22/07/2026). loadAll defaults an ABSENT exchange:book key to an
// empty object, so a wiped or never-seeded book would reach computeVitals looking exactly
// like a real account that happens to hold nothing — figures all null, no reads — and the UI
// would present that as fact. Presenting unknown firepower as $0 corrupts every sizing call.
// computeVitals now fails HONEST: an absent/unsynced book returns an explicit UNSYNCED state,
// visibly different from a genuine empty account, and every OK result carries a freshness
// stamp so stale figures are never shown as current.
//
// Drives the REAL exported computeVitals. Offline, deterministic.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

(async () => {
  let E;
  try { E = await import('../api/exchange-engine.js'); }
  catch (e) { console.error('Could not import exchange-engine:', e.message); process.exit(2); }
  const { computeVitals } = E;
  if (typeof computeVitals !== 'function') { console.error('computeVitals not exported. Hard stop.'); process.exit(3); }

  const realBook = {
    lastSync: iso(2 * 3600e3),
    netLiq: 3756,
    account: { buyingPowerETD: 571, netLiquidityValue: 3756, initialMargin: 282, equityBalance: 853, ledgerBalance: 981, unrealizedPL: -127 },
    holdings: [{ ticker: 'NVDA', qty: 1, avgCost: 100, lastPrice: 110, unrealised: 10, exchange: 'NASDAQ' }],
  };

  // ---------------------------------------------------------------------------
  console.log('=== 1. THE CORE SAFETY: missing/unsynced is NOT a $0 account ===');
  const missing = computeVitals({ holdings: [], netLiq: null }, false); // book key absent
  check('absent book => UNSYNCED state', missing.state === 'UNSYNCED');
  check('absent book => not trustworthy', missing.trustworthy === false);
  check('absent book => figures are null, not 0', missing.figures.netLiq === null && missing.figures.buyingPower === null);
  check('absent book => explains it is NOT an empty account', /not an? .*\$0 account|NOT an empty|nothing to size/i.test(missing.message || ''));
  check('absent book => no reads fabricated', Array.isArray(missing.reads) && missing.reads.length === 0);

  const unsynced = computeVitals({ holdings: [], netLiq: null }, true); // present but never synced
  check('present-but-never-synced => UNSYNCED', unsynced.state === 'UNSYNCED');
  check('...and not trustworthy', unsynced.trustworthy === false);

  const real = computeVitals(realBook, true);
  check('a real synced account => OK', real.state === 'OK');
  check('...and trustworthy', real.trustworthy === true);
  check('...with real figures', real.figures.netLiq === 3756 && real.figures.buyingPower === 571);

  console.log('=== 1b. MUTATION: every flavour of "no data" fails honest, real data does not ===');
  for (const [label, book, present] of [
    ['null-ish empty, key absent', { holdings: [], netLiq: null }, false],
    ['empty object, key absent', {}, false],
    ['default shape, key present', { holdings: [], pendingReview: [], netLiq: null, netLiqHistory: [] }, true],
    ['holdings empty + account empty', { holdings: [], account: {} }, true],
    ['account all-null', { holdings: [], account: { buyingPowerETD: null, netLiquidityValue: null, initialMargin: null } }, true],
  ]) check(`${label} => UNSYNCED`, computeVitals(book, present).state === 'UNSYNCED');
  // ...but ANY genuine evidence of a sync flips it to OK
  check('a lastSync alone => OK (it was synced, just empty)', computeVitals({ holdings: [], lastSync: iso(3600e3) }, true).state === 'OK');
  check('a netLiq alone => OK', computeVitals({ holdings: [], netLiq: 100 }, true).state === 'OK');
  check('a buying-power figure alone => OK', computeVitals({ holdings: [], account: { buyingPowerETD: 50 } }, true).state === 'OK');
  check('a single holding alone => OK', computeVitals({ holdings: [{ ticker: 'X', qty: 1, avgCost: 1, lastPrice: 1 }] }, true).state === 'OK');

  console.log('=== 2. FRESHNESS: stale is never shown as current ===');
  check('fresh sync (2h) => not stale', computeVitals(realBook, true).freshness.stale === false);
  check('fresh sync carries an asOf stamp', !!computeVitals(realBook, true).freshness.asOf);
  const stale = computeVitals({ ...realBook, lastSync: iso(8 * 86400e3) }, true);
  check('8-day-old sync => stale flagged', stale.freshness.stale === true);
  check('...but still OK state (data exists, just old)', stale.state === 'OK');
  const noStamp = computeVitals({ netLiq: 3756, account: { buyingPowerETD: 571 }, holdings: [] }, true);
  check('synced figures with NO lastSync => stale (unknown age, not assumed current)', noStamp.freshness.stale === true);
  check('...and asOf is null so the UI can say "unknown age"', noStamp.freshness.asOf === null);
  // freshness boundary
  check('just under 3 days => not stale', computeVitals({ ...realBook, lastSync: iso(3 * 86400e3 - 3600e3) }, true).freshness.stale === false);
  check('just over 3 days => stale', computeVitals({ ...realBook, lastSync: iso(3 * 86400e3 + 3600e3) }, true).freshness.stale === true);

  console.log('=== 3. figures are read, not invented ===');
  check('netLiq falls back to account.netLiquidityValue', computeVitals({ account: { netLiquidityValue: 999 }, holdings: [] }, true).figures.netLiq === 999);
  check('buying power read from buyingPowerETD', real.figures.buyingPower === 571);
  check('a missing figure stays null (never 0)', computeVitals({ netLiq: 100, account: {}, holdings: [] }, true).figures.buyingPower === null);
  check('OK result exposes analytics', !!computeVitals(realBook, true).analytics);
  check('UNSYNCED result has null analytics (nothing to analyse)', computeVitals({}, false).analytics === null);

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
