// api/stewards.js
// THE STEWARDS' ROOM — vault API for The Outsider Method.
// Phase 1: the vault (seed v52 into Redis, serve, audit).
// Phase 2: the quill (log legs at slip time, settle results, day wrap, notes),
//          every write snapshot-backed, read-back verified, and revision-counted.
//
// Actions:
//   GET  ?action=status
//   POST ?action=import      {force}
//   GET  ?action=state&slice=betlog|daily|notes|running|formulas|all
//   GET  ?action=audit
//   POST ?action=addlegs     {date?, legs:[{date?,meet,raceNo,horseNo,horseName,betType,stake,confidence?,ledger?,reason?,notes?}]}
//   POST ?action=settle      {settlements:[{xlRow,result,payout?,position?,amend?}]}
//   POST ?action=dailyupsert {date, meets?, openingWallet?, bestBet?, worstBet?, lessons?}
//   POST ?action=addnote     {text}
//   POST ?action=restore     {slice: betlog|daily|notes}
//
// Keys: stw:meta, stw:betlog, stw:daily, stw:notes, stw:running, stw:formulas,
//       stw:prev:* (rolling pre-write snapshots)

const crypto = require("crypto");
const seed = require("./stewards-seed.json");

const R_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const R_TOK =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function redis(cmds) {
  const r = await fetch(R_URL + "/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + R_TOK,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("Redis HTTP " + r.status);
  const j = await r.json();
  const bad = j.find((x) => x.error);
  if (bad) throw new Error("Redis: " + bad.error);
  return j.map((x) => x.result);
}

// ---- normalisation layer (raw rows stay verbatim; computations use this) ----
function normResult(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (s === "loss") return "lose";
  return s;
}
function normConf(v) {
  const s = String(v == null ? "" : v).trim();
  if (s === "Med-High") return "Medium-High";
  return s || "(no label)";
}
function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}
function r2(v) {
  return Math.round(num(v) * 100) / 100;
}

// ---- audit engine ----
function computeAudit(betLog) {
  const flags = [];
  const by = (l) =>
    betLog.filter((b) => String(b.ledger || "").trim().toLowerCase() === l);
  const model = by("model");
  const exotic = by("exotic");
  const misclick = by("misclick");
  const refund = by("refund");
  const voided = by("void");
  const accounted =
    model.length + exotic.length + misclick.length + refund.length + voided.length;
  if (accounted !== betLog.length)
    flags.push(
      "OBJECTION: " +
        (betLog.length - accounted) +
        " rows carry an unknown ledger tag"
    );

  const settled = model.filter((b) =>
    ["win", "place", "lose"].includes(normResult(b.result))
  );
  const pending = model.filter((b) => normResult(b.result) === "pending");
  const wins = settled.filter((b) => normResult(b.result) === "win").length;
  const places = settled.filter((b) => normResult(b.result) === "place").length;
  const losses = settled.filter((b) => normResult(b.result) === "lose").length;
  if (settled.length + pending.length !== model.length)
    flags.push(
      "OBJECTION: " +
        (model.length - settled.length - pending.length) +
        " model legs have an unrecognised result value"
    );

  // Note: "Loss"->"Lose" and "Med-High"->"Medium-High" are still normalised silently
  // in all computed figures below. They were once surfaced as notices, but they describe
  // permanent, actionless quirks of the original journal, so they no longer clutter the panel.

  const pendingNoReceipt = pending.filter(
    (b) => !/receipt\s+[0-9A-F-]{6,}/i.test(String(b.notes || ""))
  ).length;
  if (pendingNoReceipt)
    flags.push(
      "NOTICE: " +
        pendingNoReceipt +
        " pending legs have no receipt number in Notes"
    );

  const sum = (arr, k) => r2(arr.reduce((a, b) => a + num(b[k]), 0));

  const split = {};
  for (const t of ["WIN", "PLA"]) {
    const legs = settled.filter((b) => String(b.betType).trim() === t);
    split[t] = {
      bets: legs.length,
      staked: sum(legs, "stake"),
      payout: sum(legs, "payout"),
      netPL: r2(sum(legs, "payout") - sum(legs, "stake")),
      cashed: legs.filter((b) => num(b.payout) > 0).length,
    };
  }

  const calib = {};
  for (const b of settled) {
    const c = normConf(b.confidence);
    calib[c] = calib[c] || { bets: 0, staked: 0, payout: 0 };
    calib[c].bets++;
    calib[c].staked += num(b.stake);
    calib[c].payout += num(b.payout);
  }
  for (const c in calib) {
    calib[c].staked = r2(calib[c].staked);
    calib[c].payout = r2(calib[c].payout);
    calib[c].netPL = r2(calib[c].payout - calib[c].staked);
    calib[c].roi = calib[c].staked
      ? Math.round((calib[c].netPL / calib[c].staked) * 1000) / 10
      : 0;
  }

  const exoticSettled = exotic.filter((b) =>
    ["win", "lose"].includes(normResult(b.result))
  );

  return {
    rows: betLog.length,
    ledgers: {
      model: model.length,
      exotic: exotic.length,
      misclick: misclick.length,
      refund: refund.length,
      // Voided rows are excluded from every model figure above, but they are REPORTED
      // here rather than silently vanishing. A row that stopped counting should still be
      // visible: the point of voiding is honesty about a mistake, not concealment of it.
      void: voided.length,
    },
    model: {
      settled: settled.length,
      pending: pending.length,
      pendingStake: sum(pending, "stake"),
      wins,
      places,
      losses,
      staked: sum(settled, "stake"),
      payout: sum(settled, "payout"),
      netPL: r2(sum(settled, "payout") - sum(settled, "stake")),
      strikeRate: settled.length
        ? Math.round(((wins + places) / settled.length) * 1000) / 10
        : 0,
    },
    split,
    calibration: calib,
    exotic: {
      placed: exotic.length,
      settled: exoticSettled.length,
      staked: sum(exoticSettled, "stake"),
      payout: sum(exoticSettled, "payout"),
      netPL: r2(sum(exoticSettled, "payout") - sum(exoticSettled, "stake")),
    },
    flags,
  };
}

// ---- vision reply parsing ----
// THE INTAKE BUG: both vision endpoints did JSON.parse(text.replace(/```json|```/g,"")),
// which assumes the model returns nothing but JSON. It usually does. When it doesn't —
// "I'll carefully extract all horse wagering rows from both pages (6 and 7), skipping
// non-horse rows..." followed by perfectly valid JSON — the parse throws and the whole
// upload is rejected with "Vision reply was not clean JSON". The payload was right there.
// A receipt upload should not fail because the model cleared its throat first.
//
// Brace-counting rather than regex, and string-aware: a "}" inside a horse name, an
// apostrophe in "O'Reilly", or an escaped quote in 'The \"Kid\"' must not end the object
// early. Returns the first balanced top-level object, or null if there genuinely isn't one.
function extractJson(text) {
  if (!text) return null;
  let s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null; // unbalanced: likely truncated by max_tokens
}

// Parse a vision reply into an object, salvaging JSON embedded in prose. Throws an Error
// with a message that tells the user something ACTIONABLE rather than dumping 180 chars
// of the model thinking out loud.
function parseVisionReply(text) {
  const raw = extractJson(text);
  if (!raw) {
    const t = String(text || "").trim();
    if (!t) throw new Error("The vision model returned an empty reply. Try again, or upload fewer pages at once.");
    // Distinguish "the model chatted instead of answering" from "the model started a JSON
    // object and got cut off". Both land here with raw===null, but they need different
    // advice: retry vs upload fewer pages. Saying "replied in prose" about a truncated
    // JSON payload sends the user hunting for the wrong problem.
    if (t.indexOf("{") !== -1) {
      throw new Error(
        "The vision reply was cut off before the JSON finished — it is almost certainly too long for one pass. Upload fewer pages at once."
      );
    }
    throw new Error("The vision model replied in prose with no JSON in it. It said: \"" + t.slice(0, 200) + "\"");
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      "The vision reply contained JSON that would not parse (" + e.message.slice(0, 80) +
      "). This usually means the reply was truncated. Try uploading fewer pages at once."
    );
  }
}

// ---- rule decay audit ----
// THE GAP THE CHARTER HAS: it is superb at forming rules from evidence and terrible at
// noticing when a rule has stopped being true. The Medium-High selection rule is the
// proof. It was promoted on 26/06 off 19 settled PLA legs showing +19.2% ROI — the
// Charter itself wrote "SAMPLE TOO THIN" and then built a selection rule on it anyway.
// By 46 legs that band is -3.9%, and its 95% CI is roughly -36% to +39%: it was never
// distinguishable from noise. Nothing in the journal ever re-tested it, because the
// Charter has no mechanism that asks "is this rule STILL true?".
//
// Power maths from the real book (PLA per-leg return multiple: mean 0.859, sd 0.978):
// detecting a 19-point edge at 80% power needs ~204 settled legs, not 19; a 5-point edge
// needs ~3000. The Charter's gates (10 for exotics, 35-40 for Medium-High sizing) are one
// to two orders of magnitude too small. The discipline was right; the NUMBERS were chosen
// by intuition rather than by power, so the gates cannot fire correctly.
//
// This does not decide anything. It reports, so a decayed rule announces itself.
const Z95 = 1.959964;
function bandStats(legs) {
  const n = legs.length;
  if (!n) return { n: 0 };
  const staked = legs.reduce((a, b) => a + num(b.stake), 0);
  if (!staked) return { n, staked: 0 };
  const payout = legs.reduce((a, b) => a + num(b.payout), 0);
  // HEADLINE ROI is STAKE-WEIGHTED (money out / money in). This is the real-money figure
  // and the one the Charter quotes. It matters because stakes were NOT uniform in the
  // early journal ($5/$10/$15/$20 under the retired variable-staking regime): a mean of
  // per-leg multiples would weight a $5 leg and a $20 leg equally and silently report a
  // different number (-10.5% vs the true -14.1% on WIN).
  const roi = r2(((payout - staked) / staked) * 100);
  // The CI, by contrast, needs the per-leg distribution, so it is built from multiples.
  // It describes the spread of outcomes, not the money total.
  const mult = legs.map((b) => num(b.payout) / (num(b.stake) || 1));
  const mean = mult.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(mult.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1)) : 0;
  const se = n ? sd / Math.sqrt(n) : 0;
  return {
    n, staked: r2(staked), payout: r2(payout), roi,
    cash: legs.filter((b) => num(b.payout) > 0).length,
    // CI is around the equal-weighted mean, so it is indicative of spread rather than an
    // exact interval on the stake-weighted figure. Labelled honestly rather than implied.
    ciLo: r2(((mean - Z95 * se) - 1) * 100),
    ciHi: r2(((mean + Z95 * se) - 1) * 100),
    ciBasis: "equal-weighted per-leg multiples; indicative spread, not an exact CI on the stake-weighted ROI",
    nFor80: sd && Math.abs(mean - 1) > 0.001
      ? Math.ceil(Math.pow(1.96 + 0.84, 2) * Math.pow(sd, 2) / Math.pow(mean - 1, 2))
      : null,
  };
}

