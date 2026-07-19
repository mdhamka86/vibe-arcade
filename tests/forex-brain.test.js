// tests/forex-brain.test.js
// Phase 1 gate tests for the forex brain (see FOREX_BRAIN.md Sections 5 & 9).
// Run locally:  node --test tests/forex-brain.test.js
// These cover the deterministic core. No network, no Redis, no model calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG, computeBox, computeAtr, convergenceFloorOk, isStale,
  redFolderImminent, validateVerdict, forceFlat,
} from "../api/forex-brain.js";

// ------------------------------------------------------- golden fixtures ----
// A hand-built newest-first H1 candle series: index 0 is in-progress and must
// be EXCLUDED from the box. Highs peak at 1.0930 (idx 3), lows floor at 1.0850
// (idx 7), both inside the 24-candle window.

function fixtureCandles() {
  const c = [];
  for (let i = 0; i < 40; i++) {
    c.push({ datetime: `t-${i}`, open: "1.0900", high: "1.0910", low: "1.0890", close: "1.0900" });
  }
  c[0].high = "1.2000"; c[0].low = "1.0000";   // in-progress spike: must be ignored
  c[3].high = "1.0930";                          // true box high
  c[7].low = "1.0850";                           // true box low
  c[30].high = "1.5000";                         // outside 24-window: must be ignored
  return c;
}

test("computeBox uses completed candles only and finds true extremes", () => {
  const box = computeBox(fixtureCandles(), 24);
  assert.equal(box.high, 1.093);
  assert.equal(box.low, 1.085);
  assert.ok(Math.abs(box.size - 0.008) < 1e-9);
});

test("computeBox refuses thin data", () => {
  assert.equal(computeBox(fixtureCandles().slice(0, 10), 24), null);
  assert.equal(computeBox(null, 24), null);
});

test("computeBox refuses garbage candles", () => {
  const c = fixtureCandles();
  c[5].high = "not-a-number";
  assert.equal(computeBox(c, 24), null);
});

test("computeAtr returns a sane positive value and refuses thin data", () => {
  const atr = computeAtr(fixtureCandles(), CONFIG.atrPeriod);
  assert.ok(atr > 0);
  assert.equal(computeAtr(fixtureCandles().slice(0, 5), CONFIG.atrPeriod), null);
});

// ------------------------------------------------------ convergence floor ----

test("convergence floor blocks thin sourcing", () => {
  assert.equal(convergenceFloorOk({ hit: 1, expected: 5 }, CONFIG.minSources), false);
  assert.equal(convergenceFloorOk({ hit: CONFIG.minSources, expected: 5 }, CONFIG.minSources), true);
  assert.equal(convergenceFloorOk(null, CONFIG.minSources), false);
});

// --------------------------------------------------------------- staleness ----

test("stale verdicts are dead verdicts", () => {
  const now = "2026-07-20T10:00:00Z";
  assert.equal(isStale({ expiresAt: "2026-07-20T09:59:59Z" }, now), true);
  assert.equal(isStale({ expiresAt: "2026-07-20T10:00:01Z" }, now), false);
  assert.equal(isStale({}, now), true);
  assert.equal(isStale(null, now), true);
});

// --------------------------------------------------------- red-folder guard ----

test("red-folder guard fires only for imminent high-impact events on the pair's currencies", () => {
  const now = "2026-07-20T10:00:00Z";
  const soonEur = [{ time: "2026-07-20T10:30:00Z", impact: "High", currency: "EUR", title: "ECB" }];
  const soonJpy = [{ time: "2026-07-20T10:30:00Z", impact: "High", currency: "JPY", title: "BOJ" }];
  const farEur  = [{ time: "2026-07-20T13:00:00Z", impact: "High", currency: "EUR", title: "ECB" }];
  const lowEur  = [{ time: "2026-07-20T10:30:00Z", impact: "Low",  currency: "EUR", title: "minor" }];
  const ccys = ["EUR", "USD"];
  assert.equal(redFolderImminent(soonEur, now, 45, ccys), true);
  assert.equal(redFolderImminent(soonJpy, now, 45, ccys), false);
  assert.equal(redFolderImminent(farEur, now, 45, ccys), false);
  assert.equal(redFolderImminent(lowEur, now, 45, ccys), false);
  assert.equal(redFolderImminent([], now, 45, ccys), false);
  assert.equal(redFolderImminent(null, now, 45, ccys), false);
});

