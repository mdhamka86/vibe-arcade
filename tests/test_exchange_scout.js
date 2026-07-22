// ============================================================================
// THE EXCHANGE — candidate scout suite (Stage 2).
// Re-run any time with:  node tests/test_exchange_scout.js
//
// THE PROBLEM THIS EXISTS FOR (22/07/2026). actIdeas had no candidate universe at all: it
// read 28 headline TITLES — mostly about names he already holds, which rule 8 then bans
// from proposal — and free-associated two tickers out of them. Nothing enumerated, screened
// or ranked anything. exchange-scout.js builds the universe overnight on a cron; the hunt
// reads a ranked pack.
//
// These checks drive the REAL exported functions. The off-list carve-out in particular is
// the single implementation actIdeas itself calls, not a copy of the rule.
// Offline and deterministic — no network, no keys, fixed dates.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}
const TODAY = '2026-07-22';

(async () => {
  let S, E, seed;
  try {
    S = await import('../api/exchange-scout.js');
    E = await import('../api/exchange-engine.js');
    seed = (await import('../api/exchange-universe.json', { with: { type: 'json' } })).default;
  } catch (e) {
    console.error('Could not import the scout modules:', e.message);
    process.exit(2);
  }
  const { loadUniverse, signalsFrom, scoreOne, rank, BATCH } = S;
  const { offListCheck, catalystCheck, shortlistBlock } = E;
  for (const [n, f] of Object.entries({ loadUniverse, signalsFrom, scoreOne, rank, offListCheck, shortlistBlock })) {
    if (typeof f !== 'function') {
      console.error(`Required export "${n}" is missing — these checks would be testing nothing. Hard stop.`);
      process.exit(3);
    }
  }

  // ---------------------------------------------------------------------------
  console.log('=== 1. UNIVERSE loads, covers every NOVA market, resolves to feed symbols ===');
  const uni = loadUniverse();
  check('universe is non-trivial', uni.length > 300);
  check('seed records its own size honestly', seed.totalNames === uni.length);
  const byMarket = {};
  for (const n of uni) byMarket[n.market] = (byMarket[n.market] || 0) + 1;
  for (const m of ['US', 'TSE', 'HKEX', 'SGX', 'BURSA', 'CHINA']) {
    check(`${m} represented`, (byMarket[m] || 0) > 0);
  }
  check('every entry has a feed symbol', uni.every((n) => !!n.sym));
  check('every entry has a currency', uni.every((n) => !!n.currency));
  check('every entry has a sector', uni.every((n) => !!n.sector));
  check('no duplicate codes within a market', (() => {
    const seen = new Set();
    for (const n of uni) { const k = n.market + ':' + n.code; if (seen.has(k)) return false; seen.add(k); }
    return true;
  })());
  // the market-specific symbol conventions the classifier has to get right
  const find = (c) => uni.find((n) => n.code === c);
  check('SGX C6L -> C6L.SI', find('C6L')?.sym === 'C6L.SI');
  check('Tokyo 6758 -> 6758.T', find('6758')?.sym === '6758.T');
  check('HK 0700 -> 0700.HK', find('0700')?.sym === '0700.HK');
  check('Bursa 1155 -> 1155.KL', find('1155')?.sym === '1155.KL');
  check('US NVDA stays NVDA', find('NVDA')?.sym === 'NVDA');
  // SGX codes whose SHAPE collides with other boards — these are only resolvable because
  // the seed's market column is trusted reference data (trustHint), unlike a model's guess.
  check('SGX all-letter code AJBU survives', find('AJBU')?.sym === 'AJBU.SI');
  check('SGX all-digit code 558 survives', find('558')?.sym === '558.SI');
  check('...and 558 is SGX, not Hong Kong', find('558')?.market === 'SGX');

  console.log('=== 2. BATCHING respects the measured feed cap ===');
  check('batch size is 20', BATCH === 20);
  check('batch size never exceeds the measured cap', BATCH <= 20);

  console.log('=== 3. SIGNALS from a price series ===');
  const rising = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.004, i));
  const falling = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(0.996, i));
  const r = signalsFrom(rising), f = signalsFrom(falling);
  check('rising: 1wk positive', r.ret1w > 0);
  check('rising: 1mo positive', r.ret1m > 0);
  check('rising: above its 20d', r.vsSma20 > 0);
  check('rising: above its 50d', r.vsSma50 > 0);
  check('rising: pinned at the top of its range', r.stretch === 100);
  check('falling: 1wk negative', f.ret1w < 0);
  check('falling: below its 50d', f.vsSma50 < 0);
  check('falling: pinned at the bottom of its range', f.stretch === 0);
  check('a volatile series reports higher weekly vol', (() => {
    const calm = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 0.2);
    const wild = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 12);
    return signalsFrom(wild).weeklyVolPct > signalsFrom(calm).weeklyVolPct;
  })());
  check('too few bars => null, never a fabricated reading', signalsFrom([1, 2, 3]) === null);
  check('empty => null', signalsFrom([]) === null);
  check('null => null', signalsFrom(null) === null);

  console.log('=== 4. SCORING and RANKING ===');
  const ctx = { exclude: new Set(), chipHeavy: true, underweightSectors: new Set(['Healthcare']) };
  const sig = { last: 10, ret1w: 5, ret1m: 8, vsSma20: 2, vsSma50: 3, stretch: 90, weeklyVolPct: 4, currency: 'USD' };
  const nUS = { code: 'AAA', name: 'A', sector: 'Industrials', market: 'US', currency: 'USD' };
  const nSG = { code: 'BBB', name: 'B', sector: 'Industrials', market: 'SGX', currency: 'SGD' };
  check('a name with no signals scores nothing', scoreOne(nUS, null, null, ctx) === null);
  check('a name with no vol reading scores nothing', scoreOne(nUS, { ...sig, weeklyVolPct: null }, null, ctx) === null);
  check('too quiet to trade in a week is dropped', scoreOne(nUS, { ...sig, weeklyVolPct: 0.8 }, null, ctx) === null);
  check('a dated calendar catalyst beats a news mention',
    scoreOne(nUS, sig, { type: 'EARNINGS', date: '2026-07-24', newsDerived: false }, ctx).score
    > scoreOne(nUS, sig, { type: 'NEWS', date: '2026-07-22', newsDerived: true }, ctx).score);
  check('any catalyst beats none',
    scoreOne(nUS, sig, { type: 'NEWS', newsDerived: true }, ctx).score > scoreOne(nUS, sig, null, ctx).score);
  check('a daytime-tradeable market is preferred', scoreOne(nSG, sig, null, ctx).score > scoreOne(nUS, sig, null, ctx).score);
  check('chip names are penalised when he is saturated',
    scoreOne({ ...nUS, sector: 'Semiconductors' }, sig, null, ctx).score < scoreOne(nUS, sig, null, ctx).score);
  check('an under-represented sector is rewarded',
    scoreOne({ ...nUS, sector: 'Healthcare' }, sig, null, ctx).score > scoreOne(nUS, sig, null, ctx).score);
  check('scoring explains itself', (scoreOne(nSG, sig, null, ctx).reasons || []).length > 0);

  const names = [nUS, nSG, { ...nUS, code: 'CCC' }];
  const signals = { AAA: sig, BBB: sig, CCC: sig };
  const ranked = rank(names, signals, {}, ctx);
  check('rank returns candidates', ranked.length > 0);
  check('rank is sorted best-first', ranked.every((c, i) => i === 0 || ranked[i - 1].score >= c.score));
  check('excluded names never appear',
    rank(names, signals, {}, { ...ctx, exclude: new Set(['AAA', 'BBB', 'CCC']) }).length === 0);
  check('a name with no signals is not ranked', rank(names, { AAA: sig }, {}, ctx).length === 1);
  check('rank honours its limit', rank(names, signals, {}, ctx, 1).length === 1);
  check('ranked rows carry the numbers the prompt needs',
    ranked[0].weeklyVolPct != null && ranked[0].last != null && !!ranked[0].why);

  console.log('=== 5. SHORTLIST renders for the prompt ===');
  check('empty shortlist renders as nothing', shortlistBlock([]) === null);
  const block = shortlistBlock(ranked);
  check('block names the candidates', block.includes('AAA') && block.includes('BBB'));
  check('block carries measured numbers', /moves ~4%\/wk/.test(block));
  check('a candidate with no catalyst says so', /NO CATALYST FOUND/.test(shortlistBlock([{ ...ranked[0], catalyst: null }])));
  check('a verified catalyst is marked as such',
    /calendar-verified/.test(shortlistBlock([{ ...ranked[0], catalyst: { type: 'EARNINGS', date: '2026-07-24', text: 'x', verified: true } }])));
  check('a news catalyst is marked as unverified',
    /from the news wire/.test(shortlistBlock([{ ...ranked[0], catalyst: { type: 'NEWS', date: '2026-07-22', text: 'x', verified: false } }])));
  check('carried-forward signals are labelled stale', /carried from the last full sweep/.test(shortlistBlock([{ ...ranked[0], stale: true }])));

  // ---------------------------------------------------------------------------
  console.log('=== 6. ON-LIST GATE (mutation) ===');
  const onList = new Set(['AAA', 'BBB']);
  const okCat = (d, verified = false) => catalystCheck(
    { catalyst: 'Q2 results with guidance', catalyst_date: d, catalyst_type: 'EARNINGS' },
    verified ? { date: d } : null, TODAY,
  );
  // on-list names pass regardless of how live the catalyst is, so long as it is in-window
  check('on-list + catalyst 5 days out => allowed', offListCheck({ ticker: 'AAA' }, onList, okCat('2026-07-27')) === null);
  check('on-list + catalyst today => allowed', offListCheck({ ticker: 'AAA' }, onList, okCat(TODAY)) === null);
  check('on-list is matched case-insensitively', offListCheck({ ticker: 'aaa' }, onList, okCat(TODAY)) === null);
  check('on-list matched by name when there is no ticker', offListCheck({ name: 'BBB' }, onList, okCat(TODAY)) === null);
  check('no pack => gate does not fire at all', offListCheck({ ticker: 'ZZZ' }, onList, okCat('2026-07-27'), false) === null);

  console.log('=== 6b. OFF-LIST CARVE-OUT: the bar is genuinely higher ===');
  const just = { off_list_justification: 'breaking contract award today that no screened name has' };
  // THE KEY ASYMMETRY: a catalyst 5 days out is fine ON-list and NOT fine off-list.
  check('off-list + catalyst 5 days out => BLOCKED', !!offListCheck({ ticker: 'ZZZ', ...just }, onList, okCat('2026-07-27')));
  check('...and the same catalyst on-list is allowed', offListCheck({ ticker: 'AAA', ...just }, onList, okCat('2026-07-27')) === null);
  check('off-list + catalyst TODAY + justification => allowed', offListCheck({ ticker: 'ZZZ', ...just }, onList, okCat(TODAY)) === null);
  check('off-list + catalyst YESTERDAY + justification => allowed', offListCheck({ ticker: 'ZZZ', ...just }, onList, okCat('2026-07-21')) === null);
  check('off-list + calendar-VERIFIED future date + justification => allowed',
    offListCheck({ ticker: 'ZZZ', ...just }, onList, okCat('2026-07-27', true)) === null);
  check('off-list + live catalyst but NO justification => BLOCKED', !!offListCheck({ ticker: 'ZZZ' }, onList, okCat(TODAY)));
  check('off-list + a token one-word justification => BLOCKED',
    !!offListCheck({ ticker: 'ZZZ', off_list_justification: 'good' }, onList, okCat(TODAY)));
  check('off-list + whitespace justification => BLOCKED',
    !!offListCheck({ ticker: 'ZZZ', off_list_justification: '            ' }, onList, okCat(TODAY)));
  check('off-list + failing catalyst => BLOCKED', !!offListCheck({ ticker: 'ZZZ', ...just }, onList, okCat('2026-08-30')));
  check('off-list + undated catalyst => BLOCKED',
    !!offListCheck({ ticker: 'ZZZ', ...just }, onList, catalystCheck({ catalyst: 'cheap versus peers on any measure', catalyst_date: '' }, null, TODAY)));
  check('off-list + missing catalyst verdict entirely => BLOCKED', !!offListCheck({ ticker: 'ZZZ', ...just }, onList, null));
  // the reasons must be actionable, since they are fed back to the model on the retry
  check('a blocked off-list name explains the bar', /calendar-verified or same-day/.test(offListCheck({ ticker: 'ZZZ', ...just }, onList, okCat('2026-07-27'))));
  check('a missing justification says so', /no stated reason/.test(offListCheck({ ticker: 'ZZZ' }, onList, okCat(TODAY))));

  console.log('=== 6c. The gate cannot be bypassed by ticker shape games ===');
  for (const [label, idea] of [
    ['empty ticker', { ticker: '', ...just }],
    ['null ticker', { ticker: null, ...just }],
    ['whitespace ticker', { ticker: '   ', ...just }],
    ['unrelated ticker', { ticker: 'QQQ', ...just }],
  ]) {
    check(`${label} is treated as off-list and blocked`, !!offListCheck(idea, onList, okCat('2026-07-27')));
  }

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
