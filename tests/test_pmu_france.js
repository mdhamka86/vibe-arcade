// ============================================================================
// PMU FRANCE ADAPTER SUITE — guards the race-to-course matcher that ends France's
// SSOT blindness. Re-run any time with:
//   node tests/test_pmu_france.js
//
// WHY THIS MATCHER IS SHAPED THE WAY IT IS. The first build matched each SGPools
// race to a PMU course on (distance, declared runners) plus start-time order. It
// scored 100% on the day it was designed against and was WRONG on two of sixteen:
// réunion R2 at La Teste on 11/07/2026 ran FOUR 1900m races (C3:7, C4:6, C5:6,
// C6:7 runners) and only C6 was the SGPools race. Distance+field size picked C3 —
// 0 of 7 runner names — and the bad pick then dragged the start-time floor forward
// and cost five more races on 08/07. A confident, silent, wrong answer is the
// worst outcome available here, because it puts money on a horse nobody analysed.
//
// So names decide, per the house law already written at trawl.js:292 and already
// followed by pmuPrices: a course matches only above a >=50% runner-name overlap.
//
// These checks drive the REAL exported matchCard with an injected name lookup, so
// no network is touched and no logic is reimplemented. Verified live before
// shipping: 16 days, 163 races, 1805/1805 runner names, zero false assignments.
// ============================================================================
let pass = 0, fail = 0; const fails = [];
function check(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ✗ FAIL:', name); }
}
const R = (raceNo, dist, names) => ({ raceNo, dist: dist + 'm', fieldSize: names.length, runners: names.map((n, i) => ({ no: i + 1, name: n })) });
const C = (Rn, Cn, dist, partants, startMs, extra) => Object.assign({ R: Rn, C: Cn, hippo: 'H' + Rn, dist, partants, startMs, discipline: 'PLAT', libelle: 'PRIX ' + Rn + '-' + Cn }, extra || {});