function computeRuleDecay(betLog, ruleDateDMY) {
  const toTs = (d) => {
    const m = String(d || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : null;
  };
  const cut = toTs(ruleDateDMY || "26/06/2026");
  const model = betLog.filter((b) => String(b.ledger || "").trim().toLowerCase() === "model");
  const settled = model.filter((b) => ["win", "place", "lose"].includes(normResult(b.result)));
  const before = settled.filter((b) => { const t = toTs(b.date); return t != null && cut != null && t < cut; });
  const after = settled.filter((b) => { const t = toTs(b.date); return t != null && cut != null && t >= cut; });
  const ofType = (arr, t) => arr.filter((b) => String(b.betType).trim() === t);
  const ofBand = (arr, t, c) => ofType(arr, t).filter((b) => normConf(b.confidence) === c);

  const checks = [];

  // CLAIM: "WIN bleeds roughly 2x PLA" — the load-bearing claim under the whole
  // WIN-exposure doctrine.
  const w = bandStats(ofType(settled, "WIN")), p = bandStats(ofType(settled, "PLA"));
  const ratio = (p.roi && w.roi) ? r2(w.roi / p.roi) : null;
  checks.push({
    claim: 'WIN bleeds ~2x PLA',
    status: ratio != null && ratio >= 1.5 ? "HOLDS" : "DECAYED",
    detail: `WIN ${w.roi}% (n=${w.n}) vs PLA ${p.roi}% (n=${p.n}); ratio ${ratio}x. The doctrine assumes ~2x. Full-ledger figures now show the two bet types bleeding at nearly the same rate, so "shift exposure from WIN to PLA" no longer follows from the data that motivated it.`,
    before: { win: bandStats(ofType(before, "WIN")).roi, pla: bandStats(ofType(before, "PLA")).roi },
    after: { win: bandStats(ofType(after, "WIN")).roi, pla: bandStats(ofType(after, "PLA")).roi },
  });

  // CLAIM: "Medium-High PLA is the only solidly green band (+19.2%)"
  const mhAll = bandStats(ofBand(settled, "PLA", "Medium-High"));
  const mhBefore = bandStats(ofBand(before, "PLA", "Medium-High"));
  const mhAfter = bandStats(ofBand(after, "PLA", "Medium-High"));
  checks.push({
    claim: 'Medium-High PLA is the only solidly green band (+19.2%)',
    status: mhAll.roi > 0 ? "HOLDS" : "DECAYED",
    detail: `In-sample (before ${ruleDateDMY}): ${mhBefore.roi}% on n=${mhBefore.n} — the figure the rule was built on. Out-of-sample since: ${mhAfter.roi}% on n=${mhAfter.n}. Combined: ${mhAll.roi}% on n=${mhAll.n}, 95% CI ${mhAll.ciLo}% to ${mhAll.ciHi}%. Detecting the originally claimed edge at 80% power would need roughly ${mhAll.nFor80 || "many hundreds of"} legs.`,
    inSample: mhBefore, outOfSample: mhAfter, combined: mhAll,
  });

  // CLAIM: "Inverted ladder — High is the worst band"
  const bands = ["High", "Medium-High", "Medium", "Low-Med"];
  const winLadder = {};
  for (const c of bands) winLadder[c] = bandStats(ofBand(settled, "WIN", c));
  const hi = winLadder["High"].roi, worst = Math.min(...bands.map((c) => winLadder[c].n ? winLadder[c].roi : Infinity));
  checks.push({
    claim: 'Inverted ladder: High is the worst WIN band',
    status: hi === worst ? "HOLDS" : "PARTIAL",
    detail: bands.map((c) => `${c} ${winLadder[c].roi}% (n=${winLadder[c].n})`).join(" | "),
    ladder: winLadder,
  });

  // Did the 26/06 rule change actually help?
  const bAll = bandStats(before), aAll = bandStats(after);
  checks.push({
    claim: `The ${ruleDateDMY} rule change improved the book`,
    status: aAll.roi > bAll.roi ? "HOLDS" : "DECAYED",
    detail: `Before: ${bAll.roi}% on n=${bAll.n}. After: ${aAll.roi}% on n=${aAll.n}. Note the composition changed too (WIN legs cut), so this is directional, not causal.`,
    before: bAll, after: aAll,
  });

  return {
    ruleDate: ruleDateDMY || "26/06/2026",
    settledLegs: settled.length,
    checks,
    note: "This audit reports; it decides nothing. A claim marked DECAYED is not automatically wrong — it means the evidence that justified it no longer supports it at full-ledger scale, and the rule deserves a fresh look rather than continued inheritance.",
  };
}
// CONCURRENCY: writeVerified proves that what you wrote is what is stored. It CANNOT
// prove that you were writing on top of current data. Every mutating path here is a
// read-modify-write (GET betlog -> concat/mutate -> SET betlog) with no lock, so two
// writers who read the same state both succeed, both report allMatch:true, and the
// second silently destroys the first's rows. With a 07:15 cron and a human using the
// app at the same hour, that is not hypothetical.
//
// The fix is optimistic concurrency: every caller states the checksum of the data it
// READ, and the write is refused if the stored data has moved since. No lock, no
// deadlock, no lost update — the loser is told to re-read and retry rather than
// silently clobbering. `expect` maps redis key -> sha of the value the caller read.
// ---- write plumbing: snapshot, write, read-back verify, bump meta ----
async function writeVerified(updates, expect) {
  const keys = Object.keys(updates);
  const current = await redis(keys.map((k) => ["GET", k]));

  // GUARD: refuse the write if anything we depend on changed under us.
  if (expect && typeof expect === "object") {
    const conflicts = [];
    for (const k of Object.keys(expect)) {
      const idx = keys.indexOf(k);
      const live = idx >= 0 ? current[idx] : (await redis([["GET", k]]))[0];
      const liveSha = live == null ? null : sha(live);
      if (expect[k] !== liveSha) {
        conflicts.push({ key: k, expected: expect[k], actual: liveSha });
      }
    }
    if (conflicts.length) {
      return {
        conflict: true,
        allMatch: false,
        verify: {},
        conflicts,
        message:
          "Refused: the ledger changed since this request read it (" +
          conflicts.map((c) => c.key).join(", ") +
          "). Nothing was written. Re-read and retry so no rows are lost.",
      };
    }
  }

  const cmds = [];
  keys.forEach((k, i) => {
    if (current[i] != null)
      cmds.push(["SET", "stw:prev:" + k.replace("stw:", ""), current[i]]);
  });
  keys.forEach((k) => cmds.push(["SET", k, updates[k]]));
  await redis(cmds);
  const back = await redis(keys.map((k) => ["GET", k]));
  const verify = {};
  let all = true;
  keys.forEach((k, i) => {
    const sent = sha(updates[k]);
    const stored = back[i] == null ? null : sha(back[i]);
    const match = stored === sent;
    if (!match) all = false;
    verify[k] = { sent, stored, match };
  });
  // A failed read-back means the stored value is NOT what we intended. The pre-write
  // snapshot in stw:prev:* is the last known-good copy; say so plainly rather than
  // leaving a silent corruption behind a green tick.
  if (!all) {
    return {
      verify,
      allMatch: false,
      writeFailed: true,
      message:
        "Read-back verification FAILED: what is stored is not what was sent. The pre-write snapshot is in stw:prev:*. Use ?action=restore before writing again.",
    };
  }
  return { verify, allMatch: all };
}

async function bumpMeta(changedChecksums, action, summary) {
  const [mRaw] = await redis([["GET", "stw:meta"]]);
  const meta = mRaw ? JSON.parse(mRaw) : {};
  meta.checksums = Object.assign({}, meta.checksums, changedChecksums);
  meta.updatedAt = new Date().toISOString();
  meta.rev = (meta.rev || 1) + 1;
  meta.lastWrite = { action, at: meta.updatedAt, summary };
  await redis([["SET", "stw:meta", JSON.stringify(meta)]]);
  return meta;
}

function nextRow(arr) {
  return arr.reduce((m, r) => Math.max(m, num(r.xlRow)), 0) + 1;
}

// ---- leg validation ----
// LEDGERS. "void" was added 17/07/2026: the vault could ADD legs and AMEND them, but had
// no way to say "this row should never have existed". When the Clerk misread a receipt and
// re-logged four already-settled 15/07 tickets as fresh 16/07 legs, the only options were
// to leave $67.80 of fiction in the book or hand-edit Redis behind the audit trail. Voiding
// is the honest third way: the row STAYS, keeps its history, and stops counting. Nothing is
// ever deleted from this journal — the record of a mistake is part of the record.
const LEDGERS = { model: "Model", exotic: "Exotic", misclick: "Misclick", refund: "Refund", void: "Void" };
const RESULTS = { win: "Win", place: "Place", lose: "Lose", refund: "Refund", pending: "Pending" };

// Normalise whatever the vision model returns for a row's transaction date into the
// journal's DD/MM/YYYY. The prompt asks for DD/MM/YYYY, but the SGPools page prints
// "15 Jul 2026 08:11 AM", so the model sometimes echoes that shape instead. Accept
// both rather than discarding a date we can plainly read.
//
// Returns null on anything not confidently parseable — a WRONG date is far worse
// than a missing one, because a missing one falls back to today and warns, while a
// wrong one files a bet on a day it was never placed and says nothing.
const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const normDate = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // DD/MM/YYYY or DD-MM-YYYY
  let m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s);
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return String(d).padStart(2, "0") + "/" + String(mo).padStart(2, "0") + "/" + y;
  }
  // "15 Jul 2026" / "15 July 2026 08:11 AM"
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/.exec(s);
  if (m) {
    const d = +m[1], mo = MONTHS[m[2].slice(0, 3).toLowerCase()], y = +m[3];
    if (!mo || d < 1 || d > 31) return null;
    return String(d).padStart(2, "0") + "/" + String(mo).padStart(2, "0") + "/" + y;
  }
  // "2026-07-15"
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return String(d).padStart(2, "0") + "/" + String(mo).padStart(2, "0") + "/" + y;
  }
  return null;
};

// SGPools receipts are a fixed 8 characters. A 9-character receipt is the signature
// of the OCR carrying a prefix down from the row above in a dense column — it looks
// plausible, matches no ticket, and then falls through to the coordinate matcher.
// Catch it at the door instead.
const RECEIPT_LEN = 8;
const receiptLooksWrong = (r) => !!r && r.length !== RECEIPT_LEN;

const KNOWN_TYPES = ["WIN", "PLA", "TRIO", "FORECAST", "PLACE FORECAST", "TIERCE", "QUARTET"];
const KNOWN_CONF = ["High", "Medium-High", "Medium", "Low-Med", "None", ""];

function validateLeg(raw, defaults, idx) {
  const errors = [];
  const notices = [];
  const leg = {};
  const date = String(raw.date || defaults.date || "").trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date))
    errors.push("leg " + idx + ": date must be dd/mm/yyyy, got '" + date + "'");
  leg.date = date;
  leg.meet = String(raw.meet || "").trim();
  if (!leg.meet) errors.push("leg " + idx + ": meet is required");
  const race = parseInt(raw.raceNo, 10);
  if (!isFinite(race) || race < 1)
    errors.push("leg " + idx + ": raceNo must be a positive number");
  leg.raceNo = race;
  leg.betType = String(raw.betType || "").trim().toUpperCase();
  if (!leg.betType) errors.push("leg " + idx + ": betType is required");
  else if (!KNOWN_TYPES.includes(leg.betType))
    notices.push("leg " + idx + ": unusual betType '" + leg.betType + "' accepted");
  const EXOTIC_TYPES = ["TRIO", "FORECAST", "PLACE FORECAST", "TIERCE", "QUARTET", "QUINELLA"];
  const legExotic = EXOTIC_TYPES.includes(leg.betType);
  leg.horseNo = raw.horseNo == null ? "" : String(raw.horseNo).trim();
  leg.combo = raw.combo == null ? "" : String(raw.combo).trim();
  // singles need a horse number; exotics need a combination instead
  if (legExotic) {
    if (!leg.combo && !leg.horseNo)
      errors.push("leg " + idx + ": exotic bet needs a combination (e.g. 4-5-9)");
  } else {
    if (!leg.horseNo) errors.push("leg " + idx + ": horseNo is required");
  }
  leg.horseName = raw.horseName == null ? "" : String(raw.horseName).trim();
  const stake = num(raw.stake);
  if (!(stake > 0)) errors.push("leg " + idx + ": stake must be > 0");
  leg.stake = r2(stake);
  leg.confidence = raw.confidence == null ? "" : String(raw.confidence).trim();
  if (leg.confidence === "Med-High") leg.confidence = "Medium-High";
  if (!KNOWN_CONF.includes(leg.confidence))
    notices.push("leg " + idx + ": new confidence label '" + leg.confidence + "' accepted");
  const led = String(raw.ledger || "Model").trim().toLowerCase();
  if (!LEDGERS[led]) errors.push("leg " + idx + ": ledger must be Model/Exotic/Misclick/Refund");
  else leg.ledger = LEDGERS[led];
  leg.reason = raw.reason == null ? "" : String(raw.reason);
  leg.notes = raw.notes == null ? "" : String(raw.notes);
  leg.result = "Pending";
  leg.position = null;
  leg.payout = null;
  leg.netPL = null;
  leg.walletBefore = raw.walletBefore == null ? null : r2(raw.walletBefore);
  leg.walletAfter = raw.walletAfter == null ? null : r2(raw.walletAfter);
  return { leg, errors, notices };
}

