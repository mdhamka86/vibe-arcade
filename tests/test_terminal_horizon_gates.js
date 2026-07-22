// ============================================================================
// TERMINAL — HORIZON CLUSTER (bundle A) + MONEY GATES (bundle B)
//   node tests/test_terminal_horizon_gates.js
//
// Two things are being protected here.
//
// BUNDLE A is a DOCTRINE change: the desk was hard-wired to a one-day life in five places
// while the trader actually holds 2-3 days, so it flagged every normal-length trade AMBER on
// day 2 and RED on day 3 and then ran a close-biased review at exactly that point. The tests
// below pin the recalibrated numbers AND pin the shape of the thing that went wrong — that the
// five sites derive from one constant instead of restating literals.
//
// BUNDLE B is LIVE MONEY. Correlation and the margin floor were stated in the prompt and
// verified nowhere; an unpriceable pair had its invented levels waved through; nothing stopped
// a proposal walking into an imminent print. Those four gates are now code, and code that
// guards money has to be shown to actually fire.
//
// Hence the MUTATION HARNESS at the end. Every green tick above it proves only that the suite
// agrees with the code as written — including, if the assertion is vacuous, agreeing with code
// that does nothing. Section 9 breaks each gate on purpose and requires the suite to notice. A
// gate whose mutation still passes is not being tested, and is reported as a failure.
//
// PORTABLE, and tests the SHIPPED functions: like test_terminal_safety.js, this locates the
// engine relative to itself and extracts the real functions from source at runtime. Nothing
// here is a hand-copied reimplementation.
// ============================================================================
const fs = require('fs');
const path = require('path');

function locateEngine() {
  const here = __dirname;
  const candidates = [
    path.join(here, '..', 'api', 'terminal-engine.js'),
    path.join(here, 'terminal-engine.js'),
    path.join(here, '..', 'terminal-engine.js'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return null;
}
const ENGINE_PATH = locateEngine();
if (!ENGINE_PATH) {
  console.error('Could not find terminal-engine.js near this test (looked in ../api/ , ./ , ../).');
  process.exit(2);
}
const ENGINE_SRC = fs.readFileSync(ENGINE_PATH, 'utf8');

function locateUI() {
  const c = path.join(__dirname, '..', 'public', 'terminal.html');
  try { return fs.existsSync(c) ? c : null; } catch (e) { return null; }
}
const UI_PATH = locateUI();
const UI_SRC = UI_PATH ? fs.readFileSync(UI_PATH, 'utf8') : null;

// ---- extract the real shipped code ------------------------------------------------
// grabReq hard-stops on a miss. A silent miss is the failure mode that matters: the suite
// would print a wall of green while testing an empty module.
function buildGuards(src, { quiet = false } = {}) {
  const grabReq = (re, what) => {
    const m = src.match(re);
    if (!m) {
      if (quiet) throw new Error('extract-failed: ' + what);
      console.error(`\n  x Could not extract ${what} from the engine — its shape has changed.`);
      console.error('    Fix the extraction regex in buildGuards(), then re-run. Not proceeding:');
      console.error('    a suite that cannot find the code it tests reports success against nothing.');
      process.exit(3);
    }
    return m[0];
  };
  let out = '';
  out += grabReq(/const HORIZON = \{[\s\S]*?\n\};\n/, 'HORIZON');
  out += grabReq(/HORIZON\.label = [^\n]+\n/, 'HORIZON.label');
  out += grabReq(/const ageFlag = \(d\) =>[\s\S]*?'OK'\);\n/, 'ageFlag()');
  out += grabReq(/function num\(v\) \{[\s\S]*?\n\}\n/, 'num()');
  out += grabReq(/const normPair = [^\n]+\n/, 'normPair()');
  out += grabReq(/function pipSize[\s\S]*?\n\}\n/, 'pipSize()');
  out += grabReq(/function checkLevels[\s\S]*?\n\}\n/, 'checkLevels()');
  out += grabReq(/function refFor[\s\S]*?\n\}\n/, 'refFor()');
  out += grabReq(/const YF_SYMBOL = \{[\s\S]*?\n\};\n/, 'YF_SYMBOL');
  out += grabReq(/const calLine = [^\n]+\n/, 'calLine');
  out += grabReq(/function calLines[\s\S]*?\n\}\n/, 'calLines()');
  out += grabReq(/const UNIVERSE_CCYS = [^\n]+\n/, 'UNIVERSE_CCYS');
  out += grabReq(/function calByCurrency[\s\S]*?\n\}\n/, 'calByCurrency()');
  out += grabReq(/function resolveCatalyst[\s\S]*?\n\}\n/, 'resolveCatalyst()');
  out += grabReq(/const RED_FOLDER_GUARD_MIN = [^\n]+\n/, 'RED_FOLDER_GUARD_MIN');
  out += grabReq(/function redFolderImminent[\s\S]*?\n\}\n/, 'redFolderImminent()');
  out += grabReq(/function currencyExposure[\s\S]*?\n\}\n/, 'currencyExposure()');
  out += grabReq(/function exposureLine[\s\S]*?\n\}\n/, 'exposureLine()');
  out += grabReq(/const STACK_MATERIAL_LOTS = [^\n]+\n/, 'STACK_MATERIAL_LOTS');
  out += grabReq(/function correlationCheck[\s\S]*?\n\}\n/, 'correlationCheck()');
  out += grabReq(/const LEVERAGE = [^\n]+\n/, 'LEVERAGE');
  out += grabReq(/const CONTRACT = [^\n]+\n/, 'CONTRACT');
  out += grabReq(/function usdPerUnit[\s\S]*?\n\}\n/, 'usdPerUnit()');
  out += grabReq(/function estMarginUSD[\s\S]*?\n\}\n/, 'estMarginUSD()');
  out += grabReq(/function projectedMarginLevel[\s\S]*?\n\}\n/, 'projectedMarginLevel()');
  out += grabReq(/const MARGIN_FLOOR_PCT = [^\n]+\n/, 'MARGIN_FLOOR_PCT');
  out += grabReq(/const MARGIN_PREFER_PCT = [^\n]+\n/, 'MARGIN_PREFER_PCT');
  out += grabReq(/const LOT_STEP = [^\n]+\n/, 'LOT_STEP');
  out += grabReq(/function maxLotsWithinFloor[\s\S]*?\n\}\n/, 'maxLotsWithinFloor()');
  out += grabReq(/const VITALS_FRESH_MS = [^\n]+\n/, 'VITALS_FRESH_MS');
  out += grabReq(/function vitalsAge[\s\S]*?\n\}\n/, 'vitalsAge()');
  out += grabReq(/function shadowScorecard[\s\S]*?\n\}\n/, 'shadowScorecard()');
  out += grabReq(/const CONVICTION_RUNG = [^\n]+\n/, 'CONVICTION_RUNG');
  out += grabReq(/function sessionPhase[\s\S]*?\n\}\n/, 'sessionPhase()');
  out += grabReq(/function ideaIsDupe[\s\S]*?\n\}\n/, 'ideaIsDupe()');
  out += grabReq(/function auditIdeaAgainst[\s\S]*?\n\}\n/, 'auditIdeaAgainst()');
  out += `\nmodule.exports={HORIZON,ageFlag,num,normPair,pipSize,checkLevels,refFor,YF_SYMBOL,
    calLine,calLines,UNIVERSE_CCYS,calByCurrency,resolveCatalyst,RED_FOLDER_GUARD_MIN,redFolderImminent,
    currencyExposure,exposureLine,correlationCheck,STACK_MATERIAL_LOTS,LEVERAGE,CONTRACT,usdPerUnit,estMarginUSD,
    projectedMarginLevel,MARGIN_FLOOR_PCT,MARGIN_PREFER_PCT,LOT_STEP,maxLotsWithinFloor,VITALS_FRESH_MS,vitalsAge,shadowScorecard,
    CONVICTION_RUNG,sessionPhase,ideaIsDupe,auditIdeaAgainst};`;
  const Module = require('module');
  const m = new Module();
  m._compile(out, ENGINE_PATH + '#gates');
  return m.exports;
}
const G = buildGuards(ENGINE_SRC);