(async () => {
  let T;
  try { T = await import('../api/trawl.js'); }
  catch (e) { console.error('Could not import api/trawl.js:', e.message); process.exit(2); }
  const { matchCard, pmuCoursesFromProgramme, pmuSourceText } = T;
  if (typeof matchCard !== 'function' || typeof pmuCoursesFromProgramme !== 'function') {
    console.error('trawl.js no longer exports matchCard / pmuCoursesFromProgramme.');
    console.error('These checks would be testing nothing, so this is a hard stop.');
    process.exit(3);
  }
  // name lookup from a plain {"R|C": [names]} table
  const lookup = (table) => async (r, c) => (table[r + '|' + c] !== undefined ? table[r + '|' + c] : null);

  console.log('\n=== 1. NAMES DECIDE, NOT DISTANCE + FIELD SIZE (the 11/07 regression) ===');
  {
    // Four 1900m courses in ONE réunion; three are decoys with identical shape.
    const sg = [R(1, 1900, ['GENEVA', 'BIANCA DE GHAZAL', 'MELODIE DU CROATE', 'FAKHIRA', 'HNOF ATHBAH', 'TS WASEEMA', 'MARAKEZ AL SHAHANIA'])];
    const courses = [
      C(2, 3, 1900, 7, 1000), C(2, 4, 1900, 6, 2000), C(2, 5, 1900, 6, 3000), C(2, 6, 1900, 7, 4000),
    ];
    const names = lookup({
      '2|3': ['OTHER ONE', 'OTHER TWO', 'OTHER THREE', 'OTHER FOUR', 'OTHER FIVE', 'OTHER SIX', 'OTHER SEVEN'],
      '2|4': ['NOPE A', 'NOPE B', 'NOPE C', 'NOPE D', 'NOPE E', 'NOPE F'],
      '2|5': ['NIL A', 'NIL B', 'NIL C', 'NIL D', 'NIL E', 'NIL F'],
      '2|6': ['GENEVA', 'BIANCA DE GHAZAL', 'MELODIE DU CROATE', 'FAKHIRA', 'HNOF ATHBAH', 'TS WASEEMA', 'MARAKEZ AL SHAHANIA'],
    });
    const m = await matchCard(sg, courses, names);
    check('picks C6 on names, not C3 on shape+earliest', m.assigned.length === 1 && m.assigned[0].C === 6);
    check('and records a perfect overlap', m.assigned[0].overlap === 1);
    check('the shape-identical decoy is NOT chosen', !m.assigned.some((a) => a.C === 3));
  }

  console.log('\n=== 2. THE >=50% FLOOR ===');
  {
    const sg = [R(1, 1600, ['A ONE', 'A TWO', 'A THREE', 'A FOUR', 'A FIVE', 'A SIX', 'A SEVEN', 'A EIGHT'])];
    const courses = [C(1, 1, 1600, 8, 1000)];
    // 3/8 = 37.5% -> below floor
    const below = await matchCard(sg, courses, lookup({ '1|1': ['A ONE', 'A TWO', 'A THREE', 'X4', 'X5', 'X6', 'X7', 'X8'] }));
    check('37.5% overlap is REJECTED', below.assigned.length === 0 && below.unresolved.length === 1);
    check('rejection names the shortfall', /38% runner-name overlap, under the 50% floor/.test(below.unresolved[0].why));
    check('rejection names the candidate course', /PMU R1\/C1/.test(below.unresolved[0].why));
    // 4/8 = 50% -> exactly at floor, accepted
    const at = await matchCard(sg, courses, lookup({ '1|1': ['A ONE', 'A TWO', 'A THREE', 'A FOUR', 'X5', 'X6', 'X7', 'X8'] }));
    check('exactly 50% is ACCEPTED', at.assigned.length === 1 && at.assigned[0].overlap === 0.5);
    // custom floor is honoured
    const strict = await matchCard(sg, courses, lookup({ '1|1': ['A ONE', 'A TWO', 'A THREE', 'A FOUR', 'X5', 'X6', 'X7', 'X8'] }), { floor: 0.9 });
    check('a stricter floor rejects the same race', strict.assigned.length === 0);
  }

  console.log('\n=== 3. MULTI-RÉUNION MERGE (SGPools France is a coupon container) ===');
  {
    const sg = [R(1, 1800, ['M1', 'M2', 'M3']), R(2, 2000, ['N1', 'N2', 'N3']), R(3, 2400, ['P1', 'P2', 'P3'])];
    const courses = [C(4, 1, 1800, 3, 1000), C(5, 1, 2000, 3, 2000), C(4, 2, 2400, 3, 3000)];
    const m = await matchCard(sg, courses, lookup({ '4|1': ['M1', 'M2', 'M3'], '5|1': ['N1', 'N2', 'N3'], '4|2': ['P1', 'P2', 'P3'] }));
    check('all three races assigned', m.assigned.length === 3);
    check('across TWO réunions', m.reunions.length === 2 && m.reunions[0] === 4 && m.reunions[1] === 5);
    check('no single-réunion assumption leaked in', m.assigned.some((a) => a.R === 4) && m.assigned.some((a) => a.R === 5));
  }

  console.log('\n=== 4. LOUD PER-RACE ERROR ON UNMATCHED (the 15/07 case) ===');
  {
    // 15/07 SG R6 was a real SGPools race that PMU simply does not carry.
    const sg = [R(1, 1600, ['Q1', 'Q2', 'Q3']), R(6, 2400, ['FRANCE ANGLOJAC', 'LOUXOR PONTADOUR', 'VIF DOR'])];
    const courses = [C(4, 1, 1600, 3, 1000), C(4, 6, 2400, 3, 2000)];
    const m = await matchCard(sg, courses, lookup({ '4|1': ['Q1', 'Q2', 'Q3'], '4|6': ['UNRELATED A', 'UNRELATED B', 'UNRELATED C'] }));
    check('the matchable race still matches', m.assigned.length === 1 && m.assigned[0].raceNo === 1);
    check('the unmatchable race is UNRESOLVED, not assigned', m.unresolved.length === 1 && m.unresolved[0].raceNo === 6);
    check('the error is per-race and carries a reason', !!m.unresolved[0].why && m.unresolved[0].why.length > 20);
    check('0% overlap is never silently assigned', !m.assigned.some((a) => a.raceNo === 6));
    check('confidence reports the shortfall', m.confidence === 0.5);
    // no candidate at all
    const none = await matchCard([R(1, 3000, ['Z1', 'Z2'])], [C(1, 1, 1200, 9, 1000)], lookup({}));
    check('no candidate course -> unresolved with distance reason', none.unresolved.length === 1 && /no PMU course at 3000m/.test(none.unresolved[0].why));
  }

  console.log('\n=== 5. COUPON ORDER IS NOT AN INVARIANT (the 08/07 case) ===');
  {
    // SGPools R1 runs LATER than SGPools R2. 08/07 did exactly this and matched
    // 14/14 races at 100% names — gating on order would have thrown the day away.
    const sg = [R(1, 1800, ['L1', 'L2', 'L3']), R(2, 2000, ['E1', 'E2', 'E3'])];
    const courses = [C(3, 1, 2000, 3, 1000), C(4, 1, 1800, 3, 9000)];
    const m = await matchCard(sg, courses, lookup({ '4|1': ['L1', 'L2', 'L3'], '3|1': ['E1', 'E2', 'E3'] }));
    check('out-of-order coupon still fully matches', m.assigned.length === 2);
    check('and it is reported as non-monotonic', m.monotonic === false);
    check('but non-monotonic does NOT reduce confidence', m.confidence === 1);
  }

  console.log('\n=== 6. NO DOUBLE-BOOKING, AND FETCH ECONOMY ===');
  {
    const sg = [R(1, 1800, ['S1', 'S2', 'S3']), R(2, 1800, ['S1', 'S2', 'S3'])];
    const courses = [C(1, 1, 1800, 3, 1000), C(1, 2, 1800, 3, 2000)];
    const m = await matchCard(sg, courses, lookup({ '1|1': ['S1', 'S2', 'S3'], '1|2': ['S1', 'S2', 'S3'] }));
    check('one PMU course is never assigned to two SGPools races',
      m.assigned.length === 2 && m.assigned[0].C !== m.assigned[1].C);
  }
  {
    let calls = 0;
    const sg = [R(1, 1800, ['F1', 'F2', 'F3'])];
    const courses = [C(1, 1, 1800, 3, 1000), C(1, 2, 1800, 3, 2000), C(1, 3, 1800, 3, 3000)];
    const counting = async (r, c) => { calls++; return { '1|1': ['F1', 'F2', 'F3'], '1|2': ['X'], '1|3': ['Y'] }[r + '|' + c] || null; };
    const m = await matchCard(sg, courses, counting);
    check('a perfect match short-circuits further fetches', calls === 1 && m.assigned.length === 1);
    check('fetch count is reported', m.fetches === 1);
  }
  {
    let calls = 0;
    const counting = async () => { calls++; return ['NOPE']; };
    const sg = Array.from({ length: 6 }, (_, i) => R(i + 1, 1800, ['A' + i, 'B' + i, 'C' + i]));
    const courses = Array.from({ length: 20 }, (_, i) => C(1, i + 1, 1800, 3, i * 100));
    await matchCard(sg, courses, counting, { budget: 5 });
    check('the fetch budget is respected', calls <= 5);
  }

  console.log('\n=== 7. SAFETY / SHAPE ===');
  {
    const m = await matchCard([], [], lookup({}));
    check('empty card is safe', m.assigned.length === 0 && m.confidence === 0);
    const noRunners = await matchCard([{ raceNo: 1, dist: '1600m', fieldSize: 0, runners: [] }], [C(1, 1, 1600, 0, 1)], lookup({}));
    check('a race with no runners is unresolved, not matched', noRunners.unresolved.length === 1 && /no runners/.test(noRunners.unresolved[0].why));
    const nullNames = await matchCard([R(1, 1600, ['A', 'B'])], [C(1, 1, 1600, 2, 1)], async () => null);
    check('a failed participants fetch never assigns', nullNames.assigned.length === 0 && nullNames.unresolved.length === 1);
  }
  {
    const prog = { programme: { reunions: [
      { numOfficiel: 4, pays: { code: 'FRA' }, hippodrome: { libelleLong: 'HIPPODROME DE SAINT MALO', codeHippodrome: 'S-M' },
        courses: [{ numOrdre: 1, distance: 1800, nombreDeclaresPartants: 12, heureDepart: 5000, discipline: 'PLAT', libelle: 'PRIX DE LA CHALOTAIS' }] },
      { numOfficiel: 1, pays: { code: 'FRA' }, hippodrome: { libelleCourt: 'VICHY' },
        courses: [{ numOrdre: 1, distance: 1400, nombreDeclaresPartants: 7, heureDepart: 1000 }] },
    ] } };
    const cs = pmuCoursesFromProgramme(prog);
    check('programme flattens every réunion × course', cs.length === 2);
    check('and sorts by start time', cs[0].startMs === 1000 && cs[1].startMs === 5000);
    check('hippodrome falls back to libelleCourt', cs[0].hippo === 'VICHY');
    check('long hippodrome name preferred', cs[1].hippo === 'HIPPODROME DE SAINT MALO');
    check('empty programme is safe', pmuCoursesFromProgramme({}).length === 0 && pmuCoursesFromProgramme(null).length === 0);
  }

  console.log('\n=== 8. SOURCE TEXT: SGPools numbering only, errors surfaced ===');
  {
    const pack = { date: '22/07/2026' };
    const meet = { venue: 'France', raceMap: [
      { raceNo: 1, dist: '1800m', fieldSize: 3, runners: [{ no: 1, name: 'BANSKY' }, { no: 2, name: 'VENT DU LARGE' }, { no: 3, name: 'DEUX PONTS' }] },
      { raceNo: 2, dist: '2500m', fieldSize: 2, runners: [{ no: 1, name: 'GHOST' }, { no: 2, name: 'PHANTOM' }] },
    ] };
    const courses = [C(4, 1, 1800, 3, 1000), C(5, 1, 2500, 2, 2000)];
    const m = await matchCard(
      meet.raceMap.map((r) => ({ raceNo: r.raceNo, dist: r.dist, fieldSize: r.fieldSize, runners: r.runners })),
      courses,
      lookup({ '4|1': ['BANSKY', 'VENT DU LARGE', 'DEUX PONTS', 'LATE ADDITION'], '5|1': ['NOT', 'THESE'] })
    );
    const txt = pmuSourceText(pack, meet, m);
    check('text maps SGPools race -> PMU course', /SGPools R1 = PMU R4\/C1/.test(txt));
    check('text carries the SGPools horse numbers', /1 BANSKY, 2 VENT DU LARGE, 3 DEUX PONTS/.test(txt));
    check('text states numbering provenance', /PMU numbering is deliberately not carried across/.test(txt));
    check('text flags a PMU-only runner', /LATE ADDITION/.test(txt) && /likely scratched\/added/.test(txt));
    check('text surfaces the unmatched race loudly', /SGPools R2: NO PMU COURSE MATCHED/.test(txt));
    check('the card date is present for the SSOT date check', txt.includes('22/07/2026'));
    // the SSOT gate must be able to verify this text: card runner names must appear
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const body = norm(txt);
    check('SSOT gate would find the card runners in this text',
      ['BANSKY', 'VENT DU LARGE', 'DEUX PONTS'].every((n) => body.includes(norm(n))));
  }

  console.log('\n=== 9. WIRING: FR ONLY, PER MEET ===');
  {
    const fs = require('fs'), path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'trawl.js'), 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    check('adapter is invoked from stageSources', code.includes('pmuFranceSource(pack, m)'));
    check('scoped to FR meets only', /filter\(\(m\) => m\.region === "FR"\)/.test(code));
    // The France adapter must be gated by the FR filter and nothing else. This used to
    // assert that no other region appeared within 400 characters, which was a proxy for
    // that and stopped being one on 22/07/2026 when the Australian adapters were wired in
    // directly below — a passing proxy that fails the moment a NEIGHBOUR appears was
    // testing adjacency, not scoping. Assert the real thing: the region filter that
    // governs the pmuFranceSource call is FR.
    const callIdx = code.indexOf('pmuFranceSource(pack, m)');
    const before = code.slice(0, callIdx);
    const regionFilters = [...before.matchAll(/m\.region === "([A-Z]{2})"/g)];
    check('the region filter governing the FR call is FR',
      callIdx > 0 && regionFilters.length > 0 &&
      regionFilters[regionFilters.length - 1][1] === 'FR');
    check('pmuFranceSource is invoked exactly once',
      code.split('pmuFranceSource(pack, m)').length - 1 === 1);
    check('attached AFTER the region fan-out (per meet, not per region)',
      code.indexOf('m.sources = (byRegion') < code.indexOf('pmuFranceSource(pack, m)'));
    check('source is tagged kind:"card"', code.includes('kind: "card"'));
    check('adapter failure cannot break the sweep', /catch \(e\) \{[\s\S]{0,220}pmu-racecard/.test(code));
    check('AU adapter list untouched', /AU: \[[\s\S]{0,600}justhorseracing[\s\S]{0,400}racing-nsw/.test(src));
  }

  console.log('\n============================================================');
  console.log(`GRAND TOTAL: ${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILURES:', fails.join(' | ')); process.exitCode = 1; }
  else console.log('ALL PMU FRANCE CHECKS PASSED ✓');
  console.log('============================================================');
})();