// ------------------------------------------------------- verdict validator ----

const NOW = "2026-07-20T08:05:00Z";

function goodBuy() {
  return {
    verdictId: "2026-07-20T08:00Z-eurusd", symbol: "EURUSD", direction: "BUY",
    conviction: 72,
    entryZone: { trigger: 1.09, maxChase: 1.0915 },
    slPrice: 1.0812, tpPrice: 1.092, riskPercent: 0.5,
    expiresAt: "2026-07-20T12:00:00Z",
    sourcesReached: { hit: 4, expected: 5, missing: [] },
    rationale: "ECB hawkish, EUR coiled under 1.0900 with box compression.",
  };
}

test("a well-formed BUY verdict passes", () => {
  assert.equal(validateVerdict(goodBuy(), NOW).ok, true);
});

test("BUY with SL on the wrong side is rejected", () => {
  const v = goodBuy(); v.slPrice = 1.095;
  const r = validateVerdict(v, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("sl must be below")));
});

test("SELL geometry is enforced in mirror", () => {
  const v = goodBuy();
  v.direction = "SELL";
  v.entryZone = { trigger: 1.085, maxChase: 1.0835 };
  v.slPrice = 1.0862; v.tpPrice = 1.078;
  assert.equal(validateVerdict(v, NOW).ok, true);
  v.tpPrice = 1.09; // tp above trigger on a SELL: wrong
  assert.equal(validateVerdict(v, NOW).ok, false);
});

test("risk above the cap is rejected", () => {
  const v = goodBuy(); v.riskPercent = CONFIG.maxRiskPercent + 0.1;
  const r = validateVerdict(v, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("above cap")));
});

test("an expired verdict is rejected even if otherwise perfect", () => {
  const v = goodBuy(); v.expiresAt = "2026-07-20T08:00:00Z";
  const r = validateVerdict(v, NOW);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("stale")));
});

test("invalid direction, bad conviction, and missing fields are rejected", () => {
  assert.equal(validateVerdict({ ...goodBuy(), direction: "LONG" }, NOW).ok, false);
  assert.equal(validateVerdict({ ...goodBuy(), conviction: 140 }, NOW).ok, false);
  assert.equal(validateVerdict({ ...goodBuy(), conviction: 71.5 }, NOW).ok, false);
  const v = goodBuy(); delete v.slPrice;
  assert.equal(validateVerdict(v, NOW).ok, false);
  assert.equal(validateVerdict(null, NOW).ok, false);
});

test("FLAT verdicts need no trade geometry but still need identity, expiry, sources, rationale", () => {
  const flat = forceFlat("EURUSD", NOW, "convergence floor: 1/3 sources", { hit: 1, expected: 5, missing: [] });
  assert.equal(validateVerdict(flat, NOW).ok, true);
  assert.equal(flat.direction, "FLAT");
  assert.ok(flat.rationale.includes("FORCED FLAT"));
  const bad = { ...flat }; delete bad.sourcesReached;
  assert.equal(validateVerdict(bad, NOW).ok, false);
});

// ----------------------------------------- source-failure degradation path ----
// Simulates Section 5: every source dead => the ONLY legal output is FLAT.

test("total source failure degrades to a valid FLAT, never a directional call", () => {
  const sourcesReached = { hit: 0, expected: 5, missing: [{ id: "all", error: "network down" }] };
  assert.equal(convergenceFloorOk(sourcesReached, CONFIG.minSources), false);
  const v = forceFlat("USDJPY", NOW, "convergence floor: 0/3 sources", sourcesReached);
  const r = validateVerdict(v, NOW);
  assert.equal(r.ok, true);
  assert.equal(v.direction, "FLAT");
});