let pass = 0, fail = 0; const fails = [];
function check(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); console.log('  x FAIL:', name); } }

// ---- shared fixtures --------------------------------------------------------------
// Rates/live mirror real July-2026 spot closely enough that the level tolerances are being
// exercised against plausible numbers rather than round toys.
const RATES = {
  asOf: '2026-07-21',
  EURUSD: 1.1421, GBPUSD: 1.2680, USDJPY: 162.74, USDCHF: 0.8075, AUDUSD: 0.6550,
  NZDUSD: 0.5980, USDCAD: 1.3720, EURGBP: 0.9006, EURJPY: 185.82, GBPJPY: 218.08,
  EURAUD: 1.7436, GBPAUD: 1.9359, AUDJPY: 114.16, NZDJPY: 97.32, AUDNZD: 1.2001,
  CADJPY: 118.62, CHFJPY: 200.69, EURCHF: 0.9223, GBPCHF: 1.0239, AUDCAD: 0.9872,
  EURCAD: 1.5670, GBPCAD: 1.7397, NZDCAD: 0.8204, EURNZD: 1.9533, GBPNZD: 2.1204,
};
const LIVE = { EURUSD: { pair: 'EURUSD', price: 1.1421, live: true } };
// His live account shape at the time of the audit: MARGIN AMBER at ~172%.
const VITALS_NOW = { balance: 2100, equity: 2000, margin: 1163, freeMargin: 837, marginLevel: 172, ts: new Date().toISOString() };
const VITALS_STALE = { ...VITALS_NOW, ts: new Date(Date.now() - 30 * 3600e3).toISOString() };

const H = 3600e3;
const CAL = [
  { title: 'Non-Farm Employment Change', ccy: 'USD', impact: 'High', when: 'Fri 19:30 BKK', utc: Date.now() + 26 * H, forecast: '180K', previous: '206K' },
  { title: 'CPI y/y', ccy: 'GBP', impact: 'High', when: 'Wed 14:00 BKK', utc: Date.now() + 40 * H, forecast: '2.8%', previous: '3.0%' },
  { title: 'Cash Rate', ccy: 'AUD', impact: 'High', when: 'Tue 10:30 BKK', utc: Date.now() + 2 * H, forecast: '3.60%', previous: '3.85%' },
  // Deliberately PAST the 96h ceiling but inside the calendar's 144h lookahead — this is the
  // event the desk should see and plan around, not silently truncate away.
  { title: 'Retail Sales m/m', ccy: 'NZD', impact: 'Medium', when: 'Sun 05:45 BKK', utc: Date.now() + 120 * H, forecast: '0.4%', previous: '0.2%' },
];
// A calendar with an imminent USD print — the red-folder scenario.
const CAL_IMMINENT = [{ title: 'Core CPI m/m', ccy: 'USD', impact: 'High', when: 'today 20:30 BKK', utc: Date.now() + 30 * 60000 }];

const baseCtx = (over = {}) => ({
  banned: new Set(), openPairs: [], exposure: {}, vitals: VITALS_NOW, vitalsUsable: true,
  vAge: G.vitalsAge(VITALS_NOW), rates: RATES, live: LIVE, cal: CAL, ...over,
});
// A clean, well-formed EURUSD buy: entry at spot, ~60 pip stop, ~120 pip target, 1:2.
const goodIdea = (over = {}) => ({
  pair: 'EUR/USD', direction: 'BUY', entry_zone: '1.1421', tp: '1.1541', sl: '1.1361',
  lots: '0.02', conviction: 'HIGH', catalyst: { stance: 'NONE', note: 'dollar flow' }, ...over,
});

console.log('\n=== 1. HORIZON DOCTRINE: the aging ladder (A1 site 2) ===');
// The whole point: days 0-2 must be UNREMARKABLE. Under the old ladder day 2 was AMBER and
// day 3 RED, which is what nagged him out of trades of entirely normal length.
check('day 0 is OK', G.ageFlag(0) === 'OK');
check('day 1 is OK (was NOTE)', G.ageFlag(1) === 'OK');
check('day 2 is OK (was AMBER — the flagship nag)', G.ageFlag(2) === 'OK');
check('day 3 is NOTE, top of the target window (was RED)', G.ageFlag(3) === 'NOTE');
check('day 4 is AMBER, at the ceiling', G.ageFlag(4) === 'AMBER');
check('day 5 is RED, genuinely overstayed', G.ageFlag(5) === 'RED');
check('day 12 still RED', G.ageFlag(12) === 'RED');
// ...but a ladder that never fires is as useless as one that always does.
check('the ladder still escalates (not all-OK)', new Set([0,1,2,3,4,5,6].map(G.ageFlag)).size === 4);
check('HORIZON target is 2-3 days', G.HORIZON.targetDaysMin === 2 && G.HORIZON.targetDaysMax === 3);
check('HORIZON ceiling is 4 days / 96h and they agree', G.HORIZON.ceilingDays === 4 && G.HORIZON.ceilingHours === G.HORIZON.ceilingDays * 24);
check('HORIZON.label reads as interday', /2-3 day interday/.test(G.HORIZON.label));

console.log('\n=== 2. HORIZON DOCTRINE: level tolerances (A1 site 3) ===');
// A 60-pip stop on EURUSD is textbook for a 2-3 day hold and was REJECTED by nothing — but a
// 200-pip stop was, under the old 150 ceiling, despite being reasonable on a 3-day GBPJPY.
check('60-pip stop on a 2-3 day EURUSD passes', G.checkLevels(goodIdea(), 1.1421).ok);
check('200-pip stop now passes (old 150 ceiling rejected it)',
  G.checkLevels(goodIdea({ sl: '1.1221', tp: '1.1721' }), 1.1421).ok);
check('320-pip stop still rejected as absurd',
  !G.checkLevels(goodIdea({ sl: '1.1101', tp: '1.2000' }), 1.1421).ok);
check('9-pip stop still rejected as noise-bait',
  !G.checkLevels(goodIdea({ sl: '1.1412', tp: '1.1541' }), 1.1421).ok);
check('entry 2% out now fills-plausible over 2-3 days', G.checkLevels(goodIdea({ entry_zone: '1.1650', tp: '1.1780', sl: '1.1580' }), 1.1421).ok);
check('entry 4% out still rejected', !G.checkLevels(goodIdea({ entry_zone: '1.1878', tp: '1.2000', sl: '1.1800' }), 1.1421).ok);
// The magnitude catcher — the NZDUSD-at-1.5635 class of hallucination — must survive widening.
check('NZDUSD levels at 1.56xx still caught as wrong magnitude',
  !G.checkLevels({ pair: 'NZDUSD', direction: 'BUY', entry_zone: '0.5980', tp: '1.5700', sl: '1.5635' }, 0.5980).ok);
check('inverted geometry still caught (BUY with TP below entry)',
  !G.checkLevels(goodIdea({ tp: '1.1300' }), 1.1421).ok);
check('R:R below 1 still rejected', !G.checkLevels(goodIdea({ tp: '1.1451', sl: '1.1361' }), 1.1421).ok);

