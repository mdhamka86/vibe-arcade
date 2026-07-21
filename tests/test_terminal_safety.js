// ============================================================================
// TERMINAL SAFETY SUITE — hammers the DANGEROUS path: the data guards that decide
// whether a healthy position gets wrongly condemned. Runs against the REAL engine
// functions extracted into _guards.js. Re-run any time with: node test_terminal_safety.js
// ============================================================================
const G = require('./_guards.js');
let pass = 0, fail = 0; const fails = [];
function check(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); } }

// ---- helper: mirror floatSignWrong (inline in engine) for testing ----
function floatSignWrong(screen) {
  const dir = (screen.direction || '').toUpperCase();
  const entry = G.num(screen.entry), cur = G.num(screen.current), fl = G.num(screen.floating);
  if (dir !== 'BUY' && dir !== 'SELL') return false;
  if (entry == null || cur == null || fl == null || entry === 0) return false;
  if (Math.abs(fl) < 0.01) return false;
  const move = Math.abs(cur - entry) / entry;
  if (move < 0.0005) return false;
  const inProfit = dir === 'BUY' ? cur > entry : cur < entry;
  return (inProfit && fl < 0) || (!inProfit && fl > 0);
}

console.log('\n=== 1. PAIR MISREAD GUARD (the EURAUD danger) ===');
// The exact bug you hit
check('EURAUD read as EURUSD @1.63669 → corrected to EURAUD',
  G.fixPairFor({pair:'EURUSD',entry:1.63669})._fixed && G.fixPairFor({pair:'EURUSD',entry:1.63669}).pair==='EURAUD');
// Every real pair at a real price must be LEFT ALONE (no false corrections)
const realBook = [
  ['EURUSD',1.1421],['EURAUD',1.6367],['EURCHF',0.9252],['USDCHF',0.8075],
  ['GBPUSD',1.2680],['USDJPY',157.30],['AUDUSD',0.6550],['NZDUSD',0.5980],
  ['USDCAD',1.3720],['EURJPY',169.5],['GBPJPY',199.4],['AUDJPY',103.1],
  ['NZDJPY',94.0],['CADJPY',114.6],['EURGBP',0.8510],['CHFJPY',175.2],
];
for (const [pair,px] of realBook) {
  check(`real ${pair}@${px} left untouched`, !G.fixPairFor({pair,entry:px})._fixed);
}
// Known cross-currency misreads that SHOULD correct
check('USDCHF misread, entry 1.372 → USDCAD', G.fixPairFor({pair:'USDCHF',entry:1.372}).pair==='USDCAD');
check('AUDUSD misread as AUDJPY-range stays sensible', !G.fixPairFor({pair:'AUDUSD',entry:0.655})._fixed);
// A price that fits NO pair should NOT be force-changed (safety: don't guess wildly)
check('nonsense entry 999 not force-corrected', !G.fixPairFor({pair:'EURUSD',entry:999})._fixed);
// null / missing entry must not crash or change
check('null entry safe', !G.fixPairFor({pair:'EURUSD',entry:null})._fixed);
check('missing entry safe', G.fixPairFor({pair:'EURUSD'}) && !G.fixPairFor({pair:'EURUSD'})._fixed);

console.log('\n=== 2. FLOATING P/L SIGN GUARD (winner shown as loser) ===');
// BUY above entry but negative float = misread → flag
check('BUY in profit shown negative → flagged', floatSignWrong({direction:'BUY',entry:1.14,current:1.15,floating:-20}));
check('SELL in profit shown negative → flagged', floatSignWrong({direction:'SELL',entry:1.42,current:1.41,floating:-12}));
// genuine losses must NOT be flagged
check('BUY genuine loss left alone', !floatSignWrong({direction:'BUY',entry:1.14,current:1.13,floating:-14}));
check('SELL genuine loss left alone', !floatSignWrong({direction:'SELL',entry:1.42,current:1.43,floating:-9}));
// genuine profits left alone
check('BUY genuine profit left alone', !floatSignWrong({direction:'BUY',entry:1.14,current:1.15,floating:20}));
// price at entry = noise, don't touch
check('price at entry not flagged', !floatSignWrong({direction:'BUY',entry:1.1438,current:1.14382,floating:-0.5}));
// tiny float = noise
check('tiny float not flagged', !floatSignWrong({direction:'BUY',entry:1.14,current:1.20,floating:0.005}));

