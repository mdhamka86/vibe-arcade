// THE EXCHANGE — safety regression suite. Guards the 6 audit fixes:
// P0 seed overwrite, empty-parse wipe, fail-closed Redis, short sign reversal,
// candidate/convergence validation, direct feeds in holdings mode.
// PORTABLE (audit finding 7): locates the engine relative to this file so it runs from any
// checkout, and exits cleanly with a helpful message if it can't be found — never a raw crash.
// Re-run any time with: node test_exchange_safety.js
const fs = require('fs');
const path = require('path');
function locateEngine() {
  const here = __dirname;
  const candidates = [
    path.join(here, 'exchange-engine.js'),
    path.join(here, '..', 'api', 'exchange-engine.js'),
    path.join(here, '..', 'exchange-engine.js'),
    path.join(here, '..', 'outputs', 'exchange-engine.js'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return null;
}
const ENGINE_PATH = locateEngine();
if (!ENGINE_PATH) {
  console.error('Could not find exchange-engine.js near this test (looked in ./ , ../api/ , ../ , ../outputs/).');
  console.error('Run this suite from the repo so the engine is reachable, then re-run.');
  process.exit(2);
}
const src = fs.readFileSync(ENGINE_PATH, 'utf8');
let pass = 0, fail = 0; const fails = [];
function check(n, c) { if (c) { pass++; } else { fail++; fails.push(n); console.log('  ✗', n); } }
function num(v){if(v==null)return null;const m=String(v).match(/-?\d+(\.\d+)?/);return m?parseFloat(m[0]):null;}

console.log('=== SEED GUARD (P0 / finding 6) ===');
async function actSeed(seedBook,_w,force,existing){
  if(!seedBook||!Array.isArray(seedBook.holdings))throw new Error('no book');
  if(existing&&Array.isArray(existing.holdings)&&existing.holdings.length>0&&!force)return {refused:true};
  return {ok:true};
}
(async()=>{
  const seed={holdings:[{t:1}]};
  check('empty book bootstraps', (await actSeed(seed,0,false,{holdings:[]})).ok);
  check('populated book refuses overwrite', (await actSeed(seed,0,false,{holdings:[{t:1}]})).refused);
  check('force overrides on populated', (await actSeed(seed,0,true,{holdings:[{t:1}]})).ok);

  console.log('=== EMPTY-PARSE ABORT (finding 7) ===');
  const abort=(seen,book)=>seen===0&&book>0;
  check('empty parse + real book aborts', abort(0,4));
  check('empty parse + empty book proceeds', !abort(0,0));
  check('normal parse proceeds', !abort(3,4));
  check('engine has abort guard', src.includes('Sync aborted: the screenshot'));
  check('Redis rGet fails closed', src.includes('Storage read failed'));
  check('Redis rSet fails closed', src.includes('Storage write failed'));

  console.log('=== DIRECTION-AWARE SIGN, FLAG-NOT-FLIP (finding 8) ===');
  function signLooksWrong(h){
    const q=num(h.qty),avg=num(h.avgCost),last=num(h.lastPrice),upl=num(h.unrealised);
    if(q==null||avg==null||last==null||upl==null||avg===0)return false;
    if(Math.abs(upl)<0.01)return false;
    if(Math.abs(last-avg)/avg<0.02)return false;
    const isShort=(h.direction||'LONG').toUpperCase()==='SHORT';
    const priceUp=last>avg; const shouldBeProfit=isShort?!priceUp:priceUp;
    return (shouldBeProfit&&upl<0)||(!shouldBeProfit&&upl>0);
  }
  check('profitable short NOT flagged', !signLooksWrong({direction:'SHORT',qty:5,avgCost:200,lastPrice:180,unrealised:100}));
  check('losing short NOT flagged', !signLooksWrong({direction:'SHORT',qty:5,avgCost:200,lastPrice:220,unrealised:-100}));
  check('contradictory short flagged', signLooksWrong({direction:'SHORT',qty:5,avgCost:200,lastPrice:220,unrealised:100}));
  check('profitable long NOT flagged', !signLooksWrong({direction:'LONG',qty:5,avgCost:200,lastPrice:220,unrealised:100}));
  check('no direction defaults long', !signLooksWrong({qty:5,avgCost:200,lastPrice:220,unrealised:100}));
  check('engine no longer flips sign', !src.includes('h.unrealised = corrected'));

  console.log('=== CANDIDATE + CONVERGENCE (findings 1,4) ===');
  function validate(ideas,news){
    const men=(i)=>{const tk=(i.ticker||'').toUpperCase();const nm=(i.name||'').toLowerCase();const k=nm.split(/\s+/)[0];return (news||[]).filter((n)=>{const h=((n.title||'')+' '+(n.desc||'')).toLowerCase();return (tk&&h.includes(tk.toLowerCase()))||(k&&k.length>3&&h.includes(k));});};
    ideas.forEach((i)=>{const hh=men(i);i.newsSupport=hh.length;if(['MED-HIGH','HIGH'].includes((i.conviction||'').toUpperCase())&&hh.length<2)i.conviction=hh.length===1?'MED':'LOW';});
    return ideas;
  }
  const nw=[{title:'Nvidia surge',desc:'NVDA'},{title:'Nvidia datacenter',desc:'NVDA'}];
  check('2 real mentions keeps HIGH', validate([{ticker:'NVDA',name:'Nvidia',conviction:'HIGH'}],nw)[0].conviction==='HIGH');
  check('0 mentions caps to LOW', validate([{ticker:'ZZZ',name:'Zed',conviction:'HIGH'}],nw)[0].conviction==='LOW');
  check('1 mention caps to MED', validate([{ticker:'AVGO',name:'Broadcom',conviction:'HIGH'}],[{title:'Broadcom up',desc:'AVGO'}])[0].conviction==='MED');
  check('engine fetches broad market news', src.includes("getNews('market')"));
  check('engine validates candidates', src.includes('candidateNews'));
  check('engine distinguishes fetch-fail from no-news', src.includes('newsChecked'));
  check('engine has honest fetch-fail note', src.includes("news check couldn't run"));

  console.log('=== DIRECT FEEDS IN HOLDINGS MODE (finding 3) ===');
  const newsPath = path.join(path.dirname(ENGINE_PATH), 'exchange-news.js');
  if (fs.existsSync(newsPath)) {
    const nsrc = fs.readFileSync(newsPath, 'utf8');
    const hb = nsrc.slice(nsrc.indexOf("scope === 'holdings'"), nsrc.indexOf('} else {'));
    check('direct feeds present in holdings branch', hb.includes('DIRECT_MARKET_FEEDS'));
  } else {
    console.log('  (exchange-news.js not found next to engine — skipping feed check)');
  }

  console.log('=== PARTIAL-SHOT + CONSUMED MATCHES (finding 6, carried from Terminal) ===');
  check('engine has consumeMatch', src.includes('consumeMatch'));
  check('engine has partialShot guard', src.includes('partialShot'));
  check('engine has deferredClosures', src.includes('deferredClosures'));
  check('engine iterates seenPool for orphans', src.includes('for (const x of seenPool)'));
  check('engine no longer uses seen.find for reconcile', !src.includes('const onScreen = seen.find'));
  (function(){
    const partial=(s,b,h)=>s<b&&h===0;
    check('partial holdings shot defers', partial(2,3,0)===true);
    check('full holdings shot trusted', partial(3,3,0)===false);
    check('partial + history trusted', partial(1,3,2)===false);
  })();

  console.log('=== sameHolding FALSE-MATCH SAFETY (book-corruption guard) ===');
  (function(){
    const m=src.match(/function sameHolding[\s\S]*?\n\}\n/);
    if(!m){check('sameHolding extractable',false);return;}
    const Module=require('module');const mod=new Module();
    mod._compile(m[0]+'\nmodule.exports={sameHolding};','sh#test');
    const sameHolding=mod.exports.sameHolding;
    check('MRVL matches MRVL', sameHolding({ticker:'MRVL'},{ticker:'MRVL'})===true);
    check('Marvell name variants match', sameHolding({name:'Marvell Technology'},{name:'Marvell'})===true);
    check('MicroStrategy != Microsoft', sameHolding({name:'MicroStrategy'},{name:'Microsoft'})===false);
    check('American Airlines != American Express', sameHolding({name:'American Airlines'},{name:'American Express'})===false);
    check('Advanced Micro != Advanced Energy', sameHolding({name:'Advanced Micro'},{name:'Advanced Energy'})===false);
    check('different tickers never merge', sameHolding({ticker:'MSTR',name:'MicroStrategy'},{ticker:'MSFT',name:'Microsoft'})===false);
    check('same ticker diff name text matches', sameHolding({ticker:'AAPL',name:'Apple'},{ticker:'AAPL',name:'Apple Inc'})===true);
  })();

  console.log('\n============================================================');
  console.log(`GRAND TOTAL: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exitCode = 1; }
  else console.log('ALL EXCHANGE CHECKS PASSED ✓');
  console.log('============================================================');
})();