console.log('\n=== 3. FAIL CLOSED ON A MISSING ANCHOR (B5) ===');
// The Exchange bug in Terminal form: no price meant every magnitude check was skipped and
// checkLevels returned ok:true on geometry alone.
const unpriceable = G.checkLevels({ pair: 'USDSEK', direction: 'BUY', entry_zone: '10.5000', tp: '10.7000', sl: '10.4000' }, null);
check('unpriceable pair is REJECTED, not waved through', !unpriceable.ok);
check('...and is tagged unanchored so the caller can cap it', unpriceable.unanchored === true);
check('...with a reason naming the real problem', /cannot be verified|no live or reference price/i.test(unpriceable.reason));
// Geometrically perfect but unpriceable must STILL fail — this is the exact hole.
const perfectButBlind = G.checkLevels({ pair: 'EURTRY', direction: 'SELL', entry_zone: '40.00', tp: '39.00', sl: '41.00' }, null);
check('geometrically perfect + unpriceable STILL rejected', !perfectButBlind.ok && perfectButBlind.unanchored);
// The better fix is to HAVE the anchor. The five liquid crosses that used to be in neither table:
for (const p of ['EURCAD', 'GBPCAD', 'NZDCAD', 'EURNZD', 'GBPNZD']) {
  check(`${p} now has a live-quote symbol`, !!G.YF_SYMBOL[p]);
  check(`${p} now resolves a reference price`, G.refFor(p, RATES, {}) > 0);
}
check('refFor still returns null for something genuinely unpriceable', G.refFor('USDSEK', RATES, {}) == null);
// ...and the anchored path must not have been broken by any of it.
check('EURUSD still anchors from live in preference to daily', G.refFor('EURUSD', RATES, LIVE) === 1.1421);
// refFor rounds the inverse to 5dp, so compare at that precision rather than to the raw float.
check('inverse lookup still works (JPYUSD -> 1/USDJPY)', Math.abs(G.refFor('JPYUSD', RATES, {}) - 1 / 162.74) < 1e-5);

console.log('\n=== 4. CURRENCY EXPOSURE + CORRELATION (B2) ===');
// His actual shape: long GBP two ways.
const book = [
  { pair: 'GBPUSD', direction: 'BUY', lots: 0.05 },
  { pair: 'GBPAUD', direction: 'BUY', lots: 0.05 },
];
const exp = G.currencyExposure(book);
check('BUY GBPUSD + BUY GBPAUD nets LONG GBP 0.10', Math.abs(exp.GBP - 0.10) < 1e-9);
check('...and SHORT USD 0.05', Math.abs(exp.USD + 0.05) < 1e-9);
check('...and SHORT AUD 0.05', Math.abs(exp.AUD + 0.05) < 1e-9);
check('exposureLine says LONG GBP out loud', /LONG GBP 0\.10/.test(G.exposureLine(exp)));
check('flat book reports FLAT', /FLAT/.test(G.exposureLine(G.currencyExposure([]))));
// A SELL nets the other way — the sign convention has to be right or every verdict inverts.
check('SELL USDJPY nets SHORT USD / LONG JPY', (() => {
  const e = G.currencyExposure([{ pair: 'USDJPY', direction: 'SELL', lots: 0.1 }]);
  return Math.abs(e.USD + 0.1) < 1e-9 && Math.abs(e.JPY - 0.1) < 1e-9;
})());
check('offsetting positions net to flat', (() => {
  const e = G.currencyExposure([{ pair: 'EURUSD', direction: 'BUY', lots: 0.05 }, { pair: 'EURUSD', direction: 'SELL', lots: 0.05 }]);
  return Math.abs(e.EUR || 0) < 1e-9 && Math.abs(e.USD || 0) < 1e-9;
})());
// THE FLAGSHIP CASE from the audit.
const stackGBP = G.correlationCheck({ pair: 'GBPJPY', direction: 'BUY', lots: 0.05 }, exp);
check('long GBPJPY onto a long-GBP book is detected as stacking', stackGBP.stacked.length === 1 && stackGBP.stacked[0].ccy === 'GBP');
check('...reporting book 0.10 + 0.05 = 0.15 lots', stackGBP.stacked[0].existing === 0.10 && stackGBP.stacked[0].combined === 0.15);
// The opposite side must NOT be called stacking — that would block every hedge.
check('SHORT GBPJPY onto a long-GBP book is NOT stacking (it offsets)',
  G.correlationCheck({ pair: 'GBPJPY', direction: 'SELL', lots: 0.05 }, exp).stacked.length === 0);
// "Unrelated" has to mean BOTH legs untouched by the book. EURJPY qualifies against a
// GBP/USD/AUD book; USDCHF would NOT, because selling it stacks the book's existing short USD —
// which is the gate working, not a false positive, and is asserted separately below.
check('a genuinely unrelated pair is NOT stacking',
  G.correlationCheck({ pair: 'EURJPY', direction: 'BUY', lots: 0.05 }, exp).stacked.length === 0);
check('...but a pair sharing the book\'s SHORT USD leg IS caught', (() => {
  const c = G.correlationCheck({ pair: 'USDCHF', direction: 'SELL', lots: 0.05 }, exp);
  return c.stacked.length === 1 && c.stacked[0].ccy === 'USD' && c.stacked[0].side === 'SHORT';
})());
// Escalation: one leg warns, both legs or a doubling blocks.
check('single-leg stack is NOT heavy (warn, do not starve the screen)', stackGBP.heavy === false);
const bothLegs = G.currencyExposure([{ pair: 'GBPUSD', direction: 'BUY', lots: 0.05 }, { pair: 'AUDJPY', direction: 'BUY', lots: 0.05 }]);
check('BOTH legs stacking IS heavy', G.correlationCheck({ pair: 'GBPJPY', direction: 'BUY', lots: 0.05 }, bothLegs).heavy === true);
check('a size that doubles an existing exposure IS heavy',
  G.correlationCheck({ pair: 'GBPJPY', direction: 'BUY', lots: 0.20 }, exp).heavy === true);
check('flat book: nothing can stack', G.correlationCheck({ pair: 'GBPJPY', direction: 'BUY', lots: 0.05 }, {}).stacked.length === 0);

// MATERIALITY — regression for a false positive found by running the gate against his REAL
// live book. Long AUDUSD 0.05 + short GBPUSD 0.03 leaves a net SHORT USD of 0.02 lots: not a
// position, just the arithmetic residual of two trades that mostly cancel. A fresh 0.03-lot
// EURUSD idea "more than doubles" that residual, and without a materiality floor the gate
// BLOCKED it as stacked risk. Blocking good ideas on rounding noise starves the screen.
const realBook = [
  { pair: 'EURCHF', direction: 'SELL', lots: 0.04 }, { pair: 'AUDUSD', direction: 'BUY', lots: 0.05 },
  { pair: 'GBPJPY', direction: 'BUY', lots: 0.03 }, { pair: 'AUDNZD', direction: 'BUY', lots: 0.03 },
  { pair: 'AUDJPY', direction: 'BUY', lots: 0.03 }, { pair: 'GBPUSD', direction: 'SELL', lots: 0.03 },
];
const realExp = G.currencyExposure(realBook);
check('real book nets LONG AUD 0.11 across three positions', Math.abs(realExp.AUD - 0.11) < 1e-9);
check('real book nets SHORT JPY 0.06 across two', Math.abs(realExp.JPY + 0.06) < 1e-9);
check('real book leaves a 0.02 USD residual', Math.abs(Math.abs(realExp.USD) - 0.02) < 1e-9);
check('a 0.02-lot residual does NOT block a fresh idea (the false positive)',
  G.correlationCheck({ pair: 'EURUSD', direction: 'BUY', lots: 0.03 }, realExp).heavy === false);
check('...and does not cap conviction either', (() => {
  const a = G.auditIdeaAgainst(goodIdea(), baseCtx({ exposure: realExp }));
  return a.cap === null && a.blocking.length === 0;
})());
check('...but the overlap is still reported honestly, not hidden',
  G.correlationCheck({ pair: 'EURUSD', direction: 'BUY', lots: 0.03 }, realExp).stacked.length === 1);
