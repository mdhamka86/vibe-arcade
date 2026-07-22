// tests/test_au_sources.js — the Australian card + opinion sources.
//
// Australia went SSOT-blind on 22/07/2026: justhorseracing 403'd, racingnsw's homepage
// named 0 of 468 card runners, and all three AU meets were flagged "NO data edge here
// today". Two sources replaced it — TAB for the card, racing.com for the opinion — and
// this suite exists to hold the two failures that were actually possible:
//
//   1. MATCHING THE WRONG RACE. SGPools interleaves two source meets into one renumbered
//      coupon, so SGPools R13 is Doomben R7 and racing.com's own "R7" tip means SGPools
//      R13. Any adapter that carries a source's numbering across bets a horse nobody
//      analysed. That is the 17/07 FAIRY KNIGHT failure and it must not recur.
//   2. racing.com TAKING THE TRAWL WITH IT. Its key is a client-side key that can be
//      rotated without notice. Australia is allowed to degrade to card-only. It is not
//      allowed to break.
//
// These drive the REAL exported functions with injected data — no network.
import * as T from "../api/trawl.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};

const { matchCard, tabAustraliaSource, tabSourceText, rdcSourceForMeet, rdcText } = T;
if ([matchCard, tabAustraliaSource, rdcSourceForMeet, rdcText].some((f) => typeof f !== "function")) {
  console.error("trawl.js no longer exports the AU adapter functions.");
  process.exit(1);
}

// ---- fixtures: the 22/07/2026 shape, trimmed. "Australia" interleaved Doomben and
// Canterbury; SGPools R1=DBN1, R2=CBY1, R3=DBN2, R4=CBY2.
const pack = { date: "22/07/2026" };
const meet = {
  region: "AU", venue: "Australia",
  raceMap: [
    { raceNo: 1, dist: "1350m", fieldSize: 3, runners: [{ no: 1, name: "HIGHLAND KITTY" }, { no: 2, name: "SATURDAYS GIRL" }, { no: 3, name: "BOSSIRI" }] },
    { raceNo: 2, dist: "1100m", fieldSize: 3, runners: [{ no: 1, name: "NEESON" }, { no: 2, name: "ROYAL AIR FORCE" }, { no: 3, name: "LULL" }] },
    { raceNo: 3, dist: "1350m", fieldSize: 3, runners: [{ no: 1, name: "BOWLING HARRY" }, { no: 2, name: "CAUTIONARY TAIL" }, { no: 3, name: "CHANCE DE LUNE" }] },
  ],
};
const R = (venue, c, dist, names, startMs) => ({
  R: venue, C: c, hippo: venue === "DBN" ? "DOOMBEN" : "CANTERBURY",
  pays: venue === "DBN" ? "QLD" : "NSW", dist, partants: names.length,
  startMs, discipline: "", libelle: "TEST HANDICAP",
  runners: names.map((n, i) => ({ no: i + 1, name: n, barrier: i + 1, jockey: "J Smith", trainer: "T Jones", weight: 58, last5: "1x234", scratched: false })),
});
const day = () => ({
  ok: true, fetched: 4, capped: 0, errors: [],
  meetings: ["DBN (QLD)", "CBY (NSW)"],
  races: [
    R("DBN", 1, 1350, ["HIGHLAND KITTY", "SATURDAYS GIRL", "BOSSIRI"], 1000),
    R("CBY", 1, 1100, ["NEESON", "ROYAL AIR FORCE", "LULL"], 2000),
    R("DBN", 2, 1350, ["BOWLING HARRY", "CAUTIONARY TAIL", "CHANCE DE LUNE"], 3000),
    R("CBY", 2, 1200, ["PERSIAN WONDER", "ARGANSORT", "YOSHIDA"], 4000),
  ],
});
const clone = (o) => JSON.parse(JSON.stringify(o));

