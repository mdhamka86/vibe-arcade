// ============================================================================
// PROPOSE MEET-RESOLUTION SUITE — guards the join between what the MODEL writes
// and what the PACK is keyed by. Re-run any time with:
//   node tests/test_propose_meet_resolution.js
//
// THE BUG THIS EXISTS FOR (22/07/2026). propose.js builds every meet-keyed index
// from the pack's venue ("South Africa", the SGPools coupon container) but used to
// look them up with leg.meet — free text the model writes, and the model writes the
// COURSE it read about ("Scottsville"). Five lookups missed silently into zeros:
// false UNCONFIRMED on runners sitting on the card, a false no-external-source veto
// on the one region with live sources, a PLA small-field floor that wasn't enforcing,
// miscounted per-meet caps, and permanently "nodata" shadow prices. The book came out
// empty and nothing in the output said "label mismatch".
//
// These checks drive the REAL exported resolver and the REAL index builders — not a
// reimplementation. If propose.js stops exporting them this suite fails loudly rather
// than quietly testing a copy.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}

(async () => {
  let P;
  try {
    P = await import('../api/propose.js');
  } catch (e) {
    console.error('Could not import api/propose.js:', e.message);
    process.exit(2);
  }
  const { resolveMeet, meetIndexes, priceIndexOf } = P;
  if (typeof resolveMeet !== 'function' || typeof meetIndexes !== 'function' || typeof priceIndexOf !== 'function') {
    console.error('propose.js no longer exports resolveMeet / meetIndexes / priceIndexOf.');
    console.error('These checks would be testing nothing, so this is a hard stop.');
    process.exit(3);
  }

  // A pack shaped exactly like the real 22/07/2026 one that exposed the bug: the SGPools
  // coupon is "South Africa", the racing is at Scottsville, and R7 holds EXOCET at #4.
  const packSA = {
    date: '22/07/2026',
    meets: [{
      venue: 'South Africa', region: 'SA',
      sources: [
        { id: 'racecoast-api', ok: true },
        { id: 'gold-circle', ok: true },
        { id: 'race-coast-html', ok: true, ssotFail: 'names 0 of the card runners' },
        { id: 'raceform', ok: false },
      ],
      raceMap: [
        { raceNo: 7, dist: '1200m', fieldSize: 8, runners: [
          { no: 1, name: 'ESTEEMED' }, { no: 2, name: 'INFINITY EDGE' }, { no: 3, name: 'A GOOD HEART' },
          { no: 4, name: 'EXOCET' }, { no: 5, name: 'ICY BLAST' }, { no: 6, name: 'THE LAST DUKE' },
          { no: 7, name: "AMELIA'S LEGACY" }, { no: 8, name: 'GOOD FOR YOU' },
        ]},
        { raceNo: 8, dist: '1200m', fieldSize: 9, runners: [
          { no: 8, name: 'HAH LAH LAH' }, { no: 9, name: 'MILITARY COMMAND' },
        ]},
      ],
    }],
  };
  // Three AU coupons in one pack — the real 22/07 shape, and the reason a bare course
  // name in that region is genuinely ambiguous rather than resolvable.
  const packAU = {
    meets: [
      { venue: 'Australia (Melbourne)', region: 'AU', sources: [], raceMap: [] },
      { venue: 'Australia', region: 'AU', sources: [], raceMap: [] },
      { venue: 'Australia (Perth)', region: 'AU', sources: [], raceMap: [] },
    ],
  };

  console.log('\n=== 1. RESOLUTION: course label -> coupon venue ===');
  {
    const r = resolveMeet('Scottsville', packSA.meets);
    check('THE BUG: "Scottsville" resolves to "South Africa"', r.venue === 'South Africa');
    check('and reports how it got there', /^region:SA$/.test(r.how || ''));
    check('and carries no error', !r.why);
  }
  check('other SA courses resolve too (Greyville)', resolveMeet('Greyville', packSA.meets).venue === 'South Africa');
  check('and Turffontein', resolveMeet('Turffontein', packSA.meets).venue === 'South Africa');
  {
    const r = resolveMeet('South Africa', packSA.meets);
    check('the venue itself still resolves', r.venue === 'South Africa' && r.how === 'exact');
  }
  check('case and punctuation are ignored', resolveMeet('  scottsville ', packSA.meets).venue === 'South Africa');
  {
    const r = resolveMeet('Perth', packAU.meets);
    check('a bracketed coupon resolves from its bare course ("Perth")', r.venue === 'Australia (Perth)');
    check('by label containment, not region', r.how === 'label');
  }
  check('an exact bracketed label wins outright',
    resolveMeet('Australia (Melbourne)', packAU.meets).venue === 'Australia (Melbourne)');

  console.log('\n=== 2. LOUD FAILURE: never guess, never zero ===');
  {
    // A VIC course with three AU coupons in the pack: genuinely undecidable. Guessing here
    // would put money on the wrong coupon, which is the error the card-match law exists for.
    const r = resolveMeet('Flemington', packAU.meets);
    check('ambiguous course does NOT resolve', r.venue === null);
    check('ambiguous failure explains itself', /ambiguous/i.test(r.why || ''));
    check('ambiguous failure names the candidates', /Australia \(Perth\)/.test(r.why || ''));
  }
  {
    const r = resolveMeet('Narnia Downs', packSA.meets);
    check('unknown course does NOT resolve', r.venue === null);
    check('unknown failure quotes the label back', /Narnia Downs/.test(r.why || ''));
    check('unknown failure lists what the pack does hold', /South Africa/.test(r.why || ''));
  }
  {
    const r = resolveMeet('', packSA.meets);
    check('empty label does NOT resolve', r.venue === null);
    check('empty label still explains itself', !!(r.why && r.why.length > 10));
  }
  check('null label is safe', resolveMeet(null, packSA.meets).venue === null);
  check('empty pack is safe', resolveMeet('Scottsville', []).venue === null);
  // The contract the gates depend on: a failure is ALWAYS {venue:null, why:<non-empty>}.
  for (const bad of ['Flemington', 'Narnia Downs', '', null, undefined]) {
    const r = resolveMeet(bad, packAU.meets);
    if (r.venue === null) check(`failure for ${JSON.stringify(bad)} carries a why`, typeof r.why === 'string' && r.why.length > 0);
  }

  console.log('\n=== 3. ALL FIVE LOOKUPS HIT ON THE RESOLVED VENUE ===');
  {
    const { cardIndex, extCount, fieldSizeOf } = meetIndexes(packSA);
    const venue = resolveMeet('Scottsville', packSA.meets).venue;

    // (1) cardIndex — the false UNCONFIRMED
    check('1/5 cardIndex hits: R7 #4 is EXOCET', cardIndex[venue + '|7|4'] === 'EXOCET');
    check('     R8 #8 is HAH LAH LAH', cardIndex[venue + '|8|8'] === 'HAH LAH LAH');
    check('     the RAW label would have missed (the old bug)', cardIndex['Scottsville|7|4'] === undefined);

    // (2) extCount — the false no-external-source veto. 2 ok+verified of 4 (one ssotFail, one !ok)
    check('2/5 extCount hits: 2 verified sources', extCount[venue] === 2);
    check('     so the no-external-source gate does NOT fire', !((extCount[venue] || 0) === 0));
    check('     the RAW label would have read 0 and vetoed', (extCount['Scottsville'] || 0) === 0);

    // (3) fieldSizeOf — the silently disabled PLA floor. R7 has 8 runners, so the floor MUST fire.
    const fs = fieldSizeOf[venue + '|7'] || 0;
    check('3/5 fieldSizeOf hits: R7 field is 8', fs === 8);
    check('     so the PLA small-field floor DOES fire', fs > 0 && fs <= 8);
    const fsRaw = fieldSizeOf['Scottsville|7'] || 0;
    check('     the RAW label read 0 and silently disabled the floor', !(fsRaw > 0 && fsRaw <= 8));
    check('     a 9-runner race still passes the floor', !((fieldSizeOf[venue + '|8'] || 0) <= 8));

    // (4) perMeetKept — legs labelled differently must share ONE bucket
    const perMeetKept = {};
    const legs = [{ meet: 'Scottsville' }, { meet: 'South Africa' }, { meet: 'Greyville' }];
    for (const l of legs) {
      const v = resolveMeet(l.meet, packSA.meets).venue;
      perMeetKept[v] = (perMeetKept[v] || 0) + 1;
    }
    check('4/5 perMeetKept: 3 differently-labelled legs share one bucket', perMeetKept[venue] === 3);
    check('     and that bucket is the only one', Object.keys(perMeetKept).length === 1);

    // (5) priceIndex — the permanent "nodata"
    const pricedPack = { meets: [{ venue: 'South Africa', raceMap: [
      { raceNo: 7, runners: [{ no: 4, name: 'EXOCET', price: { win: 3.4, pla: 1.7 } }] },
    ]}]};
    const priceIndex = priceIndexOf(pricedPack);
    check('5/5 priceIndex hits: R7 #4 has a price', !!priceIndex[venue + '|7|4']);
    check('     and the shadow verdict is computable', priceIndex[venue + '|7|4'].pla === 1.7);
    check('     the RAW label would have been nodata forever', !priceIndex['Scottsville|7|4']);
  }

  console.log('\n=== 4. INDEX BUILDERS: shape and safety ===');
  {
    const { cardIndex, extCount, fieldSizeOf } = meetIndexes({ meets: [] });
    check('empty pack builds empty indexes',
      Object.keys(cardIndex).length === 0 && Object.keys(extCount).length === 0 && Object.keys(fieldSizeOf).length === 0);
  }
  {
    const ix = meetIndexes({ meets: [{ venue: 'X', sources: [{ ok: true }] }] });
    check('meetIndexes tolerates a meet with no raceMap',
      ix.extCount.X === 1 && Object.keys(ix.cardIndex).length === 0);
  }
  check('priceIndexOf(null) is safe', Object.keys(priceIndexOf(null)).length === 0);
  check('priceIndexOf skips runners with no price',
    Object.keys(priceIndexOf({ meets: [{ venue: 'X', raceMap: [{ raceNo: 1, runners: [{ no: 1, name: 'A' }] }] }] })).length === 0);

  console.log('\n=== 5. THE HANDLER ACTUALLY USES THE RESOLVED VENUE ===');
  // Everything above proves the resolver and the indexes are right. It does NOT prove the
  // handler reads them with leg.venue — and a revert to leg.meet would restore the whole bug
  // while every check above stayed green. That is exactly the invisibility this suite exists
  // to end, so the wiring is asserted at source level too.
  {
    const fs = require('fs'), path = require('path');
    const SRC_PATH = path.join(__dirname, '..', 'api', 'propose.js');
    const src = fs.existsSync(SRC_PATH) ? fs.readFileSync(SRC_PATH, 'utf8') : null;
    check('propose.js readable', !!src);
    if (src) {
      // strip comments so the prose ABOUT the old bug cannot satisfy or trip these
      const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const has = (s) => code.includes(s);
      check('cardIndex keyed on leg.venue',   has('const key = leg.venue + "|"'));
      check('extCount keyed on leg.venue',    has('extCount[leg.venue]'));
      check('fieldSizeOf keyed on leg.venue', has('fieldSizeOf[leg.venue + "|"'));
      check('perMeetKept keyed on leg.venue', has('perMeetKept[leg.venue]'));
      check('priceIndex keyed on leg.venue',  has('priceIndex[leg.venue + "|"'));
      // and none of the five may read the raw label again
      check('NO lookup reads leg.meet',
        !has('cardIndex[leg.meet') && !has('extCount[leg.meet') && !has('fieldSizeOf[leg.meet') &&
        !has('perMeetKept[leg.meet') && !has('priceIndex[leg.meet') && !has('const key = leg.meet'));
      // the loud-failure path must exist and must come before the gates
      check('unresolved meets are vetoed, not zeroed', has('veto("unresolved-meet"'));
      check('unresolved veto precedes the source gate',
        code.indexOf('veto("unresolved-meet"') < code.indexOf('veto("no-external-source"'));
      check('meetErrors surfaced in the response', /meetErrors,/.test(code));
      check('resolveMeet is called on the model label', has('resolveMeet(leg.meet, pack.meets)'));
    }
  }

  console.log('\n============================================================');
  console.log(`GRAND TOTAL: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exitCode = 1; }
  else console.log('ALL MEET-RESOLUTION CHECKS PASSED ✓');
  console.log('============================================================');
})();