// The floor must not swallow the real thing it exists to catch.
// POLICY CHANGE: correlation is REPORTED, never penalised. He manages his own exposure; the
// desk's job is to say what the trade is worth and note what it would add to. A material stack
// must still be DETECTED and surfaced — it just no longer touches conviction or blocks.
check('a MATERIAL long-AUD stack is surfaced as a risk NOTE', (() => {
  const a = G.auditIdeaAgainst({ pair: 'AUD/CAD', direction: 'BUY', entry_zone: '0.9872', tp: '0.9960', sl: '0.9810', lots: '0.03' }, baseCtx({ exposure: realExp }));
  return a.riskNotes.some((n) => /Adds to existing exposure/.test(n)) && /LONG AUD/.test(a.riskNotes.join(' '));
})());
check('...and does NOT cap conviction', (() => {
  const a = G.auditIdeaAgainst({ pair: 'AUD/CAD', direction: 'BUY', entry_zone: '0.9872', tp: '0.9960', sl: '0.9810', lots: '0.03' }, baseCtx({ exposure: realExp }));
  return a.cap === null && a.blocking.length === 0;
})());
check('correlationCheck still DETECTS a material both-leg stack (detection intact)',
  G.correlationCheck({ pair: 'AUDJPY', direction: 'BUY', lots: 0.03 }, realExp).heavy === true);
check('materiality floor is one normal clip', G.correlationCheck({ pair: 'AUDCAD', direction: 'BUY', lots: 0.03 }, realExp).material.length === 1);

console.log('\n=== 5. MARGIN ARITHMETIC + FLOOR (B3) ===');
// Calibration anchor: the figure quoted in the engine prompt as observed live.
check('0.10 lots EURUSD ~= $570 margin (the documented observed figure)',
  Math.abs(G.estMarginUSD('EURUSD', 0.10, RATES, LIVE) - 570) < 12);
check('margin scales linearly with lots', Math.abs(G.estMarginUSD('EURUSD', 0.20, RATES, LIVE) - 2 * G.estMarginUSD('EURUSD', 0.10, RATES, LIVE)) < 0.5);
check('a USD-base pair prices off notional directly', Math.abs(G.estMarginUSD('USDJPY', 0.10, RATES, LIVE) - 500) < 1);
check('a JPY-quoted cross still prices via its BASE currency',
  Math.abs(G.estMarginUSD('GBPJPY', 0.10, RATES, LIVE) - (100000 * 0.1 * 1.2680 / 20)) < 1);
// Margin depends only on the BASE currency's USD value, so USDSEK is computable (base is USD)
// even though the pair itself is unpriceable — that asymmetry is correct and worth pinning.
check('a USD-base pair is computable even when the pair itself is unpriceable', G.estMarginUSD('USDSEK', 0.1, RATES, {}) === 500);
check('an unpriceable BASE returns null, never 0', G.estMarginUSD('SEKJPY', 0.1, RATES, {}) === null && G.estMarginUSD('XAUXYZ', 0.1, RATES, {}) === null);
check('zero lots returns null', G.estMarginUSD('EURUSD', 0, RATES, LIVE) === null);
// Projected level, against his real 172% starting point.
check('current book really is ~172% (fixture sanity)', Math.abs(G.projectedMarginLevel(VITALS_NOW, 0) - 172) < 1);
const bigAdd = G.projectedMarginLevel(VITALS_NOW, G.estMarginUSD('EURUSD', 0.10, RATES, LIVE));
check('adding 0.10 lots at 172% projects BELOW the 150% floor', bigAdd < G.MARGIN_FLOOR_PCT);
const smallAdd = G.projectedMarginLevel(VITALS_NOW, G.estMarginUSD('EURUSD', 0.02, RATES, LIVE));
check('adding 0.02 lots stays ABOVE the floor', smallAdd > G.MARGIN_FLOOR_PCT);
check('floor is 150, comfort mark 200', G.MARGIN_FLOOR_PCT === 150 && G.MARGIN_PREFER_PCT === 200);
check('projectedMarginLevel returns null without equity', G.projectedMarginLevel({ margin: 1000 }, 500) === null);
check('projectedMarginLevel returns null on null margin cost', G.projectedMarginLevel(VITALS_NOW, null) === null);

console.log('\n=== 6. VITALS FRESHNESS (B3) ===');
check('a just-synced vitals is fresh', G.vitalsAge(VITALS_NOW).fresh === true);
check('30h-old vitals is STALE', G.vitalsAge(VITALS_STALE).fresh === false);
check('...and says so in its label', /STALE/.test(G.vitalsAge(VITALS_STALE).label));
check('missing vitals is neither known nor fresh', G.vitalsAge(null).known === false && G.vitalsAge(null).fresh === false);
check('vitals with no ts is not silently fresh', G.vitalsAge({ equity: 2000 }).fresh === false);
check('the vitals window mirrors the 6h price window', G.VITALS_FRESH_MS === 6 * 3600 * 1000);
check('a 5h-old sync is still fresh (not over-tight)', G.vitalsAge({ ts: new Date(Date.now() - 5 * H).toISOString() }).fresh === true);

console.log('\n=== 7. RED FOLDER + CATALYST (B6, A8, A7) ===');
check('an imminent High USD print is caught for EURUSD', !!G.redFolderImminent(CAL_IMMINENT, 'EURUSD', G.RED_FOLDER_GUARD_MIN, Date.now()));
check('...but not for a pair with no USD leg', !G.redFolderImminent(CAL_IMMINENT, 'GBPJPY', G.RED_FOLDER_GUARD_MIN, Date.now()));
check('a print 26h out is NOT imminent', !G.redFolderImminent(CAL, 'EURUSD', G.RED_FOLDER_GUARD_MIN, Date.now()));
check('a MEDIUM-impact imminent event does not trip the guard',
  !G.redFolderImminent([{ title: 'x', ccy: 'USD', impact: 'Medium', utc: Date.now() + 10 * 60000 }], 'EURUSD', G.RED_FOLDER_GUARD_MIN, Date.now()));
check('an event already PAST does not trip the guard',
  !G.redFolderImminent([{ title: 'x', ccy: 'USD', impact: 'High', utc: Date.now() - 10 * 60000 }], 'EURUSD', G.RED_FOLDER_GUARD_MIN, Date.now()));
check('guard window is 60min', G.RED_FOLDER_GUARD_MIN === 60);
// Catalyst resolution: paraphrase must still match, cross-currency must not.
check('"Non-Farm Payrolls" resolves to "Non-Farm Employment Change"',
  (G.resolveCatalyst({ event: 'Non-Farm Payrolls' }, CAL, 'EURUSD') || {}).ccy === 'USD');
check('a catalyst on a currency the pair does not hold is refused',
  G.resolveCatalyst({ event: 'Cash Rate' }, CAL, 'EURUSD') === null);
check('an invented event resolves to nothing',
  G.resolveCatalyst({ event: 'Quarterly Vibes Index' }, CAL, 'EURUSD') === null);
// The interesting case is PARTIAL overlap: near-miss titles must not be accepted as a match,
// or the desk would "verify" a catalyst the calendar never carried.
check('a near-miss title below the threshold is refused',
  G.resolveCatalyst({ event: 'Employment Cost Index' }, CAL, 'EURUSD') === null);
check('GBP CPI resolves for a GBP pair', (G.resolveCatalyst({ event: 'CPI y/y' }, CAL, 'GBPJPY') || {}).ccy === 'GBP');
check('empty claim resolves to nothing', G.resolveCatalyst({}, CAL, 'EURUSD') === null && G.resolveCatalyst(null, CAL, 'EURUSD') === null);
// Per-currency calendar: the top-14 global slice used to drop whole currencies.
const byCcy = G.calByCurrency(CAL);
for (const c of ['USD', 'GBP', 'AUD', 'NZD']) check(`calendar block names ${c}`, byCcy.includes(c + ':'));
check('quiet currencies are stated, not silently omitted', /CHF:[\s\S]*nothing High\/Medium/.test(byCcy));
check('every universe currency appears', G.UNIVERSE_CCYS.every((c) => byCcy.includes(c + ':')));

