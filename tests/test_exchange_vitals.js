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
  const { computeVitals, resolveHoldingMarket, sectorOf } = E;
  for (const [n, f] of Object.entries({ computeVitals, resolveHoldingMarket, sectorOf })) {
    if (typeof f !== 'function') { console.error(`Required export "${n}" missing. Hard stop.`); process.exit(3); }
  }
  // Fixed FX so the currency maths is deterministic (SGD≈0.775, JPY≈0.0064, HKD≈0.128).
  const FX = { USD: 1, SGD: 0.775, JPY: 0.0064, HKD: 0.128, MYR: 0.225, CNY: 0.14 };

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
  console.log('=== 4. PER-HOLDING MARKET CLASSIFICATION — all six markets (Bug 1) ===');
  const rm = (h) => resolveHoldingMarket(h);
  // the exact holdings that were misclassified: no exchange field, only ticker + name
  check('C6L => SGX / Singapore / SGD / daytime', (() => { const m = rm({ ticker: 'C6L', name: 'Singapore Airlines Sl.' }); return m.market === 'SGX' && m.geography === 'Singapore' && m.currency === 'SGD' && m.daytimeTradeable === true; })());
  check('M44U (SGX REIT) => Singapore', rm({ ticker: 'M44U', name: 'Mapletree Logistics Tr' }).geography === 'Singapore');
  check('6758 + Tokyo hint => Japan / JPY', (() => { const m = rm({ ticker: '6758', exchange: 'TSE' }); return m.geography === 'Japan' && m.currency === 'JPY'; })());
  check('0700 + HK => Hong Kong / HKD', (() => { const m = rm({ ticker: '0700', exchange: 'HKEX' }); return m.geography === 'Hong Kong' && m.currency === 'HKD'; })());
  check('1155 + Bursa => Malaysia / MYR', rm({ ticker: '1155', exchange: 'Bursa' }).geography === 'Malaysia');
  check('600519 => China / CNY', rm({ ticker: '600519', exchange: 'SSE' }).geography === 'China');
  check('NVDA => US / night-only', (() => { const m = rm({ ticker: 'NVDA' }); return m.geography === 'US' && m.isUS === true && m.daytimeTradeable === false; })());
  // name-hint fallback: NOVA embeds the venue in the name
  check('name-hint "AMD (US:NQ)" => US', rm({ ticker: 'AMD', name: 'AMD (US:NQ)' }).geography === 'US');
  check('name-hint "AMEX VOO" => US', rm({ ticker: 'VOO', name: 'AMEX VOO-VGD S&P', assetClass: 'ETF' }).geography === 'US');
  // a long name jammed into the ticker slot (no digits) => assumed US, not Unknown
  check('SERVICENOW (name-as-ticker) => US via assumed-us', (() => { const m = rm({ ticker: 'SERVICENOW', name: 'ServiceNow Inc' }); return m.market === 'US' && m.source === 'assumed-us'; })());
  // genuinely unresolvable => Unknown, flagged, never silently bucketed as US
  check('bare ambiguous 4-digit, no hint => Unknown (not silently US)', rm({ ticker: '6758', name: 'Mystery Co' }).market === null);
  check('...and Unknown is flagged as such', rm({ ticker: '6758', name: 'Mystery Co' }).source === 'unknown');
  // an explicit exchange field wins
  check('explicit exchange field is honoured', rm({ ticker: 'C6L', exchange: 'SGX' }).market === 'SGX');

  console.log('=== 5. GEOGRAPHY is currency-correct, not "US 100%" (Bug 1 end-to-end) ===');
  // The real misclassified book: C6L (SGX, 100@7.65 SGD) + M44U (SGX) + US names.
  const mixedBook = {
    lastSync: iso(2 * 3600e3), netLiq: 3627, account: { buyingPowerETD: 1542, netLiquidityValue: 3627, unrealizedPL: 120 },
    holdings: [
      { ticker: 'C6L', name: 'Singapore Airlines Sl.', qty: 100, avgCost: 6.5, lastPrice: 7.65, unrealised: 89.03, openedAt: Date.now() - 9 * 86400e3 },
      { ticker: 'M44U', name: 'Mapletree Logistics Tr', qty: 200, avgCost: 1.22, lastPrice: 1.2, unrealised: -3.1 },
      { ticker: 'GM', name: 'General Motors Co', qty: 5, avgCost: 78.79, lastPrice: 82.09, unrealised: 16.36 },
      { ticker: 'TSLA', name: 'Tesla Motors', direction: 'SHORT', qty: -1, avgCost: 377.48, lastPrice: 374.13, unrealised: 3.36, openedAt: Date.now() - 1 * 86400e3 },
    ],
  };
  const mv = computeVitals(mixedBook, true, FX);
  const geoName = (g) => (mv.analytics.geography.find((x) => x.name === g) || {}).pct || 0;
  check('geography is NOT US 100%', geoName('US') < 100);
  check('Singapore appears in geography', geoName('Singapore') > 0);
  check('Singapore is tagged daytime-tradeable', mv.analytics.geography.find((g) => g.name === 'Singapore').daytime === true);
  check('US is tagged NOT daytime (night-only)', mv.analytics.geography.find((g) => g.name === 'US').daytime === false);
  check('daytimePct is reported and > 0', mv.analytics.daytimePct > 0);
  // the "Markets & trading hours" read replaces the wrong "US 100% night only"
  check('markets read exists and is not the old US-100 wording', !!mv.reads.find((r) => r.label === 'Markets & trading hours'));

  console.log('=== 6. CURRENCY: SGD converted to USD, weights not inflated ===');
  // C6L: 100 * 7.65 = 765 SGD. In USD at 0.775 that is ~$592.9, NOT $765.
  // Verify its single-name weight uses the CONVERTED value, not the raw SGD notional.
  const c6lWeight = mv.analytics.nameWeights.find((n) => n.name === 'C6L').pct;
  // Recompute the expected: usd values
  const usd = { C6L: 100 * 7.65 * 0.775, M44U: 200 * 1.2 * 0.775, GM: 5 * 82.09, TSLA: 1 * 374.13 };
  const tot = Object.values(usd).reduce((a, b) => a + b, 0);
  const expectC6L = +((usd.C6L / tot) * 100).toFixed(1);
  check(`C6L weight uses converted USD (~${expectC6L}%, not the inflated raw-SGD figure)`, Math.abs(c6lWeight - expectC6L) < 0.2);
  check('C6L converted weight is LOWER than its raw-SGD weight would be', c6lWeight < +((765 / (765 + 240 + 410 + 374)) * 100).toFixed(1));
  // a pure-USD book must be unaffected by FX (rates are 1:1 for USD)
  const usOnly = computeVitals({ lastSync: iso(3600e3), netLiq: 1000, account: { netLiquidityValue: 1000 }, holdings: [{ ticker: 'GM', qty: 5, avgCost: 80, lastPrice: 82 }, { ticker: 'NVDA', qty: 1, avgCost: 100, lastPrice: 110 }] }, true, FX);
  check('US-only book: weights sum to ~100%', Math.abs(usOnly.analytics.nameWeights.reduce((a, n) => a + n.pct, 0) - 100) < 0.2);

  console.log('=== 6b. FAIL-HONEST: an unconvertible currency is excluded and flagged ===');
  // FX missing the SGD rate: C6L/M44U cannot be valued -> excluded + a Valuation gap read.
  const noSgd = computeVitals(mixedBook, true, { USD: 1 });
  check('unconvertible holdings are flagged', noSgd.analytics.valuation.unvalued.length === 2);
  check('C6L is among the unvalued', noSgd.analytics.valuation.unvalued.includes('C6L'));
  check('a Valuation gap read is surfaced', !!noSgd.reads.find((r) => r.label === 'Valuation gap'));
  check('weights are computed on the convertible remainder, not silently on a wrong denominator', (() => {
    // only GM + TSLA are valued; their weights should sum to ~100
    const s = noSgd.analytics.nameWeights.filter((n) => n.name === 'GM' || n.name === 'TSLA').reduce((a, n) => a + n.pct, 0);
    return Math.abs(s - 100) < 0.5;
  })());
  check('a fully-unconvertible book does not crash and flags everything', (() => {
    const allSgd = computeVitals({ lastSync: iso(3600e3), netLiq: 100, account: { netLiquidityValue: 100 }, holdings: [{ ticker: 'C6L', qty: 100, avgCost: 6, lastPrice: 7 }] }, true, { USD: 1 });
    return allSgd.state === 'OK' && allSgd.analytics.valuation.unvalued.length === 1;
  })());

  console.log('=== 7. SECTORS are meaningful — "Other" is not the biggest slice ===');
  const sv = computeVitals({
    lastSync: iso(3600e3), netLiq: 5000, account: { netLiquidityValue: 5000 },
    holdings: [
      { ticker: 'C6L', name: 'Singapore Airlines', qty: 100, avgCost: 6.5, lastPrice: 7.65 },
      { ticker: 'GM', qty: 5, avgCost: 80, lastPrice: 82 }, { ticker: 'TSLA', qty: 1, avgCost: 350, lastPrice: 374 },
      { ticker: 'NVO', name: 'Novo Nordisk', qty: 3, avgCost: 49, lastPrice: 48 }, { ticker: 'SYF', name: 'Synchrony', qty: 3, avgCost: 71, lastPrice: 72 },
      { ticker: 'HLT', name: 'Hilton', qty: 1, avgCost: 323, lastPrice: 324 }, { ticker: 'SERVICENOW', name: 'ServiceNow Inc', qty: 2, avgCost: 98, lastPrice: 95 },
      { ticker: 'VOO', name: 'Vanguard S&P 500', assetClass: 'ETF', qty: 1, avgCost: 677, lastPrice: 687 },
    ],
  }, true, FX);
  check('sector list is populated', sv.analytics.sectors.length > 0);
  check('the LARGEST sector is NOT "Other"', sv.analytics.sectors[0].name !== 'Other');
  check('"Other" is a small share if present at all', (() => { const o = sv.analytics.sectors.find((s) => s.name === 'Other'); return !o || o.pct < 15; })());
  check('C6L classifies as Industrials from the universe seed', sectorOf({ ticker: 'C6L', name: 'Singapore Airlines' }) === 'Industrials');
  check('an S&P ETF is Diversified, not Other', sectorOf({ ticker: 'VOO', name: 'Vanguard S&P 500', assetClass: 'ETF' }) === 'Diversified (ETF)');

  console.log('=== 8. SHORT-AWARE P&L in winners/laggards ===');
  // TSLA short entered 377.48, now 374.13 (price fell) => the platform reports +3.36 profit.
  // The winners/laggards read trusts the platform's signed P&L, so the short shows as a winner.
  const shortWinBook = {
    lastSync: iso(3600e3), netLiq: 1000, account: { netLiquidityValue: 1000, unrealizedPL: 5 },
    holdings: [
      { ticker: 'TSLA', name: 'Tesla', direction: 'SHORT', qty: -1, avgCost: 377.48, lastPrice: 374.13, unrealised: 3.36 },
      { ticker: 'NVO', name: 'Novo', qty: 3, avgCost: 49, lastPrice: 46, unrealised: -9 },
    ],
  };
  const swv = computeVitals(shortWinBook, true, FX);
  check('a profitable SHORT appears as a winner (price fell => profit)', !!swv.analytics.topWinners.find((w) => w.name === 'TSLA' && w.pl > 0));
  check('a losing long appears as a laggard', !!swv.analytics.topLaggards.find((l) => l.name === 'NVO' && l.pl < 0));

  console.log('=== 9. HOLD DURATION (week-max) read ===');
  check('a position past 7 days is flagged', (() => { const r = mv.reads.find((x) => x.label === 'Hold duration'); return r && /past 7 days/.test(r.value); })());
  check('the hold-duration analytics carries the longest hold', mv.analytics.holdDuration.longest && mv.analytics.holdDuration.longest.days >= 9);
  check('undated positions are counted honestly', typeof mv.analytics.holdDuration.undatedCount === 'number');
  const freshHold = computeVitals({ lastSync: iso(3600e3), netLiq: 100, account: { netLiquidityValue: 100 }, holdings: [{ ticker: 'GM', qty: 1, avgCost: 80, lastPrice: 82, openedAt: Date.now() - 2 * 86400e3 }] }, true, FX);
  check('all-within-a-week reads GREEN', (() => { const r = freshHold.reads.find((x) => x.label === 'Hold duration'); return r && r.status === 'GREEN'; })());

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
