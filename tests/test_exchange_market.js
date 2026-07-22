// ============================================================================
// THE EXCHANGE — market-classifier, pricing and money-gate suite.
// Re-run any time with:  node tests/test_exchange_market.js
//
// THE BUGS THIS EXISTS FOR (22/07/2026).
//
// 1. exchange-engine.js sanitised every ticker with /[^A-Z.]/g, which strips DIGITS.
//    6758 (Sony, Tokyo) became "" and C6L (SIA, SGX) became "CL" — Colgate-Palmolive.
//    Asian names were priced as unrelated US companies, silently.
// 2. checkLevels wrapped its whole reality-check in `if (realPrice != null)`, so a name
//    that could not be priced skipped verification ENTIRELY and fell through to checks
//    that only ask whether an idea agrees with ITSELF. A hallucinated Sony at 2820 with
//    levels invented around 2820 passed at full conviction while Tokyo traded at 3425.
// 3. Tradeability was prompt-English only; nothing in code stopped an unsupported name.
// 4. Nothing handled currency: JPY 3425 was sized against a USD buying power.
//
// These checks drive the REAL exported functions, not reimplementations. If the engine
// stops exporting them the suite hard-fails rather than quietly testing a copy.
// Everything here is offline — no network, no keys, deterministic.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}