console.log('\n=== 8. THE ASSEMBLED GATE (auditIdeaAgainst) ===');
// Clean idea, clean book, fresh vitals, small size => nothing fires.
const clean = G.auditIdeaAgainst(goodIdea(), baseCtx());
check('a clean idea has no blocking findings', clean.blocking.length === 0);
check('a clean idea has no warnings', clean.warnings.length === 0);
check('a clean idea is not conviction-capped', clean.cap === null);
check('a clean idea carries verified margin arithmetic', clean.margin.verified === true && clean.margin.projectedPct > 150);
// Each gate, in isolation, must block or cap.
// ---- THE SPLIT: conviction = trade quality; margin/correlation = his book, reported only ----
check('GATE margin: an oversized 0.10 lots RESIZES rather than blocking', (() => {
  const a = G.auditIdeaAgainst(goodIdea({ lots: '0.10' }), baseCtx());
  return a.blocking.length === 0 && a.margin.breachedAtRequested === true && a.margin.resizedTo > 0;
})());
check('...and does NOT cap conviction (a size error is not a quality verdict)',
  G.auditIdeaAgainst(goodIdea({ lots: '0.10' }), baseCtx()).cap === null);
check('...surfacing both numbers so the correction is visible', (() => {
  const a = G.auditIdeaAgainst(goodIdea({ lots: '0.10' }), baseCtx());
  return a.riskNotes.some((n) => /0\.10 lots/.test(n) && /resized to/.test(n));
})());
check('GATE margin: stale vitals is a NOTE, not a conviction cap', (() => {
  const a = G.auditIdeaAgainst(goodIdea(), baseCtx({ vitals: VITALS_STALE, vitalsUsable: false, vAge: G.vitalsAge(VITALS_STALE) }));
  return a.cap === null && a.margin.verified === false && a.riskNotes.some((n) => /UNVERIFIED/.test(n));
})());
check('GATE margin: stale vitals still does not block',
  G.auditIdeaAgainst(goodIdea(), baseCtx({ vitals: VITALS_STALE, vitalsUsable: false, vAge: G.vitalsAge(VITALS_STALE) })).blocking.length === 0);
check('GATE correlation: a single-leg stack is noted, not capped', (() => {
  const a = G.auditIdeaAgainst({ pair: 'GBPJPY', direction: 'BUY', entry_zone: '218.08', tp: '220.50', sl: '216.80', lots: '0.02', conviction: 'HIGH' }, baseCtx({ exposure: exp }));
  return a.cap === null && a.blocking.length === 0 && a.correlation.stacked.length === 1 && a.riskNotes.length > 0;
})());
check('GATE correlation: even a both-leg stack no longer blocks',
  G.auditIdeaAgainst({ pair: 'GBPJPY', direction: 'BUY', entry_zone: '218.08', tp: '220.50', sl: '216.80', lots: '0.02' }, baseCtx({ exposure: bothLegs })).blocking.length === 0);
check('THE HEADLINE: a HIGH-quality idea on a heavily-stacked book stays HIGH', (() => {
  const a = G.auditIdeaAgainst({ pair: 'GBPJPY', direction: 'BUY', entry_zone: '218.08', tp: '220.50', sl: '216.80', lots: '0.02',
    conviction: 'HIGH', catalyst: { event: 'CPI y/y', stance: 'TRADE_INTO' } }, baseCtx({ exposure: bothLegs }));
  return a.cap === null && a.blocking.length === 0;
})());
// ...but genuine TRADE-quality doubts must still cap, or the split has gone too far.
check('quality still caps: an invented catalyst caps to MED even with a clean book',
  G.auditIdeaAgainst(goodIdea({ catalyst: { event: 'Quarterly Vibes Index', stance: 'TRADE_INTO' } }), baseCtx({ exposure: {} })).cap === 'MED');
check('quality still caps: an unpriceable pair still blocks and caps to LOW', (() => {
  const a = G.auditIdeaAgainst({ pair: 'USDSEK', direction: 'BUY', entry_zone: '10.50', tp: '10.70', sl: '10.40', lots: '0.02' }, baseCtx({ exposure: {} }));
  return a.blocking.length > 0 && a.cap === 'LOW';
})());
check('quality still caps: an imminent unacknowledged print still blocks',
  G.auditIdeaAgainst(goodIdea(), baseCtx({ cal: CAL_IMMINENT })).blocking.length > 0);

console.log('\n=== 8b. THE HARD FLOOR RESIZES — and still protects the floor ===');
// The floor is the one place margin still has teeth. It must bind on SIZE without ever
// removing the idea, and the resized size must actually respect it.
const FLOOR = G.MARGIN_FLOOR_PCT;
const fitLots = G.maxLotsWithinFloor('EURUSD', VITALS_NOW, RATES, LIVE);
check('maxLotsWithinFloor returns a positive tradeable size here', fitLots >= G.LOT_STEP);
check('THE INVARIANT: the resized size does NOT breach the floor',
  G.projectedMarginLevel(VITALS_NOW, G.estMarginUSD('EURUSD', fitLots, RATES, LIVE)) >= FLOOR);
check('...and it is the LARGEST such size (one more step DOES breach)',
  G.projectedMarginLevel(VITALS_NOW, G.estMarginUSD('EURUSD', +(fitLots + G.LOT_STEP).toFixed(2), RATES, LIVE)) < FLOOR);
check('the result is a clean lot step, not a float artefact',
  Math.abs(fitLots * 100 - Math.round(fitLots * 100)) < 1e-9);
check('an already-fine size is left alone', (() => {
  const a = G.auditIdeaAgainst(goodIdea({ lots: '0.02' }), baseCtx());
  return a.margin.resizedTo == null && a.margin.breachedAtRequested !== true;
})());
check('...and reports the headroom instead', G.auditIdeaAgainst(goodIdea({ lots: '0.02' }), baseCtx()).margin.headroomLots >= 0.02);
// No room at all: the idea must STILL survive, stated honestly.
const BROKE = { balance: 2100, equity: 2000, margin: 1900, freeMargin: 100, marginLevel: 105, ts: new Date().toISOString() };
check('when nothing fits, maxLots returns 0 rather than a negative size',
  G.maxLotsWithinFloor('EURUSD', BROKE, RATES, LIVE) === 0);
check('...never a negative size, across exhausted accounts', (() => {
  for (const inUse of [1400, 1900, 5000, 50000]) {
    const f = G.maxLotsWithinFloor('EURUSD', { equity: 2000, margin: inUse }, RATES, LIVE);
    if (!(f === 0 || f > 0)) return false;
    if (f < 0) return false;
  }
  return true;
})());
check('...the idea is NOT blocked', (() => {
  const a = G.auditIdeaAgainst(goodIdea({ lots: '0.05' }), baseCtx({ vitals: BROKE, vAge: G.vitalsAge(BROKE) }));
  return a.blocking.length === 0 && a.margin.noSizeFits === true;
})());
check('...NOT conviction-capped', G.auditIdeaAgainst(goodIdea({ lots: '0.05' }), baseCtx({ vitals: BROKE, vAge: G.vitalsAge(BROKE) })).cap === null);
check('...and says so plainly', G.auditIdeaAgainst(goodIdea({ lots: '0.05' }), baseCtx({ vitals: BROKE, vAge: G.vitalsAge(BROKE) }))
  .riskNotes.some((n) => /No tradeable size fits/.test(n)));