(async () => {
  console.log("\n=== 1. THE RENUMBERING TRAP: SGPools numbering wins, always ===");
  {
    const m = clone(meet);
    const src = await tabAustraliaSource(pack, m, day(), new Set());
    check("all three coupon races matched", src.ok && src.tab.matched === 3);
    check("SGPools R2 resolves to CANTERBURY race 1, not race 2",
      src.tab.races.find((r) => r.sgRaceNo === 2).venue === "CBY" &&
      src.tab.races.find((r) => r.sgRaceNo === 2).srcRaceNo === 1);
    check("SGPools R3 resolves to DOOMBEN race 2",
      src.tab.races.find((r) => r.sgRaceNo === 3).srcRaceNo === 2);
    check("the merge of two TAB meetings is reported, not collapsed",
      src.tab.meetings.length === 2 && src.tab.meetings.join(",") === "CBY,DBN");
    // the bug the .map(Number) fix was for
    check("venue mnemonics survive grouping (no NaN)",
      !src.tab.meetings.some((x) => typeof x === "number" && isNaN(x)) && !/NaN/.test(src.text));
    check("the text states SGPools numbering is authoritative",
      /Horse and race numbers below are the SGPools card's own/.test(src.text));
    check("the text never presents a TAB race number as the coupon's",
      /SGPools R2 = CBY race 1/.test(src.text));
  }

  console.log("\n=== 2. NAMES DECIDE — distance and field size never assign alone ===");
  {
    // A TAB race at the right distance and field size whose runners are strangers.
    const d = day();
    d.races = [R("DBN", 9, 1350, ["NOT A", "NOT B", "NOT C"], 500), ...d.races];
    const m = clone(meet);
    const src = await tabAustraliaSource(pack, m, d, new Set());
    check("a same-distance same-field impostor is NOT matched",
      !src.tab.races.some((r) => r.srcRaceNo === 9));
    check("the real race is still found", src.tab.matched === 3);
  }
  {
    // Nothing matches at all -> loud per race, no silent assignment.
    const d = day();
    d.races = d.races.map((r) => ({ ...r, runners: r.runners.map((x, i) => ({ ...x, name: "STRANGER " + i })) }));
    const m = clone(meet);
    const src = await tabAustraliaSource(pack, m, d, new Set());
    check("zero overlap assigns nothing", src.tab.matched === 0 && !src.ok);
    check("every unmatched race is reported individually", src.tab.unresolved.length === 3);
    check("the reason names TAB, not PMU",
      /\bTAB\b/.test(src.tab.unresolved[0].why) && !/PMU/.test(src.tab.unresolved[0].why));
    check("the reason quotes the runner-name overlap that fell short",
      /runner-name overlap/.test(src.tab.unresolved[0].why));
  }

  console.log("\n=== 3. ±20m DISTANCE TOLERANCE (Pinjarra 1600 vs 1613) ===");
  {
    const m = clone(meet);
    m.raceMap = [{ raceNo: 1, dist: "1600m", fieldSize: 3, runners: [{ no: 1, name: "SHOWLAS" }, { no: 2, name: "SISU SPIRIT" }, { no: 3, name: "AZABELLE" }] }];
    const d = { ok: true, fetched: 1, capped: 0, errors: [], meetings: ["PJA (WA)"],
      races: [R("PJA", 6, 1613, ["SHOWLAS", "SISU SPIRIT", "AZABELLE"], 1000)] };
    const src = await tabAustraliaSource(pack, m, d, new Set());
    check("a 13m rounding difference still matches", src.ok && src.tab.matched === 1);
  }
  {
    // France must be untouched: distTol defaults to exact.
    const sg = [{ raceNo: 1, dist: "1600m", fieldSize: 2, runners: [{ no: 1, name: "A" }, { no: 2, name: "B" }] }];
    const courses = [{ R: 1, C: 1, dist: 1613, partants: 2, startMs: 1, hippo: "X" }];
    const m = await matchCard(sg, courses, async () => ["A", "B"]);
    check("matchCard's default is still EXACT distance (France unchanged)",
      m.assigned.length === 1 && m.assigned[0].tried === 1);
  }

  console.log("\n=== 4. ONE TAB RACE IS NEVER GIVEN TO TWO COUPON CONTAINERS ===");
  {
    // Two SGPools containers whose cards both contain the same horses. Without the
    // shared claim set, both would match the same TAB race.
    const a = clone(meet);
    const b = clone(meet); b.venue = "Australia (Melbourne)";
    const claimed = new Set();
    const d = day();
    const sa = await tabAustraliaSource(pack, a, d, claimed);
    const sb = await tabAustraliaSource(pack, b, d, claimed);
    const keys = sa.tab.races.map((r) => r.venue + "|" + r.srcRaceNo);
    const keysB = sb.tab.races.map((r) => r.venue + "|" + r.srcRaceNo);
    check("the first container matches", sa.tab.matched === 3);
    check("the second cannot re-claim the same TAB races",
      keysB.every((k) => !keys.includes(k)));
  }

  console.log("\n=== 5. priceRef IS PERSISTED FOR THE PRICE STAGE ===");
  {
    const m = clone(meet);
    await tabAustraliaSource(pack, m, day(), new Set());
    const r2 = m.raceMap.find((r) => r.raceNo === 2);
    check("priceRef is written onto the coupon race",
      r2.priceRef && r2.priceRef.src === "tab" && r2.priceRef.venue === "CBY");
    check("priceRef carries the SOURCE race number, not the coupon's",
      r2.priceRef.srcRaceNo === 1);
    check("an unmatched race gets no priceRef", m.raceMap.every((r) => !r.priceRef || r.priceRef.srcRaceNo));
  }

  console.log("\n=== 6. TAB's 200-WITH-HTML LIE, AND THE NO-HISTORY WINDOW ===");
  {
    const dead = { ok: false, races: [], error: "TAB listed no Australian thoroughbred meetings for 21/07/2026. TAB carries today and tomorrow only" };
    const m = clone(meet);
    const src = await tabAustraliaSource(pack, m, dead, new Set());
    check("a dead day yields a failed source, never a throw", src.ok === false && !!src.error);
    check("the source carries no text when it matched nothing", src.text === "");
    check("the reason explains the today+tomorrow window", /today and tomorrow only/.test(src.error));
  }

  console.log("\n=== 7. racing.com: TIPS RESOLVE ONTO SGPools NUMBERING ===");
  const rdcDay = () => ({
    ok: true,
    meets: [{
      venueName: "doomben", state: "QLD", isTab: 1,
      meetTips: [{
        tipster: { tipsterName: "Michael Heaton" },
        shortComment: "Solid card.",
        bestBet: { comment: "Well placed.", raceEntryItem: { horseName: "Bowling Harry", raceNumber: 2, raceEntryNumber: 1 } },
        bestValue: null, bestRoughie: null,
      }],
      races: [{
        raceNumber: 2,
        raceTips: [{
          tipType: "form analyst", comment: null, tipster: { tipsterName: "Rylie Morgan" },
          tips: [
            { position: 1, comment: "Liked the trial.", raceEntryItem: { horseName: "Cautionary Tail", raceNumber: 2, raceEntryNumber: 2 } },
            { position: 2, comment: null, raceEntryItem: { horseName: "Chance De Lune", raceNumber: 2, raceEntryNumber: 3 } },
          ],
        }],
      }],
    }],
  });
  {
    const src = rdcSourceForMeet(pack, clone(meet), rdcDay());
    check("the source is usable", src.ok && src.chars > 200);
    // racing.com called it its own R2. On this coupon it is R3.
    check("a racing.com R2 tip is re-labelled SGPools R3",
      /BEST BET: SGPools R3 #1 BOWLING HARRY/.test(src.text));
    check("racing.com's own numbering is shown but marked as reference only",
      /racing\.com carded it as its own R2 #1/.test(src.text) &&
      /must never be bet from/.test(src.text));
    check("per-race analyst picks also resolve to coupon numbering",
      /1\. SGPools R3 #2 CAUTIONARY TAIL/.test(src.text));
    check("the analyst's reasoning survives", /Liked the trial/.test(src.text));
    check("the named tipsters are attributed", /Michael Heaton/.test(src.text) && /Rylie Morgan/.test(src.text));
    check("it is NOT a card source (it must count as opinion)", src.kind !== "card");
  }
  {
    // Tips for a DIFFERENT coupon container must not leak into this one.
    const d = rdcDay();
    d.meets[0].meetTips[0].bestBet.raceEntryItem.horseName = "SOME PERTH HORSE";
    d.meets[0].races[0].raceTips[0].tips = [{ position: 1, comment: "x", raceEntryItem: { horseName: "ANOTHER PERTH HORSE", raceNumber: 1, raceEntryNumber: 1 } }];
    const src = rdcSourceForMeet(pack, clone(meet), d);
    check("tips naming no horse on this card produce a FAILED source, not empty prose",
      src.ok === false && /none named a horse on the SGPools card/.test(src.error));
    check("and no text is handed to the model", !src.text);
  }

  console.log("\n=== 8. racing.com IS NON-LOAD-BEARING (key rotation, outage, junk) ===");
  {
    const modes = [
      ["key rotated (401)", { ok: false, meets: [], error: "racing.com HTTP 401" }],
      ["schema changed (200 + errors)", { ok: false, meets: [], error: "racing.com GraphQL: FieldUndefined" }],
      ["timeout", { ok: false, meets: [], error: "racing.com timeout after 20000ms" }],
      ["empty day", { ok: false, meets: [], error: "racing.com returned no TAB meetings for 22/07/2026" }],
    ];
    for (const [label, d] of modes) {
      const src = rdcSourceForMeet(pack, clone(meet), d);
      check(label + " -> failed source, no throw, no text", src.ok === false && !src.text && !!src.error);
    }
  }
  {
    // The card path must be completely unaffected by any of it.
    const m = clone(meet);
    const card = await tabAustraliaSource(pack, m, day(), new Set());
    const tips = rdcSourceForMeet(pack, m, { ok: false, meets: [], error: "racing.com HTTP 401" });
    check("TAB still delivers a full card while racing.com is down",
      card.ok && card.tab.matched === 3 && tips.ok === false);
    check("AU degrades to card-only: verified but with zero opinion sources",
      card.kind === "card" && tips.ok === false);
  }

  console.log("\n=== 9. THE JSON-ENCODED-STRING PARSE TRAP ===");
  {
    check("a JSON-encoded string comment is decoded",
      rdcText('{"comment":"Blinkers get added."}') === "Blinkers get added.");
    check("a plain object still works", rdcText({ comment: "Plain object." }) === "Plain object.");
    check("a plain string passes through", rdcText("Just prose.") === "Just prose.");
    check("HTML is stripped", rdcText("<p>Bold <b>call</b></p>") === "Bold call");
    check("null/undefined are safe", rdcText(null) === "" && rdcText(undefined) === "");
    check("malformed JSON does not throw and is not silently dropped",
      rdcText('{"comment":"unclosed') === '{"comment":"unclosed');
    // the actual bug: reading .comment off a string yields undefined -> silent empty
    const raw = '{"comment":"2. SLIP THE JAB never fired last start."}';
    check("the trap itself: .comment on the raw string is undefined", raw.comment === undefined);
    check("but rdcText recovers the prose", /SLIP THE JAB/.test(rdcText(raw)));
  }

  console.log("\n=== 10. SAFETY / SHAPE ===");
  {
    const empty = await tabAustraliaSource(pack, { venue: "Australia", raceMap: [] }, day(), new Set());
    check("an empty coupon is safe", empty.ok === false && !empty.text);
    const noRunners = await tabAustraliaSource(
      pack, { venue: "Australia", raceMap: [{ raceNo: 1, dist: "1200m", fieldSize: 0, runners: [] }] }, day(), new Set());
    check("a race with no runners is unresolved, not matched",
      noRunners.tab.matched === 0 && /nothing to match on/.test(noRunners.tab.unresolved[0].why));
    const noTips = rdcSourceForMeet(pack, clone(meet), { ok: true, meets: [] });
    check("a tips day with no meets fails cleanly", noTips.ok === false);
    const src = await tabAustraliaSource(pack, clone(meet), day(), new Set());
    check("card source is tagged kind:card so convergence never counts it as a view",
      src.kind === "card");
    check("runner detail is carried for the model", /barrier 1, J Smith, tr\. T Jones, 58kg/.test(src.text));
  }
  {
    // A matched runner TAB carries no detail for must NOT be labelled unnamed — that
    // label is reserved for a genuine name-match failure, and the first live run
    // printed it against all 38 correctly-matched races.
    const d = day();
    d.races = d.races.map((r) => ({ ...r, runners: r.runners.map((x) => ({ no: x.no, name: x.name, barrier: null, jockey: null, trainer: null, weight: null, last5: null, scratched: false })) }));
    const src = await tabAustraliaSource(pack, clone(meet), d, new Set());
    check("a detail-less but NAMED runner is not called unnamed", !/NOT named by TAB/.test(src.text));
    check("and it still card-matches at 100%", src.tab.races.every((r) => r.overlap === 1));
    // now a runner TAB really does not name
    const d2 = day();
    d2.races[0].runners = d2.races[0].runners.filter((x) => x.name !== "BOSSIRI");
    const src2 = await tabAustraliaSource(pack, clone(meet), d2, new Set());
    check("a genuinely unnamed runner IS flagged", /3 BOSSIRI  \(NOT named by TAB on this race\)/.test(src2.text));
  }

  console.log("\n=== 11. WIRING: AU ONLY, PER MEET, DAY FETCHED ONCE ===");
  {
    const fs = await import("fs");
    const url = await import("url");
    const path = await import("path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "api", "trawl.js"), "utf8");
    const code = raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    const callIdx = code.indexOf("tabAustraliaSource(pack, m, tabDay, claimed)");
    const before = code.slice(0, callIdx);
    const filters = [...before.matchAll(/m\.region === "([A-Z]{2})"/g)];
    check("the region filter governing the AU call is AU",
      callIdx > 0 && filters.length > 0 && filters[filters.length - 1][1] === "AU");
    check("attached AFTER the region fan-out (per meet, not per region)",
      code.indexOf("m.sources = (byRegion") < callIdx);
    // Count CALL sites only — "tabDayRaces(pack)" also matches the function's own
    // definition, and counting that made this assert 1-call while allowing zero.
    check("the day's TAB races are fetched ONCE, not per meet",
      code.split("await tabDayRaces(pack)").length - 1 === 1 &&
      code.indexOf("await tabDayRaces(pack)") < callIdx);
    check("the day's racing.com tips are fetched ONCE, not per meet",
      code.split("await rdcDayTips(pack)").length - 1 === 1 &&
      code.indexOf("await rdcDayTips(pack)") < callIdx);
    check("the claim set is created once and shared across AU meets",
      /const claimed = new Set\(\);[\s\S]{0,200}for \(const m of auMeets\)/.test(code));
    check("AU meets are matched sequentially (a shared claim set cannot be raced)",
      /for \(const m of auMeets\)/.test(code) && !/auMeets[\s\S]{0,80}Promise\.all/.test(code));
    check("a TAB adapter throw cannot break the sweep",
      /catch \(e\) \{[\s\S]{0,220}tab-racecard/.test(code));
    check("a racing.com adapter throw cannot break the sweep",
      /catch \(e\) \{[\s\S]{0,240}racing-com-tips/.test(code));
    check("the racing.com DAY fetch is itself wrapped",
      /try \{[\s\S]{0,120}rdcDayTips\(pack\)[\s\S]{0,200}catch/.test(code));
    check("the TAB DAY fetch is itself wrapped",
      /try \{[\s\S]{0,120}tabDayRaces\(pack\)[\s\S]{0,200}catch/.test(code));
    check("France's adapter is not invoked for AU meets",
      !/auMeets[\s\S]{0,600}pmuFranceSource/.test(code));
    // A stage=sources re-run loads the pack back from Redis, so the previous run's
    // ssotBlind verdict rides along unless it is cleared. The first live AU run came
    // back fully sourced and still stamped "NO data edge here today".
    check("the ssotBlind verdict is cleared before being re-decided",
      /delete m\.ssotBlind;[\s\S]{0,400}m\.ssotBlind =/.test(code));
    check("the dead AU tipster adapters are left alone (not silently revived)",
      /AU: \[[\s\S]{0,600}justhorseracing/.test(raw));
  }

  console.log("\n" + "=".repeat(60));
  console.log("GRAND TOTAL: " + pass + " passed, " + fail + " failed");
  if (fail) { console.log("AU SOURCE CHECKS FAILED ✗"); process.exit(1); }
  console.log("ALL AU SOURCE CHECKS PASSED ✓");
  console.log("=".repeat(60));
})();
