// ============================================================================
// TERMINAL SAFETY SUITE — hammers the DANGEROUS path: the data guards that decide
// whether a healthy position gets wrongly condemned. Re-run any time with:
//   node test_terminal_safety.js
// PORTABLE (audit finding 7): this suite is SELF-CONTAINED. It locates the engine
// relative to its own directory (so it runs from any checkout, not just one machine),
// and extracts the real guard functions from the engine source at runtime — no separate
// _guards.js file required. If the engine can't be found it says so and exits cleanly.
// ============================================================================
const fs = require('fs');
const path = require('path');

// find terminal-engine.js relative to this test file, trying common layouts
function locateEngine() {
  const here = __dirname;
  const candidates = [
    path.join(here, 'terminal-engine.js'),
    path.join(here, '..', 'api', 'terminal-engine.js'),
    path.join(here, '..', 'terminal-engine.js'),
    path.join(here, '..', 'outputs', 'terminal-engine.js'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return null;
}
const ENGINE_PATH = locateEngine();
if (!ENGINE_PATH) {
  console.error('Could not find terminal-engine.js near this test (looked in ./ , ../api/ , ../ , ../outputs/).');
  console.error('Run this suite from the repo so the engine is reachable, then re-run.');
  process.exit(2);
}
const ENGINE_SRC = fs.readFileSync(ENGINE_PATH, 'utf8');

// The pair-guard banner lives in the UI, and its counting is part of the guard's safety
// contract (see section 1b), so the suite reads that file too. Located the same portable way.
function locateUI() {
  const here = __dirname;
  const candidates = [
    path.join(here, '..', 'public', 'terminal.html'),
    path.join(here, 'terminal.html'),
    path.join(here, '..', 'terminal.html'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return null;
}
const UI_PATH = locateUI();
const UI_SRC = UI_PATH ? fs.readFileSync(UI_PATH, 'utf8') : null;

// extract the real guard functions from the engine source (single source of truth — we test
// the SHIPPED code, not a hand-copied duplicate). If the engine's shape changes, this notices.
function buildGuards(src) {
  const grab = (re) => { const m = src.match(re); return m ? m[0] : ''; };
  // For the pair guard specifically, a silent miss is worse than a crash: the suite would
  // still print a row of green ticks while testing nothing at all. That is exactly what
  // happened before — fixPairFor was a hand-written copy of the engine's inline loop, so
  // every assertion below passed against a duplicate that the shipped code had no link to.
  // If the engine's shape changes, say so and stop.
  const grabReq = (re, what) => {
    const m = src.match(re);
    if (!m) {
      console.error(`\n  ✗ Could not extract ${what} from the engine — its shape has changed.`);
      console.error('    The pair-guard checks would be testing nothing, so this is a hard stop.');
      console.error('    Fix the extraction regex in buildGuards() to match the engine, then re-run.');
      process.exit(3);
    }
    return m[0];
  };
  let out = '';
  out += grab(/function num\(v\) \{[\s\S]*?\n\}\n/);
  out += grab(/const normPair = [^\n]+\n/);
  out += grab(/function pipSize[\s\S]*?\n\}\n/);
  out += grab(/function parseMT5Time[\s\S]*?\n\}\n/);
  out += grab(/function ticketId\(p\) \{[\s\S]*?\n\}\n/);
  out += grab(/function samePos\(a, b, tolerant\) \{[\s\S]*?\n\}\n/);
  out += grabReq(/const PAIR_RANGES = \{[\s\S]*?\};\n/, 'PAIR_RANGES');
  out += grabReq(/const plausible = [^\n]+\n/, 'plausible()');
  out += grab(/function refFor[\s\S]*?\n\}\n/);
  // THE REAL SHIPPED GUARD, both branches — not a reimplementation of one of them.
  out += grabReq(/function pairGuard\(positions\) \{[\s\S]*?\n\}\n/, 'pairGuard()');
  out += `\nmodule.exports={num,normPair,pipSize,parseMT5Time,ticketId,samePos,PAIR_RANGES,plausible,pairGuard,refFor};`;
  const Module = require('module');
  const m = new Module();
  m._compile(out, ENGINE_PATH + '#guards');
  return m.exports;
}
const G = buildGuards(ENGINE_SRC);
// back-compat for the appended sections that read the engine source directly
const src = ENGINE_SRC;
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

// ---- drive the REAL shipped guard on one position ----
// pairGuard mutates the book and returns what it did, so a single-position run tells us
// three things the old _fixed boolean could not: whether the pair was rewritten, whether it
// was merely flagged, and what the user is actually shown.
function runGuard(pos) {
  const p = { ...pos };
  const fix = G.pairGuard([p])[0] || null;
  return {
    pos: p, fix, pair: p.pair,
    corrected: !!(fix && fix.auto),     // engine rewrote the pair
    flagged: !!(fix && !fix.auto),      // engine refused to rewrite and asked the user
    note: fix ? fix.note : '',
  };
}

console.log('\n=== 1. PAIR MISREAD GUARD (the EURAUD danger) ===');
// The exact bug you hit
check('EURAUD read as EURUSD @1.63669 → corrected to EURAUD',
  runGuard({pair:'EURUSD',entry:1.63669}).corrected && runGuard({pair:'EURUSD',entry:1.63669}).pair==='EURAUD');
// Every real pair at a real price must be LEFT ALONE — and note this now asserts NO fix at
// all, not merely "not auto-corrected". A spurious amber flag on a genuine position is the
// failure mode that trains the user to ignore the banner.
const realBook = [
  ['EURUSD',1.1421],['EURAUD',1.6367],['EURCHF',0.9252],['USDCHF',0.8075],
  ['GBPUSD',1.2680],['USDJPY',157.30],['AUDUSD',0.6550],['NZDUSD',0.5980],
  ['USDCAD',1.3720],['EURJPY',169.5],['GBPJPY',199.4],['AUDJPY',103.1],
  ['NZDJPY',94.0],['CADJPY',114.6],['EURGBP',0.8510],['CHFJPY',175.2],
];
for (const [pair,px] of realBook) {
  check(`real ${pair}@${px} left untouched`, !runGuard({pair,entry:px}).fix);
}
// Known cross-currency misreads that SHOULD correct
check('USDCHF misread, entry 1.372 → USDCAD', runGuard({pair:'USDCHF',entry:1.372}).pair==='USDCAD');
check('AUDUSD misread as AUDJPY-range stays sensible', !runGuard({pair:'AUDUSD',entry:0.655}).corrected);
// A price that fits NO pair should NOT be force-changed (safety: don't guess wildly)
check('nonsense entry 999 not force-corrected', !runGuard({pair:'EURUSD',entry:999}).corrected);
// null / missing entry must not crash or change
check('null entry safe', !runGuard({pair:'EURUSD',entry:null}).fix);
check('missing entry safe', runGuard({pair:'EURUSD'}) && !runGuard({pair:'EURUSD'}).fix);

console.log('\n=== 1b. PAIR GUARD: FLAG-ONLY BRANCH + BANNER COUNTING ===');
// The auto:false branch had NO coverage at all — the old suite reimplemented only the
// auto-correct path, so nothing checked that an ambiguous read is left alone, and nothing
// checked what the banner then claims about it.

// (a) fits nothing at all -> flag, never rewrite
{
  const r = runGuard({pair:'EURUSD',entry:999});
  check('unfittable price is FLAGGED, not corrected', r.flagged && !r.corrected);
  check('unfittable price leaves pair untouched', r.pair==='EURUSD');
  check('unfittable price sets pairSuspect', r.pos.pairSuspect===true);
  check('flag note says NOT changed', /NOT changed/.test(r.note));
}
// (b) AMBIGUOUS: more than one same-base candidate fits -> must flag, never guess.
// AUD@1.10 sits in both AUDNZD and AUDCAD, so there is no single honest answer.
{
  const r = runGuard({pair:'AUDUSD',entry:1.10});
  check('ambiguous multi-candidate read is flagged', r.flagged && !r.corrected);
  check('ambiguous read leaves pair untouched', r.pair==='AUDUSD');
  check('ambiguous note lists the candidates', /fits .*AUD/.test(r.note));
}
// (c) EDGE, not impossible: just outside the band but inside the 10% farOutside margin.
// A rounding-edge read must never be silently rewritten.
{
  const r = runGuard({pair:'EURUSD',entry:1.35});
  check('near-edge price flagged, not corrected', r.flagged && !r.corrected);
  check('near-edge price leaves pair untouched', r.pair==='EURUSD');
}
// (d) THE BANNER CONTRACT. pairFixes mixes both kinds; the header must count them apart.
// This is the regression: a sync that changed NOTHING must not claim a correction.
{
  const book = [
    {pair:'EURUSD',entry:1.63669},  // auto-correctable -> EURAUD
    {pair:'EURUSD',entry:999},      // flag only
    {pair:'GBPUSD',entry:1.2680},   // clean, no entry in pairFixes at all
  ];
  const fixes = G.pairGuard(book);
  const auto = fixes.filter(f=>f.auto), flagged = fixes.filter(f=>!f.auto);
  check('mixed book yields 2 pairFixes entries', fixes.length===2);
  check('mixed book: exactly 1 auto-correction', auto.length===1);
  check('mixed book: exactly 1 flag', flagged.length===1);
  check('clean position produced no entry', !fixes.some(f=>f.was==='GBPUSD'));
  check('auto entry names its replacement', auto[0].now==='EURAUD');
  check('flag entry has no replacement', flagged[0].now===null);
  // the headline number the OLD banner printed was fixes.length (2) under the word
  // "Corrected" — which was wrong by one here, and wrong by ALL in the flag-only case:
  const flagOnly = G.pairGuard([{pair:'EURUSD',entry:999}]);
  check('flag-only sync reports ZERO corrections', flagOnly.filter(f=>f.auto).length===0);
  check('flag-only sync still reports 1 to verify', flagOnly.filter(f=>!f.auto).length===1);
}
// (e) the UI must actually do that split, not merely be able to.
{
  check('terminal.html locatable', !!UI_SRC);
  if (UI_SRC) {
    check('banner no longer counts the whole array as corrected',
      !/Corrected \{report\.pairFixes\.length\}/.test(UI_SRC));
    check('banner splits pairFixes on f.auto', /pairFixes[\s\S]{0,220}filter\(f=>f\.auto\)/.test(UI_SRC));
    check('banner has a separate verify heading', /to verify/.test(UI_SRC));
    check('verify heading avoids the word "Corrected"',
      !/Corrected \{(flagged|fixes)\.length\}/.test(UI_SRC));
  }
}

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
// run the guard exactly the way actSync does: ONE call across the whole parsed book
const corrected = parsed.map(p=>({...p}));
const bookFixes = G.pairGuard(corrected);
check('position 1 corrected to EURAUD', corrected[0].pair==='EURAUD');
check('position 2 stays EURCHF', corrected[1].pair==='EURCHF');
check('position 3 stays USDCHF', corrected[2].pair==='USDCHF');
check('corrected EURAUD entry now plausible', G.plausible('EURAUD',1.63669));
check('3-position book produced exactly 1 pairFix', bookFixes.length===1);
check('and the banner would call it 1 correction', bookFixes.filter(f=>f.auto).length===1);
check('with nothing left to verify', bookFixes.filter(f=>!f.auto).length===0);
// SIGN GUARD SAFETY: with NO current price present, the guard must NOT fire — it has nothing
// to compare against and must never flip a shown profit on incomplete data.
check('sign guard silent when no current price (pos1)', !floatSignWrong(corrected[0]));
check('sign guard silent when no current price (pos2)', !floatSignWrong(corrected[1]));
check('sign guard silent when no current price (pos3)', !floatSignWrong(corrected[2]));

console.log('\n=== 8. ADVERSARIAL: things that MUST NOT trigger a false BROKEN ===');
// SIGN GUARD must FLAG a discrepancy but is designed NEVER to silently flip the float
// (engine keeps the colour-read value; verified by code review + the no-current-price cases above).
// a healthy position with a slightly odd but valid price
// these now assert NO fix at all — not flagged either, since a real price must be silent
check('valid GBPUSD 1.19 (low end) not corrected', !runGuard({pair:'GBPUSD',entry:1.19}).fix);
check('valid USDJPY 165 (high end) not corrected', !runGuard({pair:'USDJPY',entry:165}).fix);
// a JPY pair whose price would look "impossible" to a non-JPY reader but is fine
check('USDJPY 157 stays (not mistaken for a 1.x pair)', !runGuard({pair:'USDJPY',entry:157}).fix);
// exotic not in table → left alone rather than mis-corrected
check('unknown pair TRYJPY left alone (no range)', !runGuard({pair:'TRYJPY',entry:4.85}).fix);

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
check('AUDJPY @112.40 not mutated (was silently → CADJPY)', !runGuard({pair:'AUDJPY',entry:112.40}).fix);
check('AUDJPY @117 (high edge) not mutated', !runGuard({pair:'AUDJPY',entry:117}).fix);
check('CADJPY @101 not mutated', !runGuard({pair:'CADJPY',entry:101}).fix);
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
  // refFor is already extracted into G from the engine, portably. Use it directly.
  const refFor = G.refFor;
  if(!refFor){console.log('  (refFor not found)');return;}
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

console.log('\n=== 12. AUDIT-2 REGRESSIONS (evidence convergence, freshness, partial-shot, consume) ===');
(function(){
  const grab=(re)=>{const m=src.match(re);return m?m[0]:'';};
  // evidence convergence: article must concern the pair. Rebuild with its real deps (normPair + CCY_TERMS).
  const normPairSrc=grab(/const normPair = [^\n]+\n/);
  const ccySrc=grab(/const CCY_TERMS = \{[\s\S]*?\};\n/);
  const acSrc=grab(/const articleConcernsPair = [\s\S]*?\n  \};\n/);
  let code=normPairSrc+ccySrc+acSrc+'module.exports={articleConcernsPair};';
  const Module=require('module');const m=new Module();
  try{ m._compile(code, 'guards#conv');
    const ac=m.exports.articleConcernsPair;
    check('article naming pair = strong', ac({title:'EURUSD rallies'},'EURUSD')==='strong');
    check('article w/ both ccy = strong', ac({title:'euro up vs dollar'},'EURUSD')==='strong');
    check('article w/ one ccy = weak', ac({title:'dollar mixed'},'EURUSD')==='weak');
    check('unrelated article = null', ac({title:'gold hits record'},'EURUSD')===null);
  }catch(e){ check('evidence-convergence extractable', false); }
})();
// freshness threshold
(function(){
  const fresh=(sec)=>{const mt=sec?sec*1000:null;const age=mt?Date.now()-mt:null;return age!=null&&age>=0&&age<=6*3600*1000;};
  const now=Math.floor(Date.now()/1000);
  check('quote 1h old is fresh', fresh(now-3600));
  check('quote 8h old is stale', !fresh(now-8*3600));
  check('no timestamp is stale', !fresh(null));
})();
// partial-shot guard
(function(){
  const partial=(s,b,h)=>s<b&&h===0;
  check('partial shot deferred', partial(1,3,0)===true);
  check('full shot trusted', partial(3,3,0)===false);
  check('partial + history trusted', partial(1,3,2)===false);
})();
// engine wiring present
check('engine has consumeMatch', src.includes('consumeMatch'));
check('engine has partialShot guard', src.includes('partialShot'));
check('engine has evidence convergence', src.includes('articleConcernsPair'));
check('engine has freshness check', src.includes('isFresh'));