const SLICES = {
  betlog: "stw:betlog",
  daily: "stw:daily",
  notes: "stw:notes",
  running: "stw:running",
  formulas: "stw:formulas",
  ledger: "stw:ledger",
};

function parseBody(req) {
  try {
    return typeof req.body === "object" && req.body
      ? req.body
      : JSON.parse(req.body || "{}");
  } catch (e) {
    return {};
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    const action = (req.query.action || "status").toString();

    // Doctor: runs BEFORE the env guard so it can diagnose missing env too
    if (action === "diag") {
      const out = {
        now: new Date().toISOString(),
        node: process.version,
        env: {
          UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
          UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
          KV_REST_API_URL: !!process.env.KV_REST_API_URL,
          KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
          ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
          CLAUDE_API_KEY: !!process.env.CLAUDE_API_KEY,
        },
        seedBundle: { rows: seed.betLog.length, version: seed.meta.seedVersion },
      };
      if (!R_URL || !R_TOK) {
        out.redis = { ok: false, error: "No Redis credentials resolved from env" };
        return res.status(200).json(out);
      }
      try {
        const t0 = Date.now();
        const pong = await redis([["PING"]]);
        out.redis = { ok: pong[0] === "PONG", latencyMs: Date.now() - t0 };
      } catch (e) {
        out.redis = { ok: false, error: String(e.message || e) };
      }
      if (out.redis.ok) {
        const keys = [
          "stw:meta", "stw:betlog", "stw:daily", "stw:notes",
          "stw:running", "stw:formulas", "stw:prev:betlog",
        ];
        const ex = await redis(keys.map((k) => ["EXISTS", k]));
        out.keys = {};
        keys.forEach((k, i) => (out.keys[k] = !!ex[i]));
        const [mRaw] = await redis([["GET", "stw:meta"]]);
        if (mRaw) {
          const m = JSON.parse(mRaw);
          out.meta = {
            rev: m.rev || 1,
            updatedAt: m.updatedAt || m.importedAt,
            lastWrite: m.lastWrite || null,
          };
        }
      }
      return res.status(200).json(out);
    }

    if (!R_URL || !R_TOK)
      return res.status(500).json({
        error:
          "Redis env vars missing (UPSTASH_REDIS_REST_URL / _TOKEN or KV_REST_API_URL / _TOKEN)",
      });

    // -------------------- PHASE 1: read side --------------------
    if (action === "status") {
      const [metaRaw] = await redis([["GET", "stw:meta"]]);
      const meta = metaRaw ? JSON.parse(metaRaw) : null;
      return res.status(200).json({
        seeded: !!meta,
        meta,
        seedPreview: {
          seedVersion: seed.meta.seedVersion,
          source: seed.meta.source,
          betLogRows: seed.betLog.length,
          dailyRows: seed.dailySummary.length,
          noteRows: seed.modelNotes.length,
        },
      });
    }

    if (action === "import") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required for import" });
      const body = parseBody(req);
      const [existing] = await redis([["EXISTS", "stw:meta"]]);
      if (existing && !body.force)
        return res.status(409).json({
          error:
            'Vault already seeded. Send {"force":true} to overwrite (raw v52 reseed).',
        });

      const payloads = {
        "stw:betlog": JSON.stringify(seed.betLog),
        "stw:daily": JSON.stringify(seed.dailySummary),
        "stw:notes": JSON.stringify(seed.modelNotes),
        "stw:running": JSON.stringify(seed.runningTotals),
        "stw:formulas": JSON.stringify(seed.dailySummaryFormulas),
      };
      const checksums = {};
      for (const k in payloads) checksums[k] = sha(payloads[k]);
      const meta = {
        seedVersion: seed.meta.seedVersion,
        source: seed.meta.source,
        importedAt: new Date().toISOString(),
        rev: 1,
        checksums,
      };
      const cmds = Object.entries(payloads).map(([k, v]) => ["SET", k, v]);
      cmds.push(["SET", "stw:meta", JSON.stringify(meta)]);
      await redis(cmds);

      const keys = Object.keys(payloads);
      const back = await redis(keys.map((k) => ["GET", k]));
      const verify = {};
      keys.forEach((k, i) => {
        verify[k] = {
          sent: checksums[k],
          stored: back[i] == null ? null : sha(back[i]),
          match: back[i] != null && sha(back[i]) === checksums[k],
        };
      });
      const storedLog = JSON.parse(back[keys.indexOf("stw:betlog")]);
      const audit = computeAudit(storedLog);
      const allMatch = Object.values(verify).every((v) => v.match);
      return res.status(200).json({
        ok: allMatch,
        weighedIn:
          allMatch && !audit.flags.some((f) => f.startsWith("OBJECTION")),
        meta,
        verify,
        audit,
      });
    }

    if (action === "state") {
      const slice = (req.query.slice || "all").toString();
      if (slice === "all") {
        const keys = Object.values(SLICES);
        const vals = await redis(keys.map((k) => ["GET", k]));
        const out = {};
        Object.keys(SLICES).forEach((name, i) => {
          out[name] = vals[i] ? JSON.parse(vals[i]) : null;
        });
        if (!out.betlog)
          return res.status(404).json({ error: "Vault not seeded yet" });
        return res.status(200).json(out);
      }
      const key = SLICES[slice];
      if (!key) return res.status(400).json({ error: "Unknown slice" });
      const [v] = await redis([["GET", key]]);
      if (v == null)
        return res.status(404).json({ error: "Vault not seeded yet" });
      return res.status(200).json({ [slice]: JSON.parse(v) });
    }

    if (action === "ruledecay") {
      const [logRaw] = await redis([["GET", "stw:betlog"]]);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const decay = computeRuleDecay(
        JSON.parse(logRaw),
        (req.query && req.query.since) || "26/06/2026"
      );
      return res.status(200).json(decay);
    }

    if (action === "audit") {
      const [metaRaw, logRaw] = await redis([
        ["GET", "stw:meta"],
        ["GET", "stw:betlog"],
      ]);
      if (!metaRaw || !logRaw)
        return res.status(404).json({ error: "Vault not seeded yet" });
      const meta = JSON.parse(metaRaw);
      const checksumNow = sha(logRaw);
      const checksumOk = checksumNow === meta.checksums["stw:betlog"];
      const audit = computeAudit(JSON.parse(logRaw));
      const objections = audit.flags.filter((f) => f.startsWith("OBJECTION"));
      return res.status(200).json({
        weighedIn: checksumOk && objections.length === 0,
        checksum: {
          stored: meta.checksums["stw:betlog"],
          now: checksumNow,
          match: checksumOk,
        },
        importedAt: meta.importedAt,
        updatedAt: meta.updatedAt || meta.importedAt,
        rev: meta.rev || 1,
        lastWrite: meta.lastWrite || null,
        seedVersion: meta.seedVersion,
        audit,
      });
    }

    // -------------------- PHASE 2: the quill --------------------
    if (action === "addlegs") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      let legsIn = Array.isArray(body) ? body : body.legs;
      if (!Array.isArray(legsIn) || !legsIn.length)
        return res.status(400).json({ error: "Provide legs as a non-empty array" });
      if (legsIn.length > 60)
        return res.status(400).json({ error: "Max 60 legs per commit" });

      const [logRaw] = await redis([["GET", "stw:betlog"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expBetlog = logRaw == null ? null : sha(logRaw);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);

      const defaults = { date: body.date };
      const allErrors = [];
      const allNotices = [];
      const clean = [];
      legsIn.forEach((raw, i) => {
        const { leg, errors, notices } = validateLeg(raw, defaults, i + 1);
        allErrors.push(...errors);
        allNotices.push(...notices);
        clean.push(leg);
      });
      if (allErrors.length)
        return res
          .status(422)
          .json({ error: "Validation failed, nothing written", errors: allErrors });

      let next = nextRow(log);
      clean.forEach((l) => (l.xlRow = next++));
      const newLog = log.concat(clean);
      const str = JSON.stringify(newLog);
      const _w = await writeVerified({ "stw:betlog": str }, { "stw:betlog": _expBetlog });
      // A concurrent writer moved the data under us, or the read-back failed.
      // Either way NOTHING should be reported as ok: fail loudly (409) so the caller
      // re-reads rather than assuming the write landed.
      if (_w.conflict) return res.status(409).json({ error: _w.message, conflicts: _w.conflicts, retry: true });
      if (_w.writeFailed) return res.status(500).json({ error: _w.message, verify: _w.verify });
      const { verify, allMatch } = _w;
      const meta = await bumpMeta(
        { "stw:betlog": sha(str) },
        "addlegs",
        clean.length + " legs (" + clean.map((l) => l.date).filter((v, i, a) => a.indexOf(v) === i).join(", ") + ")"
      );
      return res.status(200).json({
        ok: allMatch,
        added: clean.map((l) => ({
          xlRow: l.xlRow, date: l.date, meet: l.meet, raceNo: l.raceNo,
          horseNo: l.horseNo, betType: l.betType, stake: l.stake,
        })),
        notices: allNotices,
        verify,
        rev: meta.rev,
        audit: computeAudit(newLog),
      });
    }

    if (action === "voidlegs") {
      // Retire a bet-log row that should never have been written: a duplicate, a misread,
      // a leg logged against the wrong day. The row is NOT deleted — it moves to the Void
      // ledger, keeps every field it had, and gains a stamped reason. computeAudit only
      // counts ledger==="model", so a voided row stops affecting P/L, ROI, bands and the
      // rule-decay audit the moment it is voided, while remaining fully inspectable.
      //
      // Why this exists: on 16/07 the Clerk misread four receipts (an OCR column-bleed
      // spliced an extra digit into 559894C6 and friends), the receipt match therefore
      // missed, the coordinate fallback matched already-settled 15/07 legs, and four
      // phantom legs entered the book carrying $108 of payout that had already been
      // counted. The vault had no way to remove them. It does now.
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const why = String(body.why || "").trim();
      if (!rows.length)
        return res.status(400).json({ error: "Provide rows as a non-empty array of { xlRow, reason }" });
      if (!why)
        return res.status(422).json({ error: "why is required: voiding a leg is a decision and must carry its reason" });

      const [logRaw] = await redis([["GET", "stw:betlog"]]);
      const _expBetlog = logRaw == null ? null : sha(logRaw);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const byRow = {};
      log.forEach((r) => (byRow[r.xlRow] = r));

      const errors = [];
      const voided = [];
      for (const v of rows) {
        const row = byRow[v.xlRow];
        if (!row) { errors.push("xlRow " + v.xlRow + " not found"); continue; }
        if (String(row.ledger || "").trim().toLowerCase() === "void") {
          errors.push("xlRow " + v.xlRow + " is already void");
          continue;
        }
        row.voidHistory = row.voidHistory || [];
        row.voidHistory.push({
          at: new Date().toISOString(),
          from: { ledger: row.ledger, result: row.result, payout: row.payout, netPL: row.netPL },
          reason: String(v.reason || why).slice(0, 500),
        });
        // keep what it WAS, so a void can be reasoned about (or undone) later
        if (row.ledgerBeforeVoid == null) row.ledgerBeforeVoid = row.ledger;
        row.ledger = LEDGERS.void;
        row.notes = (row.notes ? row.notes + "; " : "") + "VOIDED: " + String(v.reason || why).slice(0, 200);
        voided.push({ xlRow: v.xlRow, was: row.ledgerBeforeVoid, reason: String(v.reason || why).slice(0, 200) });
      }
      if (!voided.length)
        return res.status(422).json({ error: "Nothing voided", errors });

      const str = JSON.stringify(log);
      const { verify, allMatch } = await writeVerified(
        { "stw:betlog": str },
        { "stw:betlog": _expBetlog }
      );
      if (!allMatch)
        return res.status(409).json({ error: "Write refused: the bet log changed while this void was being prepared. Reload and try again.", verify });
      const meta = await bumpMeta({ "stw:betlog": sha(str) }, "voidlegs", voided.length + " leg(s) voided");

      // A void is a DECISION about the record, so it belongs in the decision ledger too,
      // not only stamped on the rows. Written best-effort AFTER the betlog write has been
      // verified: if this append fails the void still stands, and the row-level
      // voidHistory remains the primary audit trail.
      let ledgerSeq = null;
      try {
        const [lraw] = await redis([["GET", "stw:ledger"]]);
        const entries = lraw ? JSON.parse(lraw) : [];
        const seq = entries.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
        entries.push({
          seq,
          at: new Date().toISOString(),
          kind: "correction",
          change: voided.length + " leg(s) voided: " + voided.map((v) => "row " + v.xlRow).join(", "),
          why,
          before: "",
          after: "",
          author: "you",
          correctsSeq: null,
        });
        const lstr = JSON.stringify(entries.slice(-400));
        await redis([["SET", "stw:ledger", lstr]]);
        await bumpMeta({ "stw:ledger": sha(lstr) }, "voidlegs", "ledger note for " + voided.length + " void(s)");
        ledgerSeq = seq;
      } catch (e) {
        // non-fatal: the void itself is already committed and stamped on the rows
      }
      return res.status(200).json({ ok: true, voided, errors, verify, rev: meta.rev, ledgerSeq });
    }

    if (action === "settle") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const setts = body.settlements;
      if (!Array.isArray(setts) || !setts.length)
        return res.status(400).json({ error: "Provide settlements as a non-empty array" });

      const [logRaw] = await redis([["GET", "stw:betlog"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expBetlog = logRaw == null ? null : sha(logRaw);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const byRow = {};
      log.forEach((r) => (byRow[r.xlRow] = r));

      const errors = [];
      const applied = [];
      for (const s of setts) {
        const row = byRow[s.xlRow];
        if (!row) { errors.push("xlRow " + s.xlRow + " not found"); continue; }
        const cur = normResult(row.result);
        if (cur !== "pending" && !s.amend) {
          errors.push("xlRow " + s.xlRow + " is already '" + row.result + "' (send amend:true to change)");
          continue;
        }
        const resKey = String(s.result || "").trim().toLowerCase();
        if (!RESULTS[resKey] || resKey === "pending") {
          errors.push("xlRow " + s.xlRow + ": result must be Win/Place/Lose/Refund");
          continue;
        }
        applied.push({ row, s, resKey });
      }
      if (errors.length)
        return res
          .status(422)
          .json({ error: "Validation failed, nothing written", errors });

      for (const { row, s, resKey } of applied) {
        // AUDIT TRAIL: an already-settled leg can only be changed via amend:true (guarded
        // in the validation loop above — that part was already right). What was missing is
        // any RECORD of the change: the old result, payout and P/L were overwritten in
        // place, leaving no way to tell a considered correction from a fat-finger. A
        // settled leg is history, so an amendment is now stamped and kept.
        const wasSettled = row.result && normResult(row.result) !== "pending";
        row.settleHistory = row.settleHistory || [];
        if (wasSettled) {
          row.settleHistory.push({
            at: new Date().toISOString(),
            from: { result: row.result, payout: row.payout, netPL: row.netPL, ledger: row.ledger },
            reason: s.resettleReason || "(no reason given)",
          });
          row.settleHistory = row.settleHistory.slice(-10);
        }
        // remember the ledger the leg was placed under, so a refund can be undone
        if (row.ledgerBeforeSettle == null) row.ledgerBeforeSettle = row.ledger;
        row.result = RESULTS[resKey];
        row.settledAt = new Date().toISOString();
        row.resettled = wasSettled ? (num(row.resettled) || 0) + 1 : (row.resettled || 0);
        // backfill the receipt into notes if provided and not already present
        if (s.receipt) {
          const rec = String(s.receipt).toUpperCase().replace(/[^0-9A-Z]/g, "");
          if (rec && !/receipt\s+[0-9A-Z]/i.test(String(row.notes || ""))) {
            row.notes = (row.notes ? String(row.notes) + " " : "") +
              "receipt " + rec + " (backfilled at settlement)";
          }
        }
        if (s.position != null && String(s.position).trim() !== "")
          row.position = isFinite(parseInt(s.position, 10))
            ? parseInt(s.position, 10)
            : String(s.position).trim();
        if (resKey === "refund") {
          row.payout = r2(row.stake);
          row.netPL = 0;
          row.ledger = "Refund"; // journal convention: refunds leave the model ledger
        } else {
          // Moving to Refund used to be a ONE-WAY DOOR: the ledger tag was overwritten and
          // never restored, so a leg mistakenly refunded stayed out of the Model ledger
          // forever, quietly shrinking the denominator every calibration figure rests on.
          if (row.ledger === "Refund" && row.ledgerBeforeSettle && row.ledgerBeforeSettle !== "Refund") {
            row.ledger = row.ledgerBeforeSettle;
          }
          if (resKey === "lose") {
            row.payout = r2(s.payout || 0);
            row.netPL = r2(row.payout - num(row.stake));
          } else {
            const p = num(s.payout);
            if (!(p >= 0)) {
              return res.status(422).json({
                error: "xlRow " + s.xlRow + ": payout required for " + RESULTS[resKey],
              });
            }
            row.payout = r2(p);
            row.netPL = r2(p - num(row.stake));
          }
        }
      }

      const str = JSON.stringify(log);
      const _w = await writeVerified({ "stw:betlog": str }, { "stw:betlog": _expBetlog });
      // A concurrent writer moved the data under us, or the read-back failed.
      // Either way NOTHING should be reported as ok: fail loudly (409) so the caller
      // re-reads rather than assuming the write landed.
      if (_w.conflict) return res.status(409).json({ error: _w.message, conflicts: _w.conflicts, retry: true });
      if (_w.writeFailed) return res.status(500).json({ error: _w.message, verify: _w.verify });
      const { verify, allMatch } = _w;
      const meta = await bumpMeta(
        { "stw:betlog": sha(str) },
        "settle",
        applied.length + " legs settled"
      );
      return res.status(200).json({
        ok: allMatch,
        settled: applied.map(({ row }) => ({
          xlRow: row.xlRow, date: row.date, meet: row.meet, raceNo: row.raceNo,
          horseNo: row.horseNo, betType: row.betType, result: row.result,
          payout: row.payout, netPL: row.netPL,
        })),
        verify,
        rev: meta.rev,
        audit: computeAudit(log),
      });
    }

    if (action === "dailyupsert") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const date = String(body.date || "").trim();
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date))
        return res.status(422).json({ error: "date must be dd/mm/yyyy" });
      const [dRaw] = await redis([["GET", "stw:daily"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expDaily = dRaw == null ? null : sha(dRaw);
      if (!dRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const daily = JSON.parse(dRaw);
      let row = daily.find((r) => r.date === date);
      let mode = "updated";
      if (!row) {
        row = { xlRow: nextRow(daily), date };
        daily.push(row);
        mode = "created";
      }
      for (const k of ["meets", "bestBet", "worstBet", "lessons"]) {
        if (body[k] != null && String(body[k]).trim() !== "") row[k] = String(body[k]);
      }
      if (body.openingWallet != null && body.openingWallet !== "")
        row.openingWallet = r2(body.openingWallet);
      const str = JSON.stringify(daily);
      const _w = await writeVerified({ "stw:daily": str }, { "stw:daily": _expDaily });
      // A concurrent writer moved the data under us, or the read-back failed.
      // Either way NOTHING should be reported as ok: fail loudly (409) so the caller
      // re-reads rather than assuming the write landed.
      if (_w.conflict) return res.status(409).json({ error: _w.message, conflicts: _w.conflicts, retry: true });
      if (_w.writeFailed) return res.status(500).json({ error: _w.message, verify: _w.verify });
      const { verify, allMatch } = _w;
      const meta = await bumpMeta(
        { "stw:daily": sha(str) },
        "dailyupsert",
        mode + " " + date
      );
      return res.status(200).json({ ok: allMatch, mode, date, verify, rev: meta.rev });
    }

    if (action === "addnote") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const text = String(body.text || "").trim();
      if (!text) return res.status(422).json({ error: "text is required" });
      if (text.length > 20000)
        return res.status(422).json({ error: "note too long" });
      const [nRaw] = await redis([["GET", "stw:notes"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expNotes = nRaw == null ? null : sha(nRaw);
      if (!nRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const notes = JSON.parse(nRaw);
      notes.push({ xlRow: nextRow(notes), cols: [text] });
      const str = JSON.stringify(notes);
      const _w = await writeVerified({ "stw:notes": str }, { "stw:notes": _expNotes });
      // A concurrent writer moved the data under us, or the read-back failed.
      // Either way NOTHING should be reported as ok: fail loudly (409) so the caller
      // re-reads rather than assuming the write landed.
      if (_w.conflict) return res.status(409).json({ error: _w.message, conflicts: _w.conflicts, retry: true });
      if (_w.writeFailed) return res.status(500).json({ error: _w.message, verify: _w.verify });
      const { verify, allMatch } = _w;
      const meta = await bumpMeta(
        { "stw:notes": sha(str) },
        "addnote",
        text.slice(0, 60)
      );
      return res.status(200).json({ ok: allMatch, verify, rev: meta.rev, noteCount: notes.length });
    }

    // -------------------- THE MODEL LEDGER (append-only bench-book) --------------------
    // Records every change to the model, newest-first when read. There is deliberately
    // NO erase or restore path: a mistake is corrected by appending a correcting entry
    // that references the one it amends (the Pacioli principle), never by scrubbing.
    if (action === "ledger") {
      const [raw] = await redis([["GET", "stw:ledger"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expLedger = raw == null ? null : sha(raw);
      const entries = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ entries, count: entries.length });
    }

    if (action === "ledgeradd") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const change = String(body.change || "").trim();
      const why = String(body.why || "").trim();
      if (!change)
        return res.status(422).json({ error: "change is required (what changed)" });
      if (change.length > 4000 || why.length > 4000)
        return res.status(422).json({ error: "entry too long" });
      const author = body.author === "approved" ? "approved" : "you";
      const before = body.before == null ? "" : String(body.before).slice(0, 2000);
      const after = body.after == null ? "" : String(body.after).slice(0, 2000);
      const kind = ["rule", "amendment", "trial", "observation", "correction"].includes(
        String(body.kind)
      )
        ? String(body.kind)
        : "amendment";

      const [raw] = await redis([["GET", "stw:ledger"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expLedger = raw == null ? null : sha(raw);
      const entries = raw ? JSON.parse(raw) : [];
      const seq = entries.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
      const entry = {
        seq,
        at: new Date().toISOString(),
        kind,
        change,
        why,
        before,
        after,
        author,
        correctsSeq: null,
      };
      entries.push(entry);
      const str = JSON.stringify(entries);
      const _w = await writeVerified({ "stw:ledger": str }, { "stw:ledger": _expLedger });
      // A concurrent writer moved the data under us, or the read-back failed.
      // Either way NOTHING should be reported as ok: fail loudly (409) so the caller
      // re-reads rather than assuming the write landed.
      if (_w.conflict) return res.status(409).json({ error: _w.message, conflicts: _w.conflicts, retry: true });
      if (_w.writeFailed) return res.status(500).json({ error: _w.message, verify: _w.verify });
      const { verify, allMatch } = _w;
      const meta = await bumpMeta(
        { "stw:ledger": sha(str) },
        "ledgeradd",
        "#" + seq + " " + kind + ": " + change.slice(0, 50)
      );
      return res.status(200).json({
        ok: allMatch,
        entry,
        verify,
        rev: meta.rev,
        count: entries.length,
      });
    }

    if (action === "ledgercorrect") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const correctsSeq = parseInt(body.correctsSeq, 10);
      const change = String(body.change || "").trim();
      const why = String(body.why || "").trim();
      if (!isFinite(correctsSeq))
        return res.status(422).json({ error: "correctsSeq is required" });
      if (!change)
        return res
          .status(422)
          .json({ error: "change is required (the correction text)" });
      if (change.length > 4000 || why.length > 4000)
        return res.status(422).json({ error: "entry too long" });
      const [raw] = await redis([["GET", "stw:ledger"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expLedger = raw == null ? null : sha(raw);
      const entries = raw ? JSON.parse(raw) : [];
      const target = entries.find((e) => e.seq === correctsSeq);
      if (!target)
        return res
          .status(404)
          .json({ error: "No ledger entry #" + correctsSeq + " to correct" });
      const seq = entries.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
      const entry = {
        seq,
        at: new Date().toISOString(),
        kind: "correction",
        change,
        why: why || "Correction to entry #" + correctsSeq,
        before: "",
        after: "",
        author: "you",
        correctsSeq,
      };
      entries.push(entry);
      const str = JSON.stringify(entries);
      const _w = await writeVerified({ "stw:ledger": str }, { "stw:ledger": _expLedger });
      // A concurrent writer moved the data under us, or the read-back failed.
      // Either way NOTHING should be reported as ok: fail loudly (409) so the caller
      // re-reads rather than assuming the write landed.
      if (_w.conflict) return res.status(409).json({ error: _w.message, conflicts: _w.conflicts, retry: true });
      if (_w.writeFailed) return res.status(500).json({ error: _w.message, verify: _w.verify });
      const { verify, allMatch } = _w;
      const meta = await bumpMeta(
        { "stw:ledger": sha(str) },
        "ledgercorrect",
        "#" + seq + " corrects #" + correctsSeq
      );
      return res.status(200).json({
        ok: allMatch,
        entry,
        verify,
        rev: meta.rev,
        count: entries.length,
      });
    }

    if (action === "restore") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const slice = String(body.slice || "");
      if (!["betlog", "daily", "notes"].includes(slice))
        return res.status(400).json({ error: "slice must be betlog, daily or notes" });
      const prevKey = "stw:prev:" + slice;
      const [prev] = await redis([["GET", prevKey]]);
      if (prev == null)
        return res.status(404).json({ error: "No pre-write snapshot exists for " + slice });
      await redis([["SET", "stw:" + slice, prev]]);
      const meta = await bumpMeta(
        { ["stw:" + slice]: sha(prev) },
        "restore",
        "rolled " + slice + " back to pre-write snapshot"
      );
      const out = { ok: true, restored: slice, rev: meta.rev };
      if (slice === "betlog") out.audit = computeAudit(JSON.parse(prev));
      return res.status(200).json(out);
    }

    if (action === "reconcile") {
      // The Clerk of the Scales: read SGPools transaction-history images (and the
      // wallet overview) via Claude vision, match receipts against pending legs,
      // and PROPOSE settlements. Never writes the bet log; commit stays with the user.
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const AK =
        process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
      if (!AK)
        return res.status(500).json({
          error:
            "ANTHROPIC_API_KEY missing in Vercel env (the Terminal's vision key)",
        });
      const body = parseBody(req);
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length || images.length > 8)
        return res.status(400).json({ error: "Provide 1-8 images" });
      const totalB64 = images.reduce(
        (a, im) => a + String(im.data || "").length, 0);
      if (totalB64 > 4200000)
        return res.status(413).json({
          error: "Images too large after compression, send fewer pages per batch",
        });

      const [logRaw] = await redis([["GET", "stw:betlog"]]);
      // capture what we READ, so the write can be refused if it moved under us
      const _expBetlog = logRaw == null ? null : sha(logRaw);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const rxRec = /receipt\s+([0-9A-Z]+)/i;
      const receiptOf = (b) => {
        const m = rxRec.exec(String(b.notes || ""));
        return m ? m[1].toUpperCase() : null;
      };
      // A voided leg is not a live bet, so it must never be offered for settlement —
      // otherwise a row retired as a duplicate would keep asking to be settled forever.
      const pending = log.filter(
        (b) => normResult(b.result) === "pending" && String(b.ledger || "").trim().toLowerCase() !== "void"
      );
      const allReceipts = {};
      log.forEach((b) => {
        const r = receiptOf(b);
        if (r) allReceipts[r] = b;
      });

      const prompt =
        "These images are Singapore Pools account documents: transaction-history pages and possibly an account-overview screen. " +
        "Extract EVERY table row whose TYPE is Horse Wagering (ignore Football, Sports and Lottery rows, but count how many you skipped). " +
        "For each horse row read: the receipt number from the STATUS / RECEIPT NO column (letters and digits only, e.g. 557A0429), " +
        "the SELECTION text (e.g. U1 UK9 PLA 1), the AMOUNT staked in dollars, the STATUS word (Settled, Pending, Refunded etc.), " +
        "the PAYOUT / WINNINGS in dollars, and the DRAW/EVENT date. " +
        "If an image is an account overview, also read the large account balance figure and the Open Bets amounts for Horse Racing, Sports and Lottery. " +
        "CRITICAL OUTPUT RULE: your entire reply must be ONE minified JSON object and NOTHING else. Do not explain your reasoning, do not count rows out loud, do not write a preamble or a closing remark, do not use markdown fences. The first character you emit must be { and the last must be }. Any prose outside the JSON breaks the tool. Exactly this shape: " +
        '{"wallet":{"balance":0,"horseOpen":0,"sportsOpen":0,"lotteryOpen":0} or null,' +
        '"skippedNonHorse":0,' +
        '"rows":[{"receipt":"","selection":"","amount":0,"status":"","payout":0,"eventDate":""}]} ' +
        "Numbers must be plain numbers without $ signs. Include every horse row you can read, even partially; if a field is unreadable use null.";

      const content = images.map((im) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: im.media_type || "image/jpeg",
          data: im.data,
        },
      }));
      content.push({ type: "text", text: prompt });

      const cr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": AK,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          // NO ASSISTANT PREFILL. Seeding the reply with "{" would make a prose preamble
          // structurally impossible, and it is the standard trick for forcing JSON — but
          // this model rejects it outright: HTTP 400 "This model does not support assistant
          // message prefill. The conversation must end with a user message." Every intake
          // and reconcile died on that until it was removed. The defence against preamble
          // is therefore the CRITICAL OUTPUT RULE in the prompt plus the salvaging
          // extractJson() parser, which is why that parser must stay tolerant.
          messages: [{ role: "user", content }],
        }),
      });
      if (!cr.ok) {
        const t = await cr.text();
        return res.status(502).json({
          error: "Claude vision HTTP " + cr.status + ": " + t.slice(0, 180),
        });
      }
      const cj = await cr.json();
      const text = (cj.content || [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      let parsed;
      try {
        parsed = parseVisionReply(text);
      } catch (e) {
        return res.status(502).json({ error: String(e.message || e) });
      }
      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      const byReceipt = {};
      rows.forEach((r) => {
        if (r && r.receipt)
          byReceipt[String(r.receipt).toUpperCase().replace(/[^0-9A-Z]/g, "")] = r;
      });

      // --- coordinate fallback: for legs with no stored receipt, match on the bet's
      // natural identity. Singles key on race+horse+type; exotics key on race+combo+type.
      // Single selection: "U1 UK9 PLA 1"  ->  units, MEETcode+race, type, horseNo
      // Exotic selection:  "U5 SA7 TRO 4-5-9/4-5-9/4-5-9"  ->  units, MEETcode+race, type, combo
      const selRxSingle = /^U?\d*\s*([A-Z]{2,3})(\d+)\s+(WIN|PLA|W|P|PLC|PLACE|WP)\s+(\d+)\b/i;
      const selRxExotic = /^U?\d*\s*([A-Z]{2,3})(\d+)\s+(TRO|TRIO|FC|FORECAST|QUARTET|QUAD|QT|QUINELLA|QN|TIERCE)\s+([\d\-\/]+)/i;
      const codeToCountry = (code) => {
        const c = String(code || "").toUpperCase().replace(/\d+$/, "");
        if (c === "UK") return "united kingdom";
        if (c === "SA") return "south africa";
        if (c === "FR") return "france";
        if (c === "AU") return "australia";
        if (c === "MB" || c === "MEL" || c === "MW") return "australia"; // AU state meets
        if (c === "US" || c === "USA") return "united states";
        if (c === "HK") return "hong kong";
        if (c === "JP") return "japan";
        if (c === "NZ") return "new zealand";
        return c.toLowerCase();
      };
      const normType = (t) => {
        const s = String(t || "").toUpperCase();
        if (s.startsWith("W")) return "WIN";
        if (s.startsWith("PLA") || s === "P" || s === "PLC" || s.startsWith("PLACE")) return "PLA";
        if (s.startsWith("TR")) return "TRIO";
        if (s.startsWith("FC") || s.startsWith("FORE")) return "FORECAST";
        if (s.startsWith("QUA") || s === "QT" || s === "QUAD") return "QUARTET";
        if (s.startsWith("QUI") || s === "QN") return "QUINELLA";
        if (s.startsWith("TIE")) return "TIERCE";
        return s;
      };
      const EXOTIC_SET = new Set(["TRIO", "FORECAST", "QUARTET", "QUINELLA", "TIERCE"]);
      const isExoticType = (t) => EXOTIC_SET.has(normType(t));
      const normCombo = (c) => String(c || "").replace(/\s/g, "");
      // singles: race+horse+type. exotics: race+combo+type. country prefix disambiguates.
      const coordKey = (country, raceNo, ident, type) =>
        [country, String(raceNo).trim(), isExoticType(type) ? "combo:" + normCombo(ident) : String(ident).trim(), normType(type)].join("|");

      // index the parsed receipt rows by coordinate, derived from their selection text
      const byCoord = {};
      rows.forEach((r) => {
        const sel = String(r.selection || "").trim();
        let country, race, ident, type;
        const me = selRxExotic.exec(sel);
        if (me) {
          country = codeToCountry(me[1]); race = me[2]; type = me[3]; ident = me[4];
        } else {
          const ms = selRxSingle.exec(sel);
          if (!ms) return;
          country = codeToCountry(ms[1]); race = ms[2]; type = ms[3]; ident = ms[4];
        }
        const key = coordKey(country, race, ident, type);
        if (!byCoord[key]) byCoord[key] = { row: r, code: (me ? me[1] : selRxSingle.exec(sel)[1]).toUpperCase() };
      });
      // which country does a leg's stored meet name belong to
      const legCountry = (meet) => {
        const s = String(meet || "").toLowerCase();
        if (s.includes("united kingdom") || s.includes("uk") || s.includes("ireland")) return "united kingdom";
        if (s.includes("south africa")) return "south africa";
        if (s.includes("france")) return "france";
        if (s.includes("australia")) return "australia";
        if (s.includes("united states") || s.includes("usa")) return "united states";
        if (s.includes("hong kong")) return "hong kong";
        if (s.includes("japan")) return "japan";
        if (s.includes("new zealand")) return "new zealand";
        return s.split(/[\s(]/)[0];
      };
      // find a receipt row for a leg by its coordinates; returns {row, code} or null
      const rowByCoord = (leg) => {
        // exotics identify by combo, singles by horse number
        const ident = isExoticType(leg.betType)
          ? (leg.combo || "") : leg.horseNo;
        const key = coordKey(legCountry(leg.meet), leg.raceNo, ident, leg.betType);
        return byCoord[key] || null;
      };

      const sibWinRow = (leg) => {
        const sib = log.find(
          (b) =>
            b !== leg &&
            b.date === leg.date &&
            String(b.meet) === String(leg.meet) &&
            String(b.raceNo) === String(leg.raceNo) &&
            String(b.horseNo) === String(leg.horseNo) &&
            String(b.betType).trim() === "WIN"
        );
        if (!sib) return null;
        let rec = receiptOf(sib);
        if (rec && byReceipt[rec]) return byReceipt[rec];
        // fallback: sibling WIN row by coordinate
        const c = rowByCoord(sib);
        return c ? c.row : null;
      };

      const proposal = [];
      const untouched = [];
      let coordMatched = 0;
      for (const leg of pending) {
        const rec = receiptOf(leg);
        let row = rec ? byReceipt[rec] : null;
        let matchedReceipt = rec;
        let matchedBy = row ? "receipt" : null;
        // FALLBACK: no stored receipt (or it didn't match) -> match on coordinates.
        // GUARDED BY DATE. coordKey is [country|race|horse|type] with no date in it, which
        // is exactly how four 15/07 receipt rows settled four 16/07 pending legs: same
        // course, same race, same horse, same bet type, different day, and nothing checked.
        // A receipt row may only settle a leg placed on the SAME day as its transaction.
        if (!row) {
          const c = rowByCoord(leg);
          const cDate = c && c.row ? normDate(c.row.txnDate) : null;
          const dateClash = !!(cDate && leg.date && cDate !== String(leg.date).trim());
          if (c && dateClash) {
            untouched.push({
              xlRow: leg.xlRow, receipt: rec,
              label: leg.date + " R" + leg.raceNo + " #" + leg.horseNo + " " + leg.betType,
              note: "a receipt row with the same race/horse was found but it is dated " + cDate +
                    ", not " + leg.date + ". Left open rather than settling this leg from another day's ticket.",
            });
            continue;
          }
          if (c) {
            row = c.row;
            matchedBy = "coordinate";
            coordMatched++;
            // backfill the real receipt from the matched row, so the leg becomes receipt-backed
            if (c.row.receipt)
              matchedReceipt = String(c.row.receipt).toUpperCase().replace(/[^0-9A-Z]/g, "");
          }
        }
        if (!row) {
          untouched.push({
            xlRow: leg.xlRow, receipt: rec,
            label: leg.date + " R" + leg.raceNo + " " +
              (isExoticType(leg.betType)
                ? leg.betType + " " + (leg.combo || "")
                : "#" + leg.horseNo + " " + leg.betType),
          });
          continue;
        }
        const status = String(row.status || "").toLowerCase();

        // SHARED-TICKET PAYOUT MUST BE SPLIT, NOT REPEATED.
        // A multi-horse straight bet ("U2 FR8 PLA 2-3-5") is ONE receipt covering THREE
        // legs, and SGPools reports ONE payout for the ticket: $44.00. The old code did
        // `pay = num(row.payout)` and handed that whole $44 to every sibling, so a $30
        // ticket that returned $44 was logged as returning $132. The ledger cannot settle
        // per-leg from a per-ticket figure without dividing it.
        //
        // Only the horses that actually placed share the money — but SGPools does not tell
        // us WHICH ones from this row alone, so the honest split is equal across the legs
        // on the ticket, flagged for review. Largest-remainder keeps the parts summing to
        // the whole: $44/3 = 14.67 + 14.67 + 14.66, never 14.66*3 = $43.98 or 14.67*3 = $44.01.
        const ticketLegs = matchedReceipt
          ? pending.filter((l) => receiptOf(l) === rec || (matchedReceipt && receiptOf(l) === matchedReceipt))
          : [leg];
        const shareCount = ticketLegs.length > 1 ? ticketLegs.length : 1;
        let pay = num(row.payout);
        let splitNote = "";
        if (shareCount > 1 && pay > 0) {
          // deterministic order so the extra cent lands in the same place every run
          const ordered = ticketLegs.slice().sort((a, b) => Number(a.xlRow) - Number(b.xlRow));
          const idx = ordered.findIndex((l) => l.xlRow === leg.xlRow);
          const cents = Math.round(pay * 100);
          const base = Math.floor(cents / shareCount);
          const extra = cents - base * shareCount; // 0..shareCount-1 legs get one more cent
          pay = (base + (idx < extra ? 1 : 0)) / 100;
          splitNote =
            "receipt " + (matchedReceipt || rec) + " is one ticket covering " + shareCount +
            " horses; its $" + num(row.payout).toFixed(2) + " payout was split " + shareCount +
            " ways ($" + pay.toFixed(2) + " here). If only some horses placed, correct the shares before committing.";
        }

        let result, note = "";
        if (/refund|void|cancel/.test(status)) {
          result = "Refund";
        } else if (String(leg.betType).trim() === "WIN") {
          result = pay > 0 ? "Win" : "Lose";
        } else if (String(leg.betType).trim() === "PLA") {
          if (pay > 0) {
            const sw = sibWinRow(leg);
            if (sw && num(sw.payout) > 0) result = "Win";
            else if (sw) result = "Place";
            else { result = "Place"; note = "no WIN sibling found, assumed Place"; }
          } else result = "Lose";
        } else {
          // exotics (TRIO, Forecast, etc.): landed if it paid, else lost
          result = pay > 0 ? "Win" : "Lose";
        }
        if (matchedBy === "coordinate")
          note = (note ? note + "; " : "") + "matched by race/" + (isExoticType(leg.betType) ? "combo" : "horse") + " (no stored receipt); receipt " + (matchedReceipt || "?") + " backfilled";
        if (splitNote) note = (note ? note + "; " : "") + splitNote;
        proposal.push({
          xlRow: leg.xlRow,
          receipt: matchedReceipt,
          matchedBy,
          label: leg.date + " R" + leg.raceNo + " " +
            (isExoticType(leg.betType)
              ? leg.betType + " " + (leg.combo || "")
              : "#" + leg.horseNo + " " + (leg.horseName || "") + " " + leg.betType),
          result,
          payout: r2(pay),
          position: result === "Win" ? 1 : null,
          stake: leg.stake,
          note,
        });
      }

      // receipts we actually consumed, by either path, so unmatched is honest
      const consumedRecs = new Set(
        proposal.map((p) => p.receipt).filter(Boolean)
      );
      const unmatched = rows
        .filter((r) => {
          const rec = r && r.receipt
            ? String(r.receipt).toUpperCase().replace(/[^0-9A-Z]/g, "") : null;
          return rec && !consumedRecs.has(rec);
        })
        .map((r) => {
          const rec = String(r.receipt).toUpperCase().replace(/[^0-9A-Z]/g, "");
          return {
            receipt: rec,
            selection: r.selection || "",
            payout: r2(r.payout),
            klass: allReceipts[rec]
              ? "already settled in vault"
              : "not in vault (pre-vault or other)",
          };
        });

      const receiptMatched = proposal.filter((p) => p.matchedBy === "receipt").length;

      let wallet = null;
      if (parsed.wallet && parsed.wallet.balance != null) {
        wallet = {
          balance: r2(parsed.wallet.balance),
          horseOpen: parsed.wallet.horseOpen == null ? null : r2(parsed.wallet.horseOpen),
          sportsOpen: parsed.wallet.sportsOpen == null ? null : r2(parsed.wallet.sportsOpen),
          lotteryOpen: parsed.wallet.lotteryOpen == null ? null : r2(parsed.wallet.lotteryOpen),
          readAt: new Date().toISOString(),
        };
        await redis([["SET", "stw:wallet", JSON.stringify(wallet)]]);
      }

      return res.status(200).json({
        ok: true,
        parsedRows: rows.length,
        skippedNonHorse: parsed.skippedNonHorse || 0,
        matchedByReceipt: receiptMatched,
        matchedByCoordinate: coordMatched,
        proposal,
        untouched,
        unmatched,
        wallet,
      });
    }

    // -------------------- THE INTAKE CLERK (receipt-backed pending legs) --------------------
    // Read SGPools transaction-history images of bets JUST PLACED, extract each horse
    // wager with its real receipt, and PROPOSE pending legs to write into the book from
    // the actual confirmations rather than from the plan. Where the day's Stable proposal
    // exists, cross-check placed-vs-proposed and flag any mismatch. Writes nothing; the
    // user reviews and commits. This moves the verification moment to the START of the day.
    if (action === "intake") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const AK =
        process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";
      if (!AK)
        return res.status(500).json({
          error: "ANTHROPIC_API_KEY missing in Vercel env",
        });
      const body = parseBody(req);
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length || images.length > 8)
        return res.status(400).json({ error: "Provide 1-8 images" });
      const totalB64 = images.reduce(
        (a, im) => a + String(im.data || "").length,
        0
      );
      if (totalB64 > 4200000)
        return res.status(413).json({
          error: "Images too large after compression, send fewer pages per batch",
        });

      // the date these legs belong to: explicit, else today in Phuket (UTC+7, no DST)
      const phuketToday = () => {
        const p = new Date(Date.now() + 7 * 60 * 60 * 1000);
        const dd = String(p.getUTCDate()).padStart(2, "0");
        const mm = String(p.getUTCMonth() + 1).padStart(2, "0");
        return dd + "/" + mm + "/" + p.getUTCFullYear();
      };


      const legDate = body.date ? String(body.date).trim() : phuketToday();

      // pull any Stable proposal for this date, to cross-check placed vs proposed
      const propKey = "stw:proposal:" + legDate.replace(/\//g, "");
      const [logRaw, propRaw] = await redis([
        ["GET", "stw:betlog"],
        ["GET", propKey],
      ]);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const proposalDoc = propRaw ? JSON.parse(propRaw) : null;

      const prompt =
        "These images are Singapore Pools horse-racing bet confirmations, from the transaction history of bets that were JUST PLACED. " +
        "Extract EVERY row whose type is Horse Wagering (ignore Football, Sports and Lottery rows, but count how many you skipped). " +
        "\n\nCRITICAL - how to read the SELECTION string. It follows a fixed grammar: '<Un> <MEETcode><race> <TYPE> <horse-or-combo>'. Break it down carefully:\n" +
        "- The FIRST token is 'U' followed by the UNIT count (e.g. 'U3' means 3 units). This is NOT the race number. Put it in the units field.\n" +
        "- The SECOND token is the MEET CODE letters followed immediately by the RACE number (e.g. 'SA7' means meet SA, race 7; 'UK9' means meet UK, race 9; 'FR5' means France race 5). The digits here are the RACE NUMBER. Put those digits in raceNo.\n" +
        "- The THIRD token is the BET TYPE (WIN, PLA/Place, or an EXOTIC: TRIO/TRO, FORECAST/FC, QUARTET).\n" +
        "- The LAST token is the horse number (for WIN/PLA) or the combination (for exotics).\n" +
        "WORKED EXAMPLE: 'U3 SA7 PLA 9' means 3 UNITS, meet SA RACE 7, PLA bet, horse 9. So units=3, raceNo=7, betType=PLA, horseNo=9. Do NOT read the 3 from 'U3' as the race; the race is the 7 in 'SA7'.\n" +
        "ANOTHER: 'U5 SA7 TRO 4-5-9/4-5-9/4-5-9' means 5 UNITS, meet SA RACE 7, TRIO, combo 4-5-9/4-5-9/4-5-9. So units=5, raceNo=7, betType=TRIO, combo='4-5-9/4-5-9/4-5-9'.\n\n" +
        "TRANSACTION DATE — CRITICAL. Every row has a TRANSACTION DATE & TIME in the first column (e.g. '15 Jul 2026 08:11 AM'). A transaction history page routinely spans SEVERAL DAYS. Return that row's own date in txnDate as DD/MM/YYYY exactly as printed on THAT row — never today's date, never the date of the row above. Rows are logged against the day they were actually placed; getting this wrong files last week's bets as today's. If a row's date is genuinely unreadable, set txnDate to null rather than guessing. " +
        "For each horse bet extract: the RECEIPT number (letters and digits only, e.g. 557A0429); " +
        "the full SELECTION text verbatim; the MEET / country and course if shown; the COUPON CODE if shown; " +
        "the RACE number (the digits attached to the meet code, per the grammar above); the BET TYPE; the UNIT count (the number after 'U'); and the total AMOUNT staked in dollars. " +
        "MULTI-HORSE STRAIGHT BETS: it is common to place the SAME bet type on SEVERAL horses in ONE race as a single ticket, e.g. 'U2 FR8 PLA 2-3-5' = 2 units PLACE on horse 2, horse 3 AND horse 5 in France race 8, $30 total. This is NOT an exotic: it is three ordinary place bets sharing one receipt. Tell them apart by BET TYPE, never by the presence of dashes: WIN and PLA are ALWAYS straight bets however many horses are listed. For these put the FULL horse list exactly as printed into horseNo ('2-3-5') and leave combo empty. Only TRIO / FORECAST / PLACE FORECAST / TIERCE / QUARTET are exotics. " +
        "For the HORSE field: a WIN or PLA bet has a single horse number, put it in horseNo. " +
        "An EXOTIC (TRIO, Forecast, Quartet) is a COMBINATION, not one horse: leave horseNo null and put the full combination string (e.g. '4-5-9/4-5-9/4-5-9' or '1-3-7') in the combo field. Never force a single horse number onto an exotic. " +
        "RECEIPT ACCURACY. Receipt numbers sit in a dense column and adjacent rows often share a long prefix (5598944E, 5598944D, 559894C6). Read EACH receipt from its OWN row, character by character. Do NOT carry a prefix down from the row above — that produces a receipt that looks plausible but belongs to no ticket, and silently corrupts the book. If a receipt is not fully legible, set it to null rather than approximating. " +
        "Read the numbers exactly as printed. If a genuinely single-horse field is unreadable use null; do not guess. " +
        "CRITICAL OUTPUT RULE: your entire reply must be ONE minified JSON object and NOTHING else. Do not explain your reasoning, do not count rows out loud, do not write a preamble or a closing remark, do not use markdown fences. The first character you emit must be { and the last must be }. Any prose outside the JSON breaks the tool. Exactly this shape: " +
        '{"skippedNonHorse":0,' +
        '"bets":[{"receipt":"","txnDate":"DD/MM/YYYY","selection":"","meet":"","couponCode":"","raceNo":0,"horseNo":null,"combo":"","betType":"WIN|PLA|TRIO|FORECAST|QUARTET","units":1,"amount":0}]} ' +
        "For WIN/PLA set combo to empty string; for exotics set horseNo to null and fill combo. Numbers must be plain numbers without $ signs.";

      const content = images.map((im) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: im.media_type || "image/jpeg",
          data: im.data,
        },
      }));
      content.push({ type: "text", text: prompt });

      const cr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": AK,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          // NO ASSISTANT PREFILL. Seeding the reply with "{" would make a prose preamble
          // structurally impossible, and it is the standard trick for forcing JSON — but
          // this model rejects it outright: HTTP 400 "This model does not support assistant
          // message prefill. The conversation must end with a user message." Every intake
          // and reconcile died on that until it was removed. The defence against preamble
          // is therefore the CRITICAL OUTPUT RULE in the prompt plus the salvaging
          // extractJson() parser, which is why that parser must stay tolerant.
          messages: [{ role: "user", content }],
        }),
      });
      if (!cr.ok) {
        const t = await cr.text();
        return res.status(502).json({
          error: "Claude vision HTTP " + cr.status + ": " + t.slice(0, 180),
        });
      }
      const cj = await cr.json();
      const text = (cj.content || [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      let parsed;
      try {
        parsed = parseVisionReply(text);
      } catch (e) {
        return res.status(502).json({ error: String(e.message || e) });
      }
      const rawBetsRead = Array.isArray(parsed.bets) ? parsed.bets : [];

      // MULTI-HORSE STRAIGHT BETS -> ONE LEG PER HORSE.
      // Placing the same bet type on several horses in one race as a single ticket
      // ("U2 FR8 PLA 2-3-5" = 2 units place on horses 2, 3 and 5, $30) is a mobile
      // shortcut, not a different bet: mechanically it is three ordinary place bets
      // sharing one receipt. The journal has ALWAYS stored one row per horse — 167 PLA
      // legs, zero multi-horse rows, and eight races already split by hand — because, as
      // the Model Notes put it, the legs "settle independently". A 2-3-5 ticket must
      // therefore become three rows, or the ledger cannot settle them.
      //
      // Without this, "PLA 2-3-5" hit the single-selection regex, silently kept ONLY
      // horse 2, and logged the whole $30 against it. Horses 3 and 5 vanished.
      //
      // The split is by BET TYPE, never by punctuation: a dashed list on a WIN/PLA is
      // several horses, the identical-looking list on a TRIO is one combination.
      const EXOTIC_SET = ["TRIO", "TRO", "FORECAST", "FC", "PLACE FORECAST", "TIERCE", "QUARTET", "QUAD", "QT", "QUINELLA", "QN"];
      const isExoticBet = (t) => EXOTIC_SET.includes(String(t || "").trim().toUpperCase());
      const rawBets = [];
      for (const b of rawBetsRead) {
        const horseField = b == null ? "" : String(b.horseNo == null ? "" : b.horseNo).trim();
        const isMulti = !isExoticBet(b && b.betType) && /^\d+(\s*[-,/]\s*\d+)+$/.test(horseField);
        if (!isMulti) { rawBets.push(b); continue; }
        const horses = horseField.split(/[-,/]/).map((x) => x.trim()).filter(Boolean);
        // The receipt amount is the TOTAL across every horse on the ticket. Each horse
        // carries an equal share, which is how SGPools prices it: units x $5 per horse.
        const total = num(b.amount);
        const per = horses.length ? r2(total / horses.length) : total;
        for (const h of horses) {
          rawBets.push(Object.assign({}, b, {
            horseNo: h,
            combo: "",
            amount: per,
            // every split leg shares the parent receipt: that is the audit trail back to
            // the one physical ticket, and the dedupe key that stops a re-upload doubling.
            _splitFrom: horseField,
            _splitCount: horses.length,
          }));
        }
      }

      // Receipts already in the vault, so re-uploading the same page never double-logs.
      // The key must match the one used at lookup below: receipt + horse (or + combo for
      // exotics), NOT the bare receipt. A multi-horse ticket splits into several legs that
      // all share one receipt, so a bare-receipt key would let the first horse in and
      // reject its siblings as duplicates.
      const rxRec = /receipt\s+([0-9A-Z]+)/i;
      const existingReceipts = new Set();
      log.forEach((b) => {
        const m = rxRec.exec(String(b.notes || ""));
        if (!m) return;
        const rec = m[1].toUpperCase();
        const t = String(b.betType || "").toUpperCase();
        const isEx = ["TRIO", "FORECAST", "QUARTET", "QUINELLA", "TIERCE", "PLACE FORECAST"].includes(t);
        existingReceipts.add(rec + "|" + (isEx ? "combo:" + String(b.combo || "").trim() : "h:" + String(b.horseNo == null ? "" : b.horseNo).trim()));
      });

      const normType = (t) => {
        const s = String(t || "").toUpperCase();
        if (s.startsWith("W")) return "WIN";
        if (s.startsWith("PLA") || s === "P" || s.startsWith("PLACE") || s === "PLC") return "PLA";
        if (s.startsWith("T") || s.includes("TRIO") || s.includes("TRO")) return "TRIO";
        if (s.includes("FORECAST") || s === "FC" || s.startsWith("FORE")) return "FORECAST";
        if (s.includes("QUARTET") || s.includes("QUAD") || s === "QT") return "QUARTET";
        if (s.includes("QUINELLA") || s === "QN") return "QUINELLA";
        return s || "WIN";
      };
      const isExotic = (t) => ["TRIO", "FORECAST", "QUARTET", "QUINELLA"].includes(t);

      const legs = [];
      const warnings = [];
      const seen = new Set();
      for (const b of rawBets) {
        const receipt = b.receipt
          ? String(b.receipt).toUpperCase().replace(/[^0-9A-Z]/g, "")
          : "";
        // A receipt of the wrong length is the fingerprint of the OCR column-bleed that
        // put four phantom legs in the book on 16/07: 559894C6 was read as 5598944C6, the
        // prefix carried down from the rows above. It matches no ticket, so dedupe cannot
        // see it is a duplicate and the coordinate matcher settles it against the wrong
        // day. Surface it before it is committed rather than after it has poisoned a month
        // of calibration.
        if (receiptLooksWrong(receipt))
          warnings.push(
            "Receipt " + receipt + " is " + receipt.length + " characters; SGPools receipts are " +
            RECEIPT_LEN + ". This is usually a misread that carried a digit from the row above — " +
            "check it against the page before committing, or the leg will not match its ticket."
          );
        const betType = normType(b.betType);
        const exotic = isExotic(betType);
        const amount = num(b.amount);

        // Cross-check against the verbatim selection string, the raw receipt text, which is
        // less prone to the units-vs-race confusion than the separately-extracted fields.
        // Grammar: "U<units> <MEETcode><race> <TYPE> <horse-or-combo>". Trust this when it parses.
        const sel = String(b.selection || "").trim();
        // strip the leading "U<n>" unit token, then read MEETcode+race, type, and tail
        const selM = /^U?\d*\s+([A-Z]{2,4})(\d+)\s+([A-Z]+)\s+([\d\-\/]+)/i.exec(sel);
        let raceNo = b.raceNo == null ? "" : String(b.raceNo).trim();
        let selHorse = "", selCombo = "";
        if (selM) {
          const selRace = selM[2];
          if (selRace && selRace !== raceNo) {
            // the receipt text wins; the model likely grabbed the unit number by mistake
            raceNo = selRace;
          }
          const tail = selM[4];
          // Decide by BET TYPE, never by punctuation. The old test was
          // `if (/[-\/]/.test(tail))` -> combo, which meant a straight place bet on
          // several horses ("U2 FR8 PLA 2-3-5") was read as a combination, so horseNo came
          // back null and the leg rendered as "#?" with the whole $30 against it. A dashed
          // tail on a WIN/PLA is a LIST OF HORSES; the identical-looking tail on a TRIO is
          // ONE combination. Only the bet type can tell them apart.
          if (exotic) selCombo = tail; else selHorse = tail;
        }
        // exotics carry a combination, not a single horse; singles carry a horse number
        const combo = exotic
          ? (String(b.combo || "").trim() || selCombo)
          : "";
        const horseNo = exotic
          ? "" // exotics never store a single horse number
          : (b.horseNo == null ? (selHorse || "") : String(b.horseNo).trim()) || selHorse;

        // DEDUPE KEY = receipt + horse, not receipt alone. A multi-horse ticket splits into
        // several legs that all legitimately share ONE receipt ("U2 FR8 PLA 2-3-5" -> three
        // legs, receipt 559DD930). Keying on the receipt alone would commit the first horse
        // and silently discard the rest as duplicates — the same shape of bug as the split
        // itself, just further down the pipe. Including the horse keeps re-upload protection
        // intact (the same page twice still collides) while letting siblings through.
        const dedupeKey = receipt ? receipt + "|" + (exotic ? "combo:" + combo : "h:" + horseNo) : "";

        if (dedupeKey && existingReceipts.has(dedupeKey)) {
          warnings.push(
            "Receipt " + receipt + (horseNo ? " (horse " + horseNo + ")" : "") +
            " is already in the book, skipped to avoid a duplicate."
          );
          continue;
        }

        // COORDINATE DUPLICATE GUARD — the defence that does not trust the receipt.
        // Receipt-keyed dedupe is only as good as the OCR: when 559894C6 was misread as
        // 5598944C6 the key matched nothing, the guard passed, and a leg already sitting
        // in the book was logged a second time. This asks a different question — "is there
        // already a leg on this exact day, meet, race, horse, type and stake?" — which the
        // misread cannot dodge, because the coordinates come from the selection text rather
        // than the receipt column.
        //
        // CRITICAL SCOPE: this only fires when the receipt is NOT trustworthy (missing, or
        // failing the 8-character rule). Hammy really does back the same horse twice in a
        // day at the same stake — topping up a position — and those are distinct tickets
        // with distinct, well-formed receipts. Blocking them would trade one silent
        // corruption for another. A good receipt is the stronger identity and wins; the
        // coordinate check is the safety net for exactly the case that burned us.
        const receiptTrustworthy = !!receipt && !receiptLooksWrong(receipt);
        const coordDupe = receiptTrustworthy ? null : log.find(
          (x) =>
            String(x.date).trim() === String(legDateForRow).trim() &&
            String(x.meet || "").trim().toLowerCase() === String(b.meet || "").trim().toLowerCase() &&
            String(x.raceNo) === String(raceNo) &&
            String(x.horseNo == null ? "" : x.horseNo).trim() === String(horseNo == null ? "" : horseNo).trim() &&
            String(x.betType || "").trim().toUpperCase() === String(betType).trim().toUpperCase() &&
            Math.abs(num(x.stake) - num(amount)) < 0.01 &&
            String(x.ledger || "").trim().toLowerCase() !== "void"
        );
        if (coordDupe) {
          warnings.push(
            "SKIPPED as a probable duplicate: " + legDateForRow + " " + String(b.meet || "").trim() +
            " R" + raceNo + " #" + horseNo + " " + betType + " $" + amount +
            " is already in the book at row " + coordDupe.xlRow + " (receipt " +
            ((String(coordDupe.notes || "").match(/receipt\s+([0-9A-Z]+)/i) || [])[1] || "?") +
            "). The receipt read here was " + (receipt || "unreadable") +
            (receipt ? " which is not a valid 8-character receipt" : "") +
            ", so it could not be matched by receipt. If this really is a second, separate bet, log it by hand."
          );
          continue;
        }
        if (dedupeKey && seen.has(dedupeKey)) {
          warnings.push("Receipt " + receipt + (horseNo ? " (horse " + horseNo + ")" : "") + " appeared twice in the upload, kept once.");
          continue;
        }
        if (dedupeKey) seen.add(dedupeKey);

        // STAKE NOTE. This compares UNITS, not dollars. The old check compared the leg's
        // total against a per-unit figure ($5 PLA / $10 WIN), so any multi-unit leg tripped
        // a false alarm: "U3 FR5 PLA 3" is $15, which is correct for 3 units, yet it warned
        // "stake $15 differs from the usual flat $5 for PLA". That manufactured most of the
        // "differences from plan" on a slip that was actually read perfectly.
        //
        // The real Charter rule is about UNIT COUNT: flat $10 WIN (2 units) + $5 PLA
        // (1 unit). So flag the unit count, which is the thing the rule actually governs.
        // Exotic stakes legitimately vary with units and combo size: soft note only, never a block.
        let stakeNote = "";
        if (!exotic) {
          const perUnit = 5; // SGPools unit
          const expectedUnits = betType === "WIN" ? 2 : betType === "PLA" ? 1 : null;
          const actualUnits = amount && perUnit ? Math.round((amount / perUnit) * 100) / 100 : null;
          if (expectedUnits && actualUnits && Math.abs(actualUnits - expectedUnits) > 0.01) {
            stakeNote =
              actualUnits + (actualUnits === 1 ? " unit" : " units") + " ($" + amount + ") where the flat rule is " +
              expectedUnits + (expectedUnits === 1 ? " unit" : " units") + " ($" + expectedUnits * perUnit + ") for " + betType;
          }
        } else if (amount && Math.abs(amount - 6) > 0.01) {
          // soft, informational only: exotics are allowed any stake
          stakeNote = "exotic staked $" + amount + " (exotics vary by units/combo, no flat rule)";
        }

        // build the selection/combo descriptor for the notes and identity
        const comboText = exotic
          ? (combo || String(b.selection || "").trim() || "combo unread")
          : "";

        // THE DATE MUST COME FROM THE ROW, NOT THE CLOCK.
        // Every leg used to be stamped with legDate (today). A SGPools transaction history
        // routinely spans several days, so uploading it on the 16th filed the 15th's bets
        // as fresh 16th legs. Four such phantoms entered the book on 16/07/2026 carrying
        // $108 of payout that had already been counted the day before, and turned a -$27.70
        // day into a reported +$40.10 profit. The date was printed on every row the whole
        // time; the tool simply never read it.
        //
        // Trust the row's own txnDate when it parses; fall back to legDate only when the
        // model could not read one, and say so in the notes rather than pretending.
        const rowDate = normDate(b.txnDate);
        const dateFromRow = !!rowDate;
        const legDateForRow = rowDate || legDate;
        if (!dateFromRow && b.txnDate)
          warnings.push(
            "Receipt " + (receipt || "?") + ": could not read its transaction date (\"" +
            String(b.txnDate).slice(0, 20) + "\"), so it was filed under " + legDate + ". Check the date before committing."
          );
        if (dateFromRow && legDateForRow !== legDate)
          warnings.push(
            "Receipt " + (receipt || "?") + " is dated " + legDateForRow +
            ", not " + legDate + " — filed under its own date, as printed on the receipt."
          );

        legs.push({
          date: legDateForRow,
          meet: String(b.meet || "").trim(),
          couponCode: String(b.couponCode || "").trim(),
          raceNo,
          horseNo,
          combo: comboText,
          horseName: "",
          betType,
          exotic,
          stake: amount || 0,
          confidence: "",
          ledger: exotic ? "Exotic" : "Model",
          reason: "",
          notes:
            "Pending, receipt " + (receipt || "UNKNOWN") +
            (exotic
              ? " [" + betType + " " + comboText + "]"
              : (b.selection ? " (" + String(b.selection).trim() + ")" : "")),
          receipt,
          selection: String(b.selection || "").trim(),
          stakeNote,
        });
      }

      // cross-check against the Stable proposal for the day, if one exists
      let reconcile = null;
      if (proposalDoc && Array.isArray(proposalDoc.legs)) {
        // singles key on race+horse+type; exotics key on race+combo+type
        const keyOf = (l) => {
          const t = normType(l.betType);
          if (isExotic(t))
            return [String(l.raceNo).trim(), "combo:" + String(l.combo || l.selection || "").replace(/\s/g, ""), t].join("|");
          return [String(l.raceNo).trim(), String(l.horseNo).trim(), t].join("|");
        };
        const descOf = (l) => {
          const t = normType(l.betType);
          return isExotic(t)
            ? "R" + l.raceNo + " " + t + " " + (l.combo || l.selection || "")
            : "R" + l.raceNo + " #" + l.horseNo + " " + t + (l.horseName ? " " + l.horseName : "");
        };
        const placedKeys = new Map();
        legs.forEach((l) => placedKeys.set(keyOf(l), l));
        const proposedKeys = new Map();
        proposalDoc.legs.forEach((l) => proposedKeys.set(keyOf(l), l));

        const placedNotProposed = [];
        const proposedNotPlaced = [];
        const stakeDiffs = [];
        for (const [k, l] of placedKeys) {
          if (!proposedKeys.has(k))
            placedNotProposed.push(descOf(l));
        }
        for (const [k, l] of proposedKeys) {
          if (!placedKeys.has(k))
            proposedNotPlaced.push(descOf(l));
          else {
            const placed = placedKeys.get(k);
            const ps = num(placed.stake), qs = num(l.stake);
            if (ps && qs && Math.abs(ps - qs) > 0.01)
              stakeDiffs.push(descOf(l) + ": placed $" + ps + ", planned $" + qs);
            if (!placed.horseName && l.horseName) placed.horseName = l.horseName;
            if (!placed.confidence && l.confidence) placed.confidence = l.confidence;
            if (!placed.reason && l.reason) placed.reason = l.reason;
          }
        }
        reconcile = {
          proposedCount: proposalDoc.legs.length,
          placedCount: legs.length,
          placedNotProposed,
          proposedNotPlaced,
          stakeDiffs,
          clean:
            !placedNotProposed.length &&
            !proposedNotPlaced.length &&
            !stakeDiffs.length,
        };
      }

      // vault-ready payload: the pending legs to write, in the shape addlegs accepts
      const quillPayload = {
        date: legDate,
        legs: legs.map((l) => ({
          date: l.date,
          meet: l.meet,
          raceNo: l.raceNo,
          horseNo: l.horseNo,
          combo: l.combo,
          horseName: l.horseName,
          betType: l.betType,
          stake: l.stake,
          confidence: l.confidence,
          ledger: l.ledger,
          reason: l.reason,
          result: "Pending",
          notes: l.notes,
        })),
      };

      return res.status(200).json({
        ok: true,
        date: legDate,
        parsedBets: rawBets.length,
        skippedNonHorse: parsed.skippedNonHorse || 0,
        legs,
        warnings,
        reconcile,
        quillPayload,
        hadProposal: !!proposalDoc,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

module.exports.computeAudit = computeAudit; // exposed for test harnesses
module.exports.computeRuleDecay = computeRuleDecay; // exposed for test harnesses

// ---- Vercel function configuration ----
// THE TIMEOUT BUG (fixed): the client set a 115s leash on intake/reconcile and its comment
// claimed that sat "just under the server function's own 120s cap". No cap was declared
// anywhere. The function ran on whatever the platform default happened to be, and the
// client waited 115s for something that may already have been killed.
//
// TWO SOURCES OF TRUTH — READ THIS BEFORE CHANGING EITHER:
// vercel.json also declares "api/stewards.js": { "maxDuration": 120 }. For plain Node /api
// routes Vercel accepts BOTH this in-code config export and the vercel.json entry, and the
// in-code value takes precedence. They currently agree at 120. If you change one, change
// the other, or the file will say one thing and the platform will do another — which is
// the exact failure this block was written to fix.
//
// This export cannot simply be deleted in favour of vercel.json: the bodyParser limit below
// has no vercel.json equivalent and must live here.
//
// WHY 120: it covers a fat 8-image vision parse (up to 4.2MB b64, max_tokens 4000, commonly
// 20-60s) with room to spare, still bounds a runaway, and matches the client's leash.
// Sibling functions in vercel.json: trawl 300s, propose 120s. The client derives every
// leash from those numbers (see SERVER_MAX_MS / TRAWL_MAX_MS / PROPOSE_MAX_MS in
// stewards.html) rather than restating them.
//
// PLAN NOTE: 120 and trawl's 300 both exceed the classic non-Fluid ceiling of 60s. They
// deploy, which means Fluid compute is enabled on this project (Fluid: 300s default, 800s
// max on Pro). If Fluid is ever turned off, both will be rejected at deploy time.
module.exports.config = {
  maxDuration: 120,
  api: {
    // the vision endpoints guard their own 4.2MB b64 budget in code; this is the outer
    // wall so an oversized POST is refused by the platform rather than parsed and then
    // rejected after we have already paid to receive it.
    bodyParser: { sizeLimit: "8mb" },
  },
};