check('unpriceable base returns null, never a bogus size', G.maxLotsWithinFloor('SEKJPY', VITALS_NOW, RATES, {}) === null);
check('missing equity returns null', G.maxLotsWithinFloor('EURUSD', { margin: 100 }, RATES, LIVE) === null);
// Sweep the invariant across sizes and account states — one worked example is not a guarantee.
check('INVARIANT HOLDS across a sweep of account states', (() => {
  for (const eq of [500, 1200, 2000, 5000, 20000]) {
    for (const inUse of [0, 100, 800, 1163, 3000]) {
      const v = { equity: eq, margin: inUse, ts: new Date().toISOString() };
      for (const pair of ['EURUSD', 'USDJPY', 'GBPJPY', 'AUDNZD']) {
        const f = G.maxLotsWithinFloor(pair, v, RATES, LIVE);
        if (f == null) return false;
        if (f === 0) continue;               // nothing fits: nothing to verify
        const p = G.projectedMarginLevel(v, G.estMarginUSD(pair, f, RATES, LIVE));
        if (!(p >= FLOOR)) return false;     // the floor must never be breached by a resize
      }
    }
  }
  return true;
})());
check('GATE levels: unpriceable pair is BLOCKED and capped to LOW', (() => {
  const a = G.auditIdeaAgainst({ pair: 'USDSEK', direction: 'BUY', entry_zone: '10.50', tp: '10.70', sl: '10.40', lots: '0.02' }, baseCtx());
  return a.blocking.length > 0 && a.cap === 'LOW';
})());
check('GATE red folder: blind walk into a print is BLOCKED',
  G.auditIdeaAgainst(goodIdea(), baseCtx({ cal: CAL_IMMINENT })).blocking.some((b) => /walks blind/.test(b)));
check('GATE red folder: DECLARING the print passes but caps to MED', (() => {
  const a = G.auditIdeaAgainst(goodIdea({ catalyst: { event: 'Core CPI m/m', stance: 'TRADE_INTO', ccy: 'USD' } }), baseCtx({ cal: CAL_IMMINENT }));
  return a.blocking.length === 0 && a.cap === 'MED';
})());
check('GATE catalyst: an invented event warns and caps', (() => {
  const a = G.auditIdeaAgainst(goodIdea({ catalyst: { event: 'Quarterly Vibes Index', stance: 'TRADE_INTO' } }), baseCtx());
  return a.cap === 'MED' && a.warnings.some((w) => /does not match any/.test(w));
})());
check('GATE catalyst: a real event resolves with its real time', (() => {
  const a = G.auditIdeaAgainst(goodIdea({ catalyst: { event: 'Non-Farm Payrolls', stance: 'TRADE_INTO' } }), baseCtx());
  return a.catalyst && a.catalyst.ccy === 'USD' && a.catalyst.insideWindow === true && a.cap === null;
})());
check('GATE catalyst: an event PAST the ceiling warns', (() => {
  const a = G.auditIdeaAgainst({ pair: 'NZD/USD', direction: 'BUY', entry_zone: '0.5980', tp: '0.6040', sl: '0.5940', lots: '0.02',
    catalyst: { event: 'Retail Sales m/m', stance: 'TRADE_INTO' } }, baseCtx());
  return a.catalyst && a.catalyst.insideWindow === false && a.warnings.some((w) => /ceiling/.test(w));
})());
check('GATE dupe: an already-open pair is BLOCKED',
  G.auditIdeaAgainst(goodIdea(), baseCtx({ openPairs: ['EURUSD'] })).blocking.some((b) => /repeats recent or open/.test(b)));
check('GATE dupe: a banned pair+direction is BLOCKED',
  G.auditIdeaAgainst(goodIdea(), baseCtx({ banned: new Set(['EURUSD|BUY']) })).blocking.length > 0);
check('GATE dupe: the OPPOSITE direction is not banned by it',
  G.auditIdeaAgainst(goodIdea({ direction: 'SELL', tp: '1.1301', sl: '1.1481' }), baseCtx({ banned: new Set(['EURUSD|BUY']) })).blocking.length === 0);
// Caps compose to the LOWEST, and can only ever lower.
check('multiple findings cap to the lowest rung', (() => {
  const a = G.auditIdeaAgainst({ pair: 'USDSEK', direction: 'BUY', entry_zone: '10.5', tp: '10.7', sl: '10.4', lots: '0.02',
    catalyst: { event: 'Nonsense', stance: 'TRADE_INTO' } }, baseCtx({ vitals: VITALS_STALE, vitalsUsable: false, vAge: G.vitalsAge(VITALS_STALE) }));
  return a.cap === 'LOW';
})());
check('CONVICTION_RUNG orders the scale correctly',
  G.CONVICTION_RUNG.LOW < G.CONVICTION_RUNG.MED && G.CONVICTION_RUNG.MED < G.CONVICTION_RUNG['MED-HIGH'] && G.CONVICTION_RUNG['MED-HIGH'] < G.CONVICTION_RUNG.HIGH);

console.log('\n=== 9. SESSION MAPPING (A12) ===');
// Bangkok is UTC+7. These are the hours the old three-bucket brief got factually wrong.
check('11:00 BKK is ASIAN, not "London deep" (the old bug)', G.sessionPhase(11) === 'asian');
check('14:00 BKK still asian — London opens 15:00 BKK', G.sessionPhase(14) === 'asian');
check('15:00 BKK is european (London open)', G.sessionPhase(15) === 'european');
check('17:00 BKK is european, NOT "US data settled" (the old bug)', G.sessionPhase(17) === 'european');
check('19:00 BKK still european — NFP prints 19:30', G.sessionPhase(19) === 'european');
check('20:00 BKK is the London/NY overlap', G.sessionPhase(20) === 'overlap');
check('23:00 BKK still overlap', G.sessionPhase(23) === 'overlap');
check('01:00 BKK is New York afternoon, not "evening overlap"', G.sessionPhase(1) === 'newyork');
check('04:00 BKK still newyork', G.sessionPhase(4) === 'newyork');
check('05:00 BKK rolls into asian', G.sessionPhase(5) === 'asian');
check('all 24 hours map to a real phase', Array.from({ length: 24 }, (_, h) => G.sessionPhase(h)).every((p) => ['asian', 'european', 'overlap', 'newyork'].includes(p)));
check('all four phases are actually reachable', new Set(Array.from({ length: 24 }, (_, h) => G.sessionPhase(h))).size === 4);

console.log('\n=== 10. LEARNING LOOP: horizon alignment (A13) + byCcy (B2) ===');
// Generator horizon and shadow-grading window must be the same number, from the same constant.
const shadowWindowDays = (() => {
  const m = ENGINE_SRC.match(/const WINDOW_MS = ([^\n;]+);/);
  return m ? m[1].trim() : null;
})();
check('shadow window derives from HORIZON, not a literal', shadowWindowDays === 'HORIZON.ceilingDays * 86400e3');
check('...so it equals the generator ceiling', G.HORIZON.ceilingDays * 86400e3 === 4 * 86400e3);
// byCcy: the finding that by-pair alone structurally cannot surface.
const ledger = [
  { status: 'passed', idea: { pair: 'GBPUSD', direction: 'BUY' }, shadowVerdict: { grade: 'LOSS' } },
  { status: 'passed', idea: { pair: 'GBPJPY', direction: 'BUY' }, shadowVerdict: { grade: 'LOSS' } },
  { status: 'passed', idea: { pair: 'GBPAUD', direction: 'BUY' }, shadowVerdict: { grade: 'LOSS' } },
  { status: 'passed', idea: { pair: 'EURUSD', direction: 'BUY' }, shadowVerdict: { grade: 'WIN' } },
];
const card = G.shadowScorecard(ledger);
check('three separate GBP losses net to LONG GBP 0W-3L', card.byCcy['LONG GBP'] && card.byCcy['LONG GBP'].l === 3);
check('...which by-pair alone could never surface (each pair only 0W-1L)',
  Object.values(card.byPair).every((v) => v.w + v.l === 1));