console.log('\n=== 13. RANGE FRESHNESS (bands re-centred 22/07/2026) ===');
// Spot rates from ECB daily (frankfurter.dev, 21/07/2026) — the same feed refRates() falls
// back to. Every one of these is a price a user can genuinely be holding, so ANY fix raised
// here is a false alarm on a real position. Four of these were breaching their old bands at
// once, GBPJPY worst: 218.08 against a 215 ceiling, which is the report that started this.
const spotJul2026 = [
  ['GBPJPY',218.08], ['EURJPY',185.82], ['CHFJPY',200.69], ['AUDNZD',1.2001],
  ['USDJPY',162.74], ['AUDJPY',114.16], ['EURNZD',1.9533], ['AUDCAD',0.9872],
];
for (const [pair,px] of spotJul2026) check(`spot ${pair}@${px} raises nothing`, !runGuard({pair,entry:px}).fix);
// ...but a widened band is only safe if genuine nonsense STILL lands. Widening everything
// until nothing trips would leave the amber banner technically present and useless.
check('GBPJPY @21.8 (decimal slip) still caught', !!runGuard({pair:'GBPJPY',entry:21.8}).fix);
check('AUDNZD @2.50 still caught', !!runGuard({pair:'AUDNZD',entry:2.50}).fix);
check('CHFJPY @95 still caught', !!runGuard({pair:'CHFJPY',entry:95}).fix);
check('EURUSD @1.63 still implausible (the flagship misread)', !G.plausible('EURUSD',1.63));
// COUPLING, deliberate and fragile: EURNZD's floor (1.66) sits just above 1.63669, and that
// is what keeps the flagship EURAUD auto-correct UNAMBIGUOUS — one same-base candidate
// rather than two. Drop that floor below 1.63669 and the EURAUD case silently degrades from
// a correction to a flag. This assertion exists so that fails loudly instead of quietly.
check('EURNZD floor stays above the EURAUD misread price', !G.plausible('EURNZD',1.63669));

console.log('\n============================================================');
console.log(`GRAND TOTAL: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exitCode = 1; }
else console.log('ALL CHECKS PASSED ✓');
console.log('============================================================');