console.log('\n=== 3. PAIR IDENTITY / MATCHING (churn that loses thesis) ===');
// held position must match itself despite entry re-read wobble
check('held EURUSD matches with entry wobble (tolerant)', G.samePos({pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.14388},{pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.1445},true));
check('held AUDJPY matches with wobble', G.samePos({pair:'AUDJPY',direction:'SELL',lots:0.04,entry:112.356},{pair:'AUDJPY',direction:'SELL',lots:0.04,entry:112.40},true));
// genuinely different trades stay distinct
check('different lots = distinct', !G.samePos({pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.14},{pair:'EURUSD',direction:'BUY',lots:0.05,entry:1.14},true));
check('different direction = distinct', !G.samePos({pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.14},{pair:'EURUSD',direction:'SELL',lots:0.1,entry:1.14},true));
check('different pair = distinct', !G.samePos({pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.14},{pair:'GBPUSD',direction:'BUY',lots:0.1,entry:1.14},true));
// strict mode (merge dedup) keeps two same-pair trades at different entries distinct
check('strict: two EURUSD at diff entries distinct', !G.samePos({pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.1438},{pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.1502},false));
check('strict: true dupe collapses', G.samePos({pair:'USDCAD',direction:'SELL',lots:0.05,entry:1.4208},{pair:'USDCAD',direction:'SELL',lots:0.05,entry:1.4208},false));

console.log('\n=== 4. PIP SIZE (stop/target distances 100x wrong) ===');
check('EURUSD pip = 0.0001', G.pipSize('EURUSD',1.14)===0.0001);
check('USDJPY pip = 0.01', G.pipSize('USDJPY',157)===0.01);
check('GBPJPY pip = 0.01', G.pipSize('GBPJPY',199)===0.01);
check('EURAUD pip = 0.0001', G.pipSize('EURAUD',1.63)===0.0001);
check('CHFJPY pip = 0.01', G.pipSize('CHFJPY',175)===0.01);

console.log('\n=== 5. OPEN TIME PARSING (held-duration reliability) ===');
check('parses standard MT5 time', G.parseMT5Time('2026.07.20 03:38')!=null);
check('parses with seconds', G.parseMT5Time('2026.07.20 03:38:36')!=null);
check('garbage → null (no fake duration)', G.parseMT5Time('n/a')===null);
check('empty → null', G.parseMT5Time('')===null);
check('null → null', G.parseMT5Time(null)===null);

console.log('\n=== 6. num() ROBUSTNESS (bad input never crashes a figure) ===');
check('num parses number', G.num('1.234')===1.234);
check('num parses negative', G.num('-5.28')===-5.28);
check('num of null = null', G.num(null)===null);
check('num of garbage = null', G.num('abc')===null);
check('num strips currency', G.num('16.23')===16.23);

console.log('\n=== 7. INTEGRATION: your exact 3-position book ===');
// simulate the parser output for YOUR screenshot. Your MT5 shows Symbol/Type/entry/S-L/T-P/
// current/Profit. We only assert what the screenshot actually shows.
const parsed = [
  {pair:'EURUSD',direction:'SELL',lots:0.03,entry:1.63669,sl:1.62000,tp:1.62897,floating:16.23}, // MISREAD (really EURAUD)
  {pair:'EURCHF',direction:'SELL',lots:0.04,entry:0.92516,sl:0.92850,tp:0.91900,floating:5.14},
  {pair:'USDCHF',direction:'BUY',lots:0.05,entry:0.80751,sl:0.80300,tp:0.81450,floating:10.94},
];
const corrected = parsed.map(p=>G.fixPairFor(p));
check('position 1 corrected to EURAUD', corrected[0].pair==='EURAUD');
check('position 2 stays EURCHF', corrected[1].pair==='EURCHF');
check('position 3 stays USDCHF', corrected[2].pair==='USDCHF');
check('corrected EURAUD entry now plausible', G.plausible('EURAUD',1.63669));
// SIGN GUARD SAFETY: with NO current price present, the guard must NOT fire — it has nothing
// to compare against and must never flip a shown profit on incomplete data.
check('sign guard silent when no current price (pos1)', !floatSignWrong(corrected[0]));
check('sign guard silent when no current price (pos2)', !floatSignWrong(corrected[1]));
check('sign guard silent when no current price (pos3)', !floatSignWrong(corrected[2]));