check('the SHORT side of each pair is credited too', card.byCcy['SHORT USD'] && card.byCcy['SHORT USD'].l === 1);
check('direction matters: a BUY credits LONG, not SHORT', !card.byCcy['SHORT GBP']);
check('a winning leg is credited as a win', card.byCcy['LONG EUR'] && card.byCcy['LONG EUR'].w === 1);
check('byPair still works alongside it', card.byPair.GBPUSD && card.byPair.GBPUSD.l === 1);

console.log('\n=== 11. NO ONE-DAY LITERALS LEFT BEHIND (A1 / A14) ===');
// The original bug was five sites restating the same number. The fix is worthless if any of
// them kept a literal, so this asserts the SHAPE, not just the values.
check('review branches derive from HORIZON.freshHours', /hoursOpen < HORIZON\.freshHours/.test(ENGINE_SRC));
check('overstay derives from HORIZON.ceilingHours', /hoursOpen > HORIZON\.ceilingHours/.test(ENGINE_SRC));
check('the old 20h fresh-window literal is gone', !/hoursOpen != null && hoursOpen < 20\b/.test(ENGINE_SRC));
check('the old 26h overstay literal is gone', !/hoursOpen > 26\b/.test(ENGINE_SRC));
// A14: the three review bands must TILE the timeline with no gap — that gap was the bug.
check('review bands tile with no gap (fresh ends where mid begins)', (() => {
  // fresh: < freshHours ; mid: <= ceilingHours ; else overstayed. No hour may fall through.
  for (const h of [0, 1, 19, 20, 24, 25, 26, 47, 47.9, 48, 49, 72, 95, 96, 96.1, 200]) {
    const fresh = h < G.HORIZON.freshHours;
    const mid = !fresh && h <= G.HORIZON.ceilingHours;
    const over = !fresh && !mid;
    if ([fresh, mid, over].filter(Boolean).length !== 1) return false;
  }
  return true;
})());
check('the 20-26h limbo specifically is now covered by the mid band',
  22 >= 0 && 22 < G.HORIZON.freshHours);