(async () => {
  let C, E, Q;
  try {
    C = await import('../api/market-classifier.js');
    E = await import('../api/exchange-engine.js');
    Q = await import('../api/quote-provider.js');
  } catch (e) {
    console.error('Could not import the exchange modules:', e.message);
    process.exit(2);
  }
  const { classifyTicker, marketStatus, MARKETS, SUPPORTED } = C;
  const { checkLevels, sanePrice, priceOf } = E;
  const { toUsd } = Q;
  for (const [n, f] of Object.entries({ classifyTicker, marketStatus, checkLevels, sanePrice, priceOf, toUsd })) {
    if (typeof f !== 'function') {
      console.error(`Required export "${n}" is missing — these checks would be testing nothing. Hard stop.`);
      process.exit(3);
    }
  }

  // ---------------------------------------------------------------------------
  console.log('=== 1. THE SANITISER BUG: digits must survive ===');
  // The exact collisions the old regex manufactured. Each of these SGX counters
  // reduced to a real, different, US-listed company.
  const collisions = [
    ['C6L', 'SGX', 'C6L.SI'],   // was -> CL   Colgate-Palmolive
    ['D05', 'SGX', 'D05.SI'],   // was -> D    Dominion Energy
    ['Z74', 'SGX', 'Z74.SI'],   // was -> Z    Zillow
    ['U11', 'SGX', 'U11.SI'],   // was -> U    Unity Software
    ['O39', 'SGX', 'O39.SI'],   // was -> O    Realty Income
    ['S63', 'SGX', 'S63.SI'],   // was -> S    SentinelOne
    ['A17U', 'SGX', 'A17U.SI'], // was -> AU   AngloGold Ashanti
    ['ES3', 'SGX', 'ES3.SI'],   // was -> ES   Eversource
    ['BN4', 'SGX', 'BN4.SI'],   // was -> BN   Brookfield
    ['5DD', 'SGX', '5DD.SI'],   // was -> DD   DuPont
  ];
  for (const [tk, mkt, yh] of collisions) {
    const c = classifyTicker(tk, mkt);
    check(`${tk} classifies as SGX (not a US collision)`, c.ok && c.market === 'SGX');
    check(`${tk} -> ${yh}`, c.ok && c.yahooSymbol === yh);
    check(`${tk} keeps its digits`, c.ok && /\d/.test(c.ticker));
  }
  check('6758 + Tokyo -> 6758.T', classifyTicker('6758', 'TSE').yahooSymbol === '6758.T');
  check('0700 + HKEX -> 0700.HK', classifyTicker('0700', 'HKEX').yahooSymbol === '0700.HK');
  check('700 zero-pads to 0700.HK', classifyTicker('700', 'HKEX').yahooSymbol === '0700.HK');
  check('1155 + Bursa -> 1155.KL', classifyTicker('1155', 'Bursa').yahooSymbol === '1155.KL');
  check('600519 -> 600519.SS', classifyTicker('600519', 'SSE').yahooSymbol === '600519.SS');
  check('NVDA stays NVDA', classifyTicker('NVDA', 'NASDAQ').yahooSymbol === 'NVDA');
  check('BRK.B class share survives', classifyTicker('BRK.B', 'NYSE').ok);

  console.log('=== 2. AMBIGUITY AND CONFLICT MUST FAIL SAFE, NEVER GUESS ===');
  const amb = classifyTicker('6758', null);
  check('bare 4-digit with no exchange is refused', !amb.ok && amb.ambiguous === true);
  check('...and says why', /ambiguous/i.test(amb.reason || ''));
  const conflict = classifyTicker('C6L', 'NASDAQ');
  check('SGX shape labelled NASDAQ is refused', !conflict.ok && conflict.conflict === true);
  const conflict2 = classifyTicker('NVDA', 'SGX');
  check('US shape labelled SGX is refused', !conflict2.ok);
  check('garbage ticker refused', !classifyTicker('ZZZZZZZZ', null).ok);
  check('empty ticker refused', !classifyTicker('', null).ok);
  check('a hint cannot invent a market for a bad shape', !classifyTicker('!!!', 'SGX').ok);

  console.log('=== 3. THE UNPRICED HARD BLOCK (the Sony case) ===');
  // Sony's real price was 3425. The desk proposed 2820 with internally consistent levels:
  // entry within 8% of its own stated price, stop below, target above, R:R fine.
  const sony = { direction: 'BUY', current_price: '2820', entry: '2800-2820', tp: '2960', sl: '2700' };
  const selfConsistent = checkLevels(sony, 3425 * 0 + 2820); // priced AT its own claim
  check('sanity: those levels ARE internally consistent', selfConsistent.ok === true);
  const unpriced = checkLevels(sony, null);
  check('no price => NOT ok', unpriced.ok === false);
  check('no price => flagged unpriced', unpriced.unpriced === true);
  check('no price => explains itself', /no verified market price/i.test(unpriced.reason || ''));
  check('unpriced beats internal consistency', unpriced.ok === false && selfConsistent.ok === true);
  // and with the true price, the 21% gap is caught
  const priced = checkLevels(sony, { price: 3425, currency: 'JPY', unpriced: false });
  check('true price catches the 21% error', priced.ok === false);
  check('...and names the gap', /off the live price/.test(priced.reason || ''));
  // an unpriced record from the provider carries its reason through
  const rec = checkLevels(sony, { price: null, unpriced: true, reason: 'no quote returned for 6758.T' });
  check('provider reason surfaces in the block', /no quote returned/.test(rec.reason || ''));

  console.log('=== 3b. MUTATION TEST: the block must not be bypassable ===');
  // Every shape of "we have no number" must land in the same hard block. These are the
  // exact values that used to slip through the old `if (realPrice != null && > 0)` guard.
  for (const [label, v] of [['null', null], ['undefined', undefined], ['zero', 0],
    ['negative', -5], ['NaN', NaN], ['empty string', ''], ['unpriced record', { unpriced: true, price: null }],
    ['record with 0', { unpriced: false, price: 0 }], ['empty object', {}]]) {
    const r = checkLevels(sony, v);
    check(`unpriced via ${label} is blocked`, r.ok === false && r.unpriced === true);
  }
  // ...and a genuine price must still pass, or the gate is just "always fail"
  const good = { direction: 'BUY', current_price: '100', entry: '99-100', tp: '106', sl: '96' };
  check('a real, correct idea still passes', checkLevels(good, 100).ok === true);
  check('a real idea passes via a record too', checkLevels(good, { price: 100, unpriced: false }).ok === true);

  console.log('=== 4. priceOf normalises every price shape ===');
  check('number', priceOf(42) === 42);
  check('numeric string', priceOf('42.5') === 42.5);
  check('record', priceOf({ price: 7.63, unpriced: false }) === 7.63);
  check('unpriced record -> null', priceOf({ price: 7.63, unpriced: true }) === null);
  check('null -> null', priceOf(null) === null);
  check('zero -> null', priceOf(0) === null);
  check('object without price -> null', priceOf({}) === null);

  console.log('=== 5. sanePrice tolerance actually bites now ===');
  // At the old tol of 0.6 a 21% error passed. This is the money-gate on synced holdings.
  check('21% disagreement is now rejected', sanePrice(3425, 2820).rejected === true);
  check('...and keeps the platform price', sanePrice(3425, 2820).price === 2820);
  check('5% disagreement still trusted', sanePrice(105, 100).usedFeed === true);
  check('no reference => feed is used', sanePrice(105, null).usedFeed === true);
  check('no feed => reference kept', sanePrice(null, 100).price === 100);
  // guard against someone loosening it back
  check('default tolerance is tight (<=0.2)', sanePrice(121, 100).rejected === true);

  console.log('=== 6. CURRENCY: no silent 1:1 ===');
  const fx = { USD: 1, JPY: 0.0061, SGD: 0.7741 };
  check('USD passes through', toUsd(100, 'USD', fx) === 100);
  const sonyUsd = toUsd(3425, 'JPY', fx);
  check('JPY 3425 is about USD 21', sonyUsd > 19 && sonyUsd < 23);
  check('...and is NOT 3425', Math.abs(sonyUsd - 3425) > 3000);
  check('SGD converts', Math.abs(toUsd(100, 'SGD', fx) - 77.41) < 0.01);
  // THE landmine: an unknown rate must be null, never the raw number.
  check('unknown currency => null, never 1:1', toUsd(3425, 'KRW', fx) === null);
  check('missing rate table => null', toUsd(3425, 'JPY', {}) === null);
  check('non-numeric => null', toUsd('abc', 'JPY', fx) === null);

  console.log('=== 7. TRADEABLE UNIVERSE ===');
  check('six markets supported', SUPPORTED.length === 6);
  for (const m of ['US', 'SGX', 'HKEX', 'TSE', 'BURSA', 'CHINA']) {
    check(`${m} is in the universe`, SUPPORTED.includes(m));
    check(`${m} has a currency`, !!MARKETS[m].currency);
    check(`${m} has an IANA zone`, /^[A-Za-z]+\/[A-Za-z_]+$/.test(MARKETS[m].tz));
    check(`${m} has sessions`, MARKETS[m].sessions.length > 0);
  }
  // London is a real exchange but not one NOVA offers here — must not classify.
  check('a non-NOVA venue does not classify', !classifyTicker('VOD.L', 'LSE').ok);

  console.log('=== 8. MARKET SESSIONS resolve through IANA, incl. DST ===');
  // Fixed instants, so this is deterministic regardless of when the suite runs.
  // 2026-07-22 05:00 UTC = 12:00 Tokyo (JST, no DST) = 14:00 SGT... check each market
  // at an instant we KNOW is inside and outside its session.
  const at = (iso) => new Date(iso);
  // Wed 22 Jul 2026, 02:00 UTC -> Tokyo 11:00 (open), Singapore 10:00 (open), NY 22:00 (shut)
  check('Tokyo open at 11:00 JST', marketStatus('TSE', at('2026-07-22T02:00:00Z')).open === true);
  check('SGX open at 10:00 SGT', marketStatus('SGX', at('2026-07-22T02:00:00Z')).open === true);
  check('US shut at 22:00 ET', marketStatus('US', at('2026-07-22T02:00:00Z')).open === false);
  // Tokyo lunch break: 03:00 UTC = 12:00 JST, between 11:30 and 12:30
  check('Tokyo SHUT during its lunch break', marketStatus('TSE', at('2026-07-22T03:00:00Z')).open === false);
  // SGX lunch: 04:30 UTC = 12:30 SGT
  check('SGX SHUT during its lunch break', marketStatus('SGX', at('2026-07-22T04:30:00Z')).open === false);
  // TSE afternoon extension: 06:15 UTC = 15:15 JST, inside the post-2024 15:30 close
  check('Tokyo open at 15:15 JST (post-2024 close)', marketStatus('TSE', at('2026-07-22T06:15:00Z')).open === true);
  check('Tokyo shut at 15:45 JST', marketStatus('TSE', at('2026-07-22T06:45:00Z')).open === false);
  // US DST: July is EDT (UTC-4). 14:00 UTC = 10:00 ET -> open.
  check('US open 10:00 EDT (summer)', marketStatus('US', at('2026-07-22T14:00:00Z')).open === true);
  // January is EST (UTC-5). 14:00 UTC = 09:00 ET -> shut. Same UTC instant, different answer:
  // this is precisely what a hardcoded ICT window gets wrong for half the year.
  check('US shut 09:00 EST (winter, same UTC hour)', marketStatus('US', at('2026-01-21T14:00:00Z')).open === false);
  check('US open 15:00 UTC in winter (10:00 EST)', marketStatus('US', at('2026-01-21T15:00:00Z')).open === true);
  // Weekend
  check('SGX shut on Saturday', marketStatus('SGX', at('2026-07-25T02:00:00Z')).open === false);
  check('...and flags the weekend', marketStatus('SGX', at('2026-07-25T02:00:00Z')).weekend === true);
  check('US shut on Sunday', marketStatus('US', at('2026-07-26T15:00:00Z')).open === false);

  console.log('=== 9. THE BADGE IS HONEST ABOUT HOLIDAYS ===');
  const st = marketStatus('SGX', at('2026-07-22T02:00:00Z'));
  check('every status is marked scheduled-only', st.scheduledOnly === true);
  check('unknown market does not claim open', marketStatus('NOPE').open === false);
  check('unknown market says so', marketStatus('NOPE').known === false);
  check('a shut market offers a next open', marketStatus('US', at('2026-07-22T02:00:00Z')).nextOpenPhuket != null);
  check('an open market needs no next open', marketStatus('SGX', at('2026-07-22T02:00:00Z')).nextOpenIso === null);
  // sessions are rendered in HIS time, which is the whole point of the feature
  check('sessions are shown in Phuket time', /\d\d:\d\d-\d\d:\d\d/.test(st.sessionsPhuket || ''));

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:'); fails.forEach((f) => console.log('  -', f)); process.exit(1); }
  console.log('ALL GREEN.');
})();