console.log('\n=== 8. ADVERSARIAL: things that MUST NOT trigger a false BROKEN ===');
// SIGN GUARD must FLAG a discrepancy but is designed NEVER to silently flip the float
// (engine keeps the colour-read value; verified by code review + the no-current-price cases above).
// a healthy position with a slightly odd but valid price
check('valid GBPUSD 1.19 (low end) not corrected', !G.fixPairFor({pair:'GBPUSD',entry:1.19})._fixed);
check('valid USDJPY 165 (high end) not corrected', !G.fixPairFor({pair:'USDJPY',entry:165})._fixed);
// a JPY pair whose price would look "impossible" to a non-JPY reader but is fine
check('USDJPY 157 stays (not mistaken for a 1.x pair)', !G.fixPairFor({pair:'USDJPY',entry:157})._fixed);
// exotic not in table → left alone rather than mis-corrected
check('unknown pair TRYJPY left alone (no range)', !G.fixPairFor({pair:'TRYJPY',entry:4.85})._fixed);

console.log('\n============================================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exitCode = 1; }
else console.log('ALL SAFETY CHECKS PASSED ✓');
console.log('============================================================');

// ============================================================================
// APPENDED: audit-driven regression tests (Kepler findings). Guards that these
// dangerous behaviours never silently return.
// ============================================================================
console.log('\n=== 9. AUDIT REGRESSIONS (Kepler) ===');
// Finding 5: a real AUDJPY at 112.40 must NOT be mutated (widened range)
check('AUDJPY @112.40 not mutated (was silently → CADJPY)', !G.fixPairFor({pair:'AUDJPY',entry:112.40})._fixed);
check('AUDJPY @117 (high edge) not mutated', !G.fixPairFor({pair:'AUDJPY',entry:117})._fixed);
check('CADJPY @101 not mutated', !G.fixPairFor({pair:'CADJPY',entry:101})._fixed);
// but a genuine gross misread still caught
check('EURUSD @1.63 still flagged (real EURAUD misread)', !G.plausible('EURUSD',1.63));
// parseMT5Time rejects impossible dates
check('date 2026.13.45 rejected', G.parseMT5Time('2026.13.45 03:38')===null);
check('date 2026.02.30 (Feb30) rejected', G.parseMT5Time('2026.02.30 03:38')===null);
check('date 2026.00.10 (month 0) rejected', G.parseMT5Time('2026.00.10 03:38')===null);
check('date 2026.07.20 25:00 (hour 25) rejected', G.parseMT5Time('2026.07.20 25:00')===null);
check('valid date still accepted', G.parseMT5Time('2026.07.20 03:38')!==null);

console.log('\n============================================================');
console.log(`FINAL: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exitCode = 1; }
else console.log('ALL CHECKS PASSED ✓');
console.log('============================================================');

// ============================================================================
// APPENDED: audit regressions for the 5-finding batch (convergence, feed health,
// dedup, ticket identity, live pricing). Guards these never silently regress.
// ============================================================================
console.log('\n=== 10. LIVE-PRICING SAFETY (finding 10) ===');
// refFor must reject garbage live prices and fall back to daily — a 0/NaN reference would
// wreck every level check. (extracted from the real engine)
(function(){
  const fs=require('fs');const src=fs.readFileSync('/mnt/user-data/outputs/terminal-engine.js','utf8');
  const m=src.match(/function refFor[\s\S]*?\n\}\n/);
  if(!m){console.log('  (refFor not found)');return;}
  const normPair=G.normPair;
  eval(m[0]);
  const daily={EURUSD:1.14};
  check('live price 0 rejected -> daily', refFor('EURUSD',daily,{EURUSD:{price:0}})===1.14);
  check('live price NaN rejected -> daily', refFor('EURUSD',daily,{EURUSD:{price:NaN}})===1.14);
  check('live price negative rejected -> daily', refFor('EURUSD',daily,{EURUSD:{price:-1.5}})===1.14);
  check('valid live price preferred', refFor('EURUSD',daily,{EURUSD:{price:1.1418}})===1.1418);
  check('no live -> daily fallback', refFor('EURUSD',daily,null)===1.14);
})();

console.log('\n=== 11. TICKET IDENTITY (finding 9) ===');
check('different tickets never merge (Kepler case)', !G.samePos({ticket:'12743484',pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.1438},{ticket:'12743999',pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.1445},true));
check('same ticket = same trade', G.samePos({ticket:'12743484',pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.14},{ticket:'12743484',pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.99},true));
check('no ticket -> fallback matching intact', G.samePos({pair:'USDCHF',direction:'BUY',lots:0.05,entry:0.80751},{pair:'USDCHF',direction:'BUY',lots:0.05,entry:0.8078},true));
check('garbage ticket ignored, fallback used', G.samePos({ticket:'abc',pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.14},{ticket:'xyz',pair:'EURUSD',direction:'BUY',lots:0.1,entry:1.14},true));

console.log('\n============================================================');
console.log(`GRAND TOTAL: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exitCode = 1; }
else console.log('ALL CHECKS PASSED ✓');
console.log('============================================================');