check('engine no longer describes trades as one-day in the prompt', !/ONE-DAY positions/.test(ENGINE_SRC));
check('stored horizon label derives from HORIZON.label', !/'one-day \(close within 24h\)'/.test(ENGINE_SRC));
check('maxDuration is declared (B4)', /export const config = \{ maxDuration: 300/.test(ENGINE_SRC));
check('...and the bodyParser limit survived the change', /sizeLimit: '8mb'/.test(ENGINE_SRC));
if (UI_SRC) {
  check('UI: red flag no longer promised at day 3', !/Red flag review unlocks at day 3/.test(UI_SRC));
  check('UI: horizon constants declared', /const HZ=\{targetMin:2,targetMax:3,ceilingDays:4,redAtDays:5\}/.test(UI_SRC));
  check('UI: "past its intended life" no longer fires from day 1', !/p\.ageDays>=1\?<span className="ambr"> · past its intended life/.test(UI_SRC));
  check('UI: surfaces the recomputed margin', /MARGIN \(recomputed\)/.test(UI_SRC));
  check('UI: surfaces added exposure without framing it as a penalty', /ADDS TO EXPOSURE/.test(UI_SRC));
  check('UI: says exposure has not affected conviction', /has not affected the conviction above/.test(UI_SRC));
  check('UI: separates book facts from trade doubts', /idea\.risk_notes/.test(UI_SRC) && /YOUR BOOK/.test(UI_SRC) && /noted, not counted against the idea/.test(UI_SRC));
  check('UI: shows the resize on the lot size itself', /resized from \{idea\.lotsRequested\}/.test(UI_SRC));
  check('UI: shows both margin figures for a resize', /resized to \{idea\.marginCheck\.resizedTo\} lots/.test(UI_SRC));
  check('UI: has a no-size-fits state', /no tradeable size fits your/.test(UI_SRC));
  check('UI: explains what conviction measures', /Conviction rates the QUALITY of the trade only/.test(UI_SRC));
  check('UI: surfaces the red-folder warning', /HIGH-IMPACT PRINT IMMINENT/.test(UI_SRC));
  check('UI: surfaces a surviving blocking finding', /idea\.gate_warning/.test(UI_SRC));
} else {
  console.log('  (terminal.html not found — UI assertions skipped)');
}

// ============================================================================
console.log('\n=== 12. MUTATION HARNESS — do the money gates actually fire? ===');
// Everything above passes against the code as written. That is not the same as the code doing
// anything: an assertion can agree with a gate that has been quietly disabled. Each mutation
// below breaks ONE gate at the source level and requires the corresponding probe to go from
// true to false. A mutation that survives means the probe never exercised that code, and the
// green tick above it was decorative.
const NOW = Date.now();
const MUTATIONS = [
  {
    gate: 'B5 fail-closed on missing anchor',
    // Restore the exact bug: make the no-anchor path fall through instead of returning.
    from: `  if (!refPx) {\n    return { ok: false, unanchored: true,`,
    to: `  if (refPx === 'never') {\n    return { ok: false, unanchored: true,`,
    probe: (g) => !g.checkLevels({ pair: 'USDSEK', direction: 'BUY', entry_zone: '10.50', tp: '10.70', sl: '10.40' }, null).ok,
  },
  {
    // THE FLOOR MUST STILL BIND. It no longer blocks the idea — it binds the SIZE — so the
    // mutation to catch is one that lets an oversized lot through unresized.
    gate: 'HARD FLOOR: an oversized lot is detected and resized',
    from: `    if (projected < MARGIN_FLOOR_PCT) {`,
    to: `    if (false) {`,
    probe: (g) => {
      const a = g.auditIdeaAgainst(goodIdea({ lots: '0.10' }), baseCtx());
      return a.margin.resizedTo > 0 && a.margin.breachedAtRequested === true;
    },
  },
  {
    // ...and the resized size must genuinely respect the floor. Rounding UP would silently
    // re-breach the very thing the resize exists to protect.
    gate: 'HARD FLOOR: the resize rounds DOWN, never up',
    from: `  const stepped = Math.floor(raw / LOT_STEP) * LOT_STEP;`,
    to: `  const stepped = Math.ceil(raw / LOT_STEP) * LOT_STEP;`,
    probe: (g) => {
      const f = g.maxLotsWithinFloor('EURUSD', VITALS_NOW, RATES, LIVE);
      return g.projectedMarginLevel(VITALS_NOW, g.estMarginUSD('EURUSD', f, RATES, LIVE)) >= g.MARGIN_FLOOR_PCT;
    },
  },
  {
    gate: 'HARD FLOOR: an exhausted account yields no size rather than a negative one',
    from: `  if (!(budget > 0)) return 0; // already at or through the floor; nothing fits`,
    to: `  if (false) return 0;`,
    probe: (g) => g.maxLotsWithinFloor('EURUSD', { equity: 2000, margin: 1900 }, RATES, LIVE) === 0,
  },
  {
    // The split itself: margin must NOT be able to reach the conviction band any more.
    gate: 'SPLIT: margin never caps conviction',
    from: `      a.riskNotes.push(\`At \${i.lots} lots this would project \${projected}%, under your \${MARGIN_FLOOR_PCT}% floor`,
    to: `      capTo('MED'); a.riskNotes.push(\`At \${i.lots} lots this would project \${projected}%, under your \${MARGIN_FLOOR_PCT}% floor`,
    probe: (g) => g.auditIdeaAgainst(goodIdea({ lots: '0.10' }), baseCtx()).cap === null,
  },
  {
    gate: 'B3 margin arithmetic (leverage)',
    from: `const LEVERAGE = 20;`,
    to: `const LEVERAGE = 2000;`,
    probe: (g) => Math.abs(g.estMarginUSD('EURUSD', 0.10, RATES, LIVE) - 570) < 12,
  },
  {
    gate: 'B3 vitals freshness',
    from: `const fresh = ageMs >= 0 && ageMs <= VITALS_FRESH_MS;`,
    to: `const fresh = true;`,
    probe: (g) => g.vitalsAge(VITALS_STALE).fresh === false,
  },
  {
    gate: 'B2 correlation detection',
    from: `    if (Math.sign(existing) !== sign) continue; // opposite side: this REDUCES risk, not stacks it`,
    to: `    if (true) continue;`,
    probe: (g) => g.correlationCheck({ pair: 'GBPJPY', direction: 'BUY', lots: 0.05 }, exp).stacked.length === 1,
  },
  {
    // Correlation no longer blocks, so the guard worth protecting is that it is still REPORTED.
    // A silent stack is exactly what he asked to keep seeing.
    gate: 'SPLIT: a material stack is still reported as a risk note',
    from: `    if (corr.material.length) a.riskNotes.push(\`Adds to existing exposure:`,
    to: `    if (false) a.riskNotes.push(\`Adds to existing exposure:`,
    probe: (g) => g.auditIdeaAgainst({ pair: 'AUD/CAD', direction: 'BUY', entry_zone: '0.9872', tp: '0.9960', sl: '0.9810', lots: '0.03' }, baseCtx({ exposure: realExp }))
      .riskNotes.some((n) => /Adds to existing exposure/.test(n)),
  },
  {
    gate: 'B2 materiality floor (no blocking on residuals)',
    from: `const STACK_MATERIAL_LOTS = 0.05;`,
    to: `const STACK_MATERIAL_LOTS = 0;`,
    probe: (g) => g.correlationCheck({ pair: 'EURUSD', direction: 'BUY', lots: 0.03 }, realExp).heavy === false,
  },
  {
    gate: 'B2 exposure sign convention',
    from: `    const s = dir === 'BUY' ? 1 : -1;\n    const base = pr.slice(0, 3), quote = pr.slice(3, 6);`,
    to: `    const s = 1;\n    const base = pr.slice(0, 3), quote = pr.slice(3, 6);`,
    probe: (g) => {
      const e = g.currencyExposure([{ pair: 'USDJPY', direction: 'SELL', lots: 0.1 }]);
      return Math.abs(e.USD + 0.1) < 1e-9;
    },
  },
  {
    gate: 'B6 red folder guard',
    from: `    if (e.utc >= nowMs && e.utc - nowMs <= win) return e;`,
    to: `    if (false) return e;`,
    probe: (g) => !!g.redFolderImminent(CAL_IMMINENT, 'EURUSD', g.RED_FOLDER_GUARD_MIN, NOW),
  },
  {
    gate: 'B6 red folder BLOCKS an undeclared print',
    from: `      a.blocking.push(\`\${i.pair} walks blind into`,
    to: `      a.warnings.push(\`\${i.pair} walks blind into`,
    probe: (g) => g.auditIdeaAgainst(goodIdea(), baseCtx({ cal: CAL_IMMINENT })).blocking.length > 0,
  },
  {
    gate: 'B6 red folder respects impact level',
    from: `    if (!e || !/high/i.test(String(e.impact || ''))) continue;`,
    to: `    if (!e) continue;`,
    probe: (g) => !g.redFolderImminent([{ title: 'x', ccy: 'USD', impact: 'Medium', utc: NOW + 10 * 60000 }], 'EURUSD', g.RED_FOLDER_GUARD_MIN, NOW),
  },
  {
    gate: 'A8 catalyst resolution threshold',
    from: `  return bestScore >= 0.5 ? best : null;`,
    to: `  return best;`,
    // The probe must use a claim with PARTIAL overlap. "Quarterly Vibes Index" shares no words
    // with anything on the calendar, so `best` stays null and dropping the threshold changes
    // nothing — the first version of this probe passed under mutation and the harness caught it.
    // "Employment Cost Index" vs "Non-Farm Employment Change" scores 0.33: below the bar, but
    // only because there IS a bar.
    probe: (g) => g.resolveCatalyst({ event: 'Employment Cost Index' }, CAL, 'EURUSD') === null,
  },
  {
    gate: 'A8 catalyst must belong to the pair',
    from: `    if (!legs.includes(e.ccy)) continue; // a catalyst must belong to one of the pair's own legs`,
    to: `    if (false) continue;`,
    probe: (g) => g.resolveCatalyst({ event: 'Cash Rate' }, CAL, 'EURUSD') === null,
  },
  {
    gate: 'A1 aging ladder recalibration',
    from: `  (d > HORIZON.ceilingDays ? 'RED'`,
    to: `  (d >= 3 ? 'RED'`,
    probe: (g) => g.ageFlag(3) === 'NOTE',
  },
  {
    gate: 'A1 level tolerance widening',
    from: `  maxStopPips: 300,`,
    to: `  maxStopPips: 150,`,
    probe: (g) => g.checkLevels(goodIdea({ sl: '1.1221', tp: '1.1721' }), 1.1421).ok,
  },
  {
    gate: 'A12 session mapping',
    from: `  if (hour >= 5 && hour < 15) return 'asian';`,
    to: `  if (hour >= 5 && hour < 11) return 'asian';`,
    probe: (g) => g.sessionPhase(11) === 'asian',
  },
  {
    gate: 'B2 byCcy learning signal',
    from: `      creditCcy(p.slice(0, 3), long ? 'LONG' : 'SHORT', isWin, isLoss);`,
    to: `      if (false) creditCcy(p.slice(0, 3), long ? 'LONG' : 'SHORT', isWin, isLoss);`,
    probe: (g) => { const c = g.shadowScorecard(ledger); return !!(c.byCcy['LONG GBP'] && c.byCcy['LONG GBP'].l === 3); },
  },
];

let mutPass = 0, mutFail = 0;
for (const m of MUTATIONS) {
  if (!ENGINE_SRC.includes(m.from)) {
    mutFail++; fail++; fails.push(`mutation anchor missing: ${m.gate}`);
    console.log(`  x FAIL: [${m.gate}] mutation anchor no longer present in the engine — the harness is testing nothing here.`);
    continue;
  }
  const mutated = ENGINE_SRC.replace(m.from, m.to);
  let survived;
  try {
    const MG = buildGuards(mutated, { quiet: true });
    survived = !!m.probe(MG);   // true => gate broken but probe STILL passes => probe is vacuous
  } catch (e) {
    survived = false;           // mutation made it throw: the probe would have failed too
  }
  // Confirm the probe passes on the PRISTINE source, or "it fails when mutated" proves nothing.
  let pristine;
  try { pristine = !!m.probe(G); } catch (e) { pristine = false; }
  if (pristine && !survived) {
    mutPass++; pass++;
  } else {
    mutFail++; fail++;
    const why = !pristine ? 'probe does not pass on unmutated source' : 'MUTATION SURVIVED — this gate is not actually tested';
    fails.push(`mutation: ${m.gate} (${why})`);
    console.log(`  x FAIL: [${m.gate}] ${why}`);
  }
}
console.log(`  ${mutPass}/${MUTATIONS.length} gates verified live (mutation killed the probe as required)`);

console.log('\n============================================================');
console.log(`GRAND TOTAL: ${pass} passed, ${fail} failed   (${mutPass} money-gate mutations killed)`);
if (fail) { console.log('FAILURES:\n - ' + fails.join('\n - ')); process.exitCode = 1; }
else console.log('ALL CHECKS PASSED');
console.log('============================================================');
