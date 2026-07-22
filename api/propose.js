// api/propose.js
// THE STABLE — the Stewards' Room proposal engine (Phase 3, Stage C).
// Reads the morning pack, the Charter (the distilled locked rules), and the
// recent lessons, hands them to Claude, and returns a betlist in the exact
// slip format — obeying flat staking, the WIN-leak fade, Medium-High bias,
// the data-edge gate, card-match discipline, and the convergence-gated Trio.
//
// It PROPOSES only. Nothing is written to the bet log; the user reviews the
// slip and commits through the Quill (which the frontend wires as one tap).
//
// Actions:
//   GET  ?action=charter                 -> the stored Charter (seeds on first read)
//   POST ?action=seedcharter {force}     -> (re)write the bundled Charter into the vault
//   POST ?action=run [{date?}]           -> build a betlist from the latest/﻿given pack

import charterSeed from "./charter-seed.json" with { type: "json" };
import { regionOf } from "./trawl.js";

const R_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const R_TOK =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const AK = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";

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

// Write each key, snapshot the previous value first, then read back and confirm
// the stored value matches what we sent. Same discipline as the vault's own writes.
async function writeVerified(kv) {
  const keys = Object.keys(kv);
  // snapshot current values as stw:prev:*
  const cur = await redis(keys.map((k) => ["GET", k]));
  const snap = [];
  keys.forEach((k, i) => {
    if (cur[i] != null) snap.push(["SET", "stw:prev:" + k.replace(/^stw:/, ""), cur[i]]);
  });
  if (snap.length) await redis(snap);
  // write
  await redis(keys.map((k) => ["SET", k, kv[k]]));
  // read back and verify
  const back = await redis(keys.map((k) => ["GET", k]));
  const verify = {};
  let allMatch = true;
  keys.forEach((k, i) => {
    const match = back[i] === kv[k];
    verify[k] = { match };
    if (!match) allMatch = false;
  });
  return { verify, allMatch };
}

function parseBody(req) {
  try {
    return typeof req.body === "object" && req.body
      ? req.body
      : JSON.parse(req.body || "{}");
  } catch (e) {
    return {};
  }
}

async function getCharter() {
  const [raw] = await redis([["GET", "stw:charter"]]);
  if (raw) return JSON.parse(raw);
  // seed on first read so the room always has its constitution
  await redis([["SET", "stw:charter", JSON.stringify(charterSeed)]]);
  return charterSeed;
}

// Pull the freshest lessons so the brain learns from its own graded record.
async function recentLessons() {
  const [nRaw, dRaw] = await redis([
    ["GET", "stw:notes"],
    ["GET", "stw:daily"],
  ]);
  const out = [];
  if (dRaw) {
    const daily = JSON.parse(dRaw);
    const withLessons = daily.filter((d) => d.lessons && String(d.lessons).trim());
    withLessons.slice(-8).forEach((d) =>
      out.push("[" + d.date + "] " + String(d.lessons).slice(0, 400))
    );
  }
  if (nRaw) {
    const notes = JSON.parse(nRaw);
    notes.slice(-6).forEach((n) => {
      const t = (n.cols || []).filter(Boolean).join(" ");
      if (t && t.length > 20) out.push(t.slice(0, 400));
    });
  }
  return out.slice(-12);
}

function charterText(ch) {
  return ch.laws
    .filter((l) => !l.repealed)
    .map((l, i) => i + 1 + ". " + l.title.toUpperCase() + (l.custom ? " (promoted)" : "") + "\n   " + l.rule)
    .join("\n\n");
}

// Compute the LIVE health of each founding law that maps to a measurable figure.
// Returns a map keyed by law id. Founding rationale text is NEVER touched; this is a
// separate live readout shown beside it. Laws with no honest metric are omitted (procedural).
// `foundingPct` is parsed from the law's own rationale so we can show then-vs-now drift.
function charterHealth(betLog) {
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const r2 = (v) => Math.round(num(v) * 100) / 100;
  const normResult = (v) => {
    const s = String(v == null ? "" : v).trim().toLowerCase();
    return s === "loss" ? "lose" : s;
  };
  const normConf = (v) => {
    const s = String(v == null ? "" : v).trim();
    return s === "Med-High" ? "Medium-High" : s;
  };
  const isSettled = (b) => ["win", "place", "lose"].includes(normResult(b.result));
  const roiOf = (legs) => {
    const staked = legs.reduce((a, b) => a + num(b.stake), 0);
    const payout = legs.reduce((a, b) => a + num(b.payout), 0);
    return {
      n: legs.length,
      roi: staked ? Math.round(((payout - staked) / staked) * 1000) / 10 : null,
      cashRate: legs.length
        ? Math.round((legs.filter((b) => num(b.payout) > 0).length / legs.length) * 1000) / 10
        : null,
      net: r2(payout - staked),
    };
  };
  const model = betLog.filter(
    (b) => String(b.ledger || "").trim().toLowerCase() === "model" && isSettled(b)
  );
  const exotic = betLog.filter(
    (b) => String(b.ledger || "").trim().toLowerCase() === "exotic" && ["win", "lose"].includes(normResult(b.result))
  );
  const winLegs = model.filter((b) => String(b.betType).trim() === "WIN");
  const plaLegs = model.filter((b) => String(b.betType).trim() === "PLA");
  const japanLegs = model.filter((b) =>
    /japan/i.test(String(b.meet || ""))
  );

  const health = {};

  // win-leak: WIN book ROI + cash rate vs PLA (founding: WIN -19.6%, 36% cash)
  {
    const w = roiOf(winLegs), p = roiOf(plaLegs);
    health["win-leak"] = {
      kind: "stat",
      metric: "WIN book ROI (cash rate), vs PLA",
      live: w.roi == null ? "no WIN legs yet" :
        w.roi + "% ROI, " + w.cashRate + "% cash (PLA " + (p.roi == null ? "n/a" : p.roi + "%)"),
      n: w.n,
      livePct: w.roi,
      foundingPct: -19.6,
    };
  }
  // medium-high-bias: the founding +19.2% was the Medium-High PLA ROI specifically
  // (a thin ~19-line sample), so the live figure must also be Medium-High PLA only.
  {
    const mhPla = plaLegs.filter((b) => normConf(b.confidence) === "Medium-High");
    const mh = roiOf(mhPla);
    health["medium-high-bias"] = {
      kind: "stat",
      metric: "Medium-High PLA ROI",
      live: mh.roi == null ? "no Medium-High PLA legs yet" : mh.roi + "% ROI",
      n: mh.n,
      livePct: mh.roi,
      foundingPct: 19.2,
    };
  }
  // trim-medium: Medium PLA bucket ROI (founding: -20.9% over 34)
  {
    const medPla = plaLegs.filter((b) => normConf(b.confidence) === "Medium");
    const m = roiOf(medPla);
    health["trim-medium"] = {
      kind: "stat",
      metric: "Medium PLA bucket ROI",
      live: m.roi == null ? "no Medium PLA legs yet" : m.roi + "% ROI",
      n: m.n,
      livePct: m.roi,
      foundingPct: -20.9,
    };
  }
  // japan-caution: outcome of any Japan legs taken (founding: repeatedly blanked)
  {
    const j = roiOf(japanLegs);
    health["japan-caution"] = {
      kind: "outcome",
      metric: "Japan legs taken, their ROI",
      live: j.n === 0 ? "0 Japan legs taken (caution holding)" :
        j.n + " Japan legs, " + j.roi + "% ROI, " + j.cashRate + "% cash",
      n: j.n,
      livePct: j.roi,
      foundingPct: null,
    };
  }
  // exotic-trio: the Exotic ledger's health (founding: capped trial)
  {
    const e = roiOf(exotic);
    health["exotic-trio"] = {
      kind: "outcome",
      metric: "Exotic (Trio) ledger ROI",
      live: e.n === 0 ? "0 exotics settled yet" :
        e.n + " exotics, " + e.roi + "% ROI, " + e.cashRate + "% cash",
      n: e.n,
      livePct: e.roi,
      foundingPct: null,
    };
  }
  return health;
}

// Is a live figure meaningfully diverged from its founding figure? Returns a drift note or null.
// Guards against thin-sample noise: needs a real number, a founding baseline, and enough legs.
// Language is deliberately NEUTRAL about good/bad: a higher ROI strengthens some laws (medium-high
// bias) but weakens others (the trim/fade laws, whose whole premise is that the figure is poor).
// So we state the movement factually and leave the judgement of what it means to the reader.
function charterDrift(h, minN) {
  if (!h || h.livePct == null || h.foundingPct == null) return null;
  if ((h.n || 0) < (minN || 20)) return null; // too few legs to trust
  const gap = Math.round((h.livePct - h.foundingPct) * 10) / 10;
  if (Math.abs(gap) < 8) return null; // within normal drift, no signal
  return {
    gap,
    direction: gap > 0 ? "risen" : "fallen",
    text:
      "enacted at " + h.foundingPct + "%, now " + h.livePct + "% over " +
      h.n + " legs (" + (gap > 0 ? "+" : "") + gap + " pts)",
  };
}


// ---- MEET RESOLUTION: one canonical venue per leg, or a loud error ----
//
// THE BUG THIS EXISTS TO KILL (22/07/2026). Every meet-keyed structure in this file is built
// from the PACK's venue — "South Africa", the SGPools coupon container. Five lookups then
// keyed off `leg.meet`, which is free text the model writes, and the model writes the COURSE
// it read about: "Scottsville". The labels never matched, and every one of the five missed
// silently into a zero default:
//
//   cardIndex   -> null  -> "could not be matched to the runner map", on runners that were
//                           sitting on the card at exactly the number given
//   extCount    -> 0     -> a `no-external-source` veto on a meet with three live sources
//   fieldSizeOf -> 0     -> `if (fs > 0 && fs <= 8)` never fires: the PLA small-field floor
//                           was not enforcing, it was absent
//   perMeetKept -> 0     -> per-meet caps counted against a label that could vary per leg
//   priceIndex  -> undef -> every shadow price verdict permanently "nodata"
//
// On 22/07 that emptied the book: the two legs from the only region with working sources were
// flagged UNCONFIRMED and then vetoed, and nothing in the output said "label mismatch".
// Five silent zeros look exactly like normal operation, which is what made it survive.
//
// So: resolve ONCE, here, and key everything off the result. An unresolvable label is a
// visible error and a veto, never a fall-through.
const normMeet = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Resolve a model-authored meet label to one of the pack's venues.
// Returns { venue, how } on success, { venue: null, why } on failure. NEVER guesses between
// two candidates: an ambiguous label is a failure, because picking wrong puts real money on
// the wrong coupon — the exact class of error the card-match law exists to prevent.
function resolveMeet(label, meets) {
  const venues = (meets || []).map((m) => m.venue);
  const want = normMeet(label);
  if (!want)
    return { venue: null, why: "the leg carries no meet label at all, so it cannot be tied to a coupon" };

  // 1. the label IS a pack venue
  const exact = venues.filter((v) => normMeet(v) === want);
  if (exact.length === 1) return { venue: exact[0], how: "exact" };

  // 2. one contains the other ("Perth" -> "Australia (Perth)"). Must be unambiguous.
  const contains = venues.filter((v) => {
    const n = normMeet(v);
    return n && (n.includes(want) || want.includes(n));
  });
  if (contains.length === 1) return { venue: contains[0], how: "label" };

  // 3. the label is a COURSE ("Scottsville"). regionOf knows every course the book bets, and
  // the pack already carries each meet's region, so a course resolves to the one meet in its
  // region. This is the case that was breaking every day.
  const reg = regionOf(label);
  if (reg && reg !== "OTHER") {
    const inReg = (meets || []).filter((m) => (m.region || regionOf(m.venue)) === reg);
    if (inReg.length === 1) return { venue: inReg[0].venue, how: "region:" + reg };
    if (inReg.length > 1)
      return {
        venue: null,
        why:
          '"' + label + '" is a ' + reg + " course but this pack holds " + inReg.length +
          " " + reg + " meets (" + inReg.map((m) => m.venue).join(", ") +
          ") — which coupon it belongs to is genuinely ambiguous, so it must be named exactly",
      };
  }
  return {
    venue: null,
    why:
      '"' + label + '" matches no meet in today\'s pack (' + venues.join(", ") +
      ") and is not a course this book recognises",
  };
}

// The meet-keyed indexes, all built from the PACK's venue. Returned together so there is one
// place where that keying decision lives, and so the safety suite can exercise the real
// structures rather than a copy of them.
function meetIndexes(pack) {
  const cardIndex = {};   // venue|raceNo|horseNo -> horse name
  const extCount = {};    // venue -> count of verified external sources
  const fieldSizeOf = {}; // venue|raceNo -> field size
  (pack.meets || []).forEach((m) => {
    // SGPools internal analysis docs (m.docs) deliberately do NOT count — internal docs
    // corroborating internal docs is SGPools agreeing with itself.
    extCount[m.venue] = (m.sources || []).filter((s) => s.ok && !s.ssotFail).length;
    (m.raceMap || []).forEach((r) => {
      fieldSizeOf[m.venue + "|" + r.raceNo] = r.fieldSize || (r.runners || []).length || 0;
      (r.runners || []).forEach((h) => {
        cardIndex[m.venue + "|" + r.raceNo + "|" + h.no] = h.name;
      });
    });
  });
  return { cardIndex, extCount, fieldSizeOf };
}

// Same keying, for the Phase 3.3 shadow price sweep.
function priceIndexOf(pricedPack) {
  const priceIndex = {};
  ((pricedPack && pricedPack.meets) || []).forEach((m) =>
    (m.raceMap || []).forEach((r) =>
      (r.runners || []).forEach((h) => {
        if (h.price) priceIndex[m.venue + "|" + r.raceNo + "|" + h.no] = h.price;
      })
    )
  );
  return priceIndex;
}

// Compress the pack into a token-lean but complete brief for the model.
function packBrief(pack) {
  const L = [];
  L.push("DATE: " + pack.date);
  L.push(
    "GATE: " + pack.meets.length + " meets survived of " + pack.scanned + " scanned."
  );
  (pack.deselected || []).forEach((d) =>
    L.push("  DESELECTED " + d.venue + " — " + d.why)
  );
  for (const m of pack.meets) {
    L.push("\n#### " + m.venue + " [" + m.region + ", score " + m.score + ", " + m.races + " races" + (m.coupon ? ", " + m.coupon : "") + "]");
    // THE TRAWL'S SSOT VERDICT COMES FIRST, BEFORE ANY PROSE.
    // The trawl verifies every source against the SGPools card — the single source of
    // truth — on runner names, race distances and the card's date. A source that names
    // NONE of the card's runners is describing a different meeting, and its text is
    // withheld rather than shown. When EVERY source for a meet fails that check, the
    // meet has no analysis at all today and must not be selected from.
    //
    // This is the 17/07/2026 lesson stated in code: Race Coast had published previews for
    // 18 and 19 July but nothing for the 17th, the trawl handed them over anyway, and six
    // legs were staked on South African horses that were never analysed — the numbers came
    // from another day's card. An unsourced meet is not an invitation to try harder.
    if (m.ssotBlind) {
      L.push("*** " + m.ssotBlind + " ***");
      L.push("DO NOT PROPOSE ANY LEG FROM THIS MEET. Skipping it is the correct outcome, not a failure.");
      (m.ssotRejected || []).forEach((r) =>
        L.push("  withheld: [" + r.id + "] " + r.why)
      );
      continue;
    }
    (m.ssotRejected || []).forEach((r) =>
      L.push("  SOURCE WITHHELD [" + r.id + "]: " + r.why)
    );
    if (m.weather && !m.weather.error)
      L.push(
        "WEATHER: rain yesterday " + m.weather.yesterdayRainMm + "mm, today " +
          m.weather.todayRainMm + "mm (" + m.weather.rainChancePct + "%), wind " +
          m.weather.maxWindKmh + "km/h — factor going/pace."
      );
    // runner map = the ONLY authority for horse numbers (card-match law)
    (m.raceMap || []).forEach((r) => {
      const runners = (r.runners || []).map((h) => h.no + "=" + h.name).join(", ");
      L.push("R" + r.raceNo + " (" + (r.dist || "?") + "): " + runners);
    });
    (m.docs || []).forEach((d) => {
      if (!d.error && d.text)
        L.push("[SGPools " + d.label + "]\n" + String(d.text).slice(0, 4500));
    });
    (m.sources || []).forEach((s) => {
      if (s.ok && s.text)
        L.push("[" + s.id + "]\n" + String(s.text).slice(0, 3500));
    });
  }
  return L.join("\n");
}

const handler = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    if (!R_URL || !R_TOK)
      return res.status(500).json({ error: "Redis env vars missing" });
    const action = (req.query.action || "charter").toString();

    if (action === "charter") {
      const ch = await getCharter();
      return res.status(200).json(ch);
    }

    if (action === "seedcharter") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const [ex] = await redis([["EXISTS", "stw:charter"]]);
      if (ex && !body.force)
        return res
          .status(409)
          .json({ error: 'Charter exists. Send {"force":true} to overwrite.' });
      await redis([["SET", "stw:charter", JSON.stringify(charterSeed)]]);
      return res.status(200).json({ ok: true, version: charterSeed.version, laws: charterSeed.laws.length });
    }

    // ---- THE LIVING CHARTER: promote a proven lesson into binding law ----
    // The ten seeded laws are themselves graduated lessons. This lets an important
    // model note or ledger entry be ELEVATED to Charter law, where it binds every
    // future proposal with full weight, not merely as one lesson the Stable reads.
    // Deliberate and user-driven, like a precedent signed into common law. Appends
    // only; a mistaken promotion is repealed by marking it, never by silent erasure.
    if (action === "charterpromote") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const title = String(body.title || "").trim();
      const rule = String(body.rule || "").trim();
      if (!title || !rule)
        return res
          .status(422)
          .json({ error: "title and rule are required to enact a law" });
      if (title.length > 200 || rule.length > 4000)
        return res.status(422).json({ error: "title or rule too long" });

      const ch = await getCharter();
      // custom laws get a stable id and provenance
      const existingCustom = (ch.laws || []).filter((l) =>
        String(l.id || "").startsWith("custom-")
      ).length;
      const id = "custom-" + (existingCustom + 1);
      const law = {
        id,
        title,
        rule,
        origin:
          "Promoted to Charter " +
          new Date().toISOString().slice(0, 10) +
          (body.fromLedgerSeq ? " from Model Ledger #" + body.fromLedgerSeq : " by you") +
          (body.why ? " — " + String(body.why).slice(0, 300) : ""),
        enacted: new Date().toISOString(),
        custom: true,
      };
      ch.laws = ch.laws || [];
      ch.laws.push(law);
      ch.version = (ch.version || "charter-1") + "+" + id;
      const str = JSON.stringify(ch);
      const { verify, allMatch } = await writeVerified({ "stw:charter": str });
      // also record the enactment in the Model Ledger, so the two stay in step
      try {
        const [lRaw] = await redis([["GET", "stw:ledger"]]);
        const entries = lRaw ? JSON.parse(lRaw) : [];
        const seq = entries.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
        entries.push({
          seq,
          at: new Date().toISOString(),
          kind: "rule",
          change: "Enacted Charter law: " + title,
          why:
            "Promoted from lesson to binding Charter law. " +
            (body.why || "") +
            (body.fromLedgerSeq ? " (from ledger #" + body.fromLedgerSeq + ")" : ""),
          before: "",
          after: rule,
          author: "you",
          correctsSeq: null,
        });
        await redis([["SET", "stw:ledger", JSON.stringify(entries)]]);
      } catch (e) {
        /* ledger mirroring is best-effort; the Charter write is the source of truth */
      }
      return res.status(200).json({
        ok: allMatch,
        law,
        totalLaws: ch.laws.length,
        verify,
      });
    }

    if (action === "charterlaws") {
      const ch = await getCharter();
      return res.status(200).json({
        version: ch.version,
        count: (ch.laws || []).length,
        laws: (ch.laws || []).map((l) => ({
          id: l.id,
          title: l.title,
          rule: l.rule,
          origin: l.origin || "",
          custom: !!l.custom,
          repealed: !!l.repealed,
        })),
      });
    }

    // ---- LIVE CHARTER HEALTH: current figures beside the founding rationale ----
    // Founding text is never altered. This computes, from the live book, how each law's
    // underlying pattern is performing now, with sample sizes and a then-vs-now drift note.
    if (action === "charterhealth") {
      const [logRaw] = await redis([["GET", "stw:betlog"]]);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const health = charterHealth(log);
      const out = {};
      Object.keys(health).forEach((id) => {
        const h = health[id];
        out[id] = { ...h, drift: charterDrift(h, 20) };
      });
      return res.status(200).json({ ok: true, health: out, generatedAt: new Date().toISOString() });
    }

    if (action === "charterrepeal") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const id = String(body.id || "").trim();
      if (!id.startsWith("custom-"))
        return res
          .status(422)
          .json({ error: "Only promoted (custom-) laws may be repealed; the ten founding laws are permanent." });
      const ch = await getCharter();
      const law = (ch.laws || []).find((l) => l.id === id);
      if (!law) return res.status(404).json({ error: "No law " + id });
      law.repealed = true;
      law.repealedAt = new Date().toISOString();
      law.repealReason = String(body.why || "").slice(0, 300);
      const str = JSON.stringify(ch);
      const { verify, allMatch } = await writeVerified({ "stw:charter": str });
      return res.status(200).json({ ok: allMatch, repealed: id, verify });
    }

    // ---- THE CHARTER ADVOCATE: recommend promotions and repeals from proven patterns ----
    // Reads the recent settled history across MULTIPLE days, the standing Charter, and the
    // ledger lessons, then argues for any lesson that has proven itself enough to become
    // binding law, or any promoted law the evidence has turned against. It RECOMMENDS ONLY,
    // with its reasoning and the evidence; the user enacts or repeals with a deliberate tap.
    if (action === "charterrecommend") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      if (!AK)
        return res
          .status(500)
          .json({ error: "ANTHROPIC_API_KEY missing (the advocate needs it)" });

      const [logRaw, ledRaw] = await redis([
        ["GET", "stw:betlog"],
        ["GET", "stw:ledger"],
      ]);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const ledger = ledRaw ? JSON.parse(ledRaw) : [];
      const ch = await getCharter();

      const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
      const r2 = (v) => Math.round(num(v) * 100) / 100;
      const normResult = (v) => {
        const s = String(v == null ? "" : v).trim().toLowerCase();
        return s === "loss" ? "lose" : s;
      };
      const dkey = (d) => {
        const p = String(d || "").split("/");
        return p.length === 3 ? p[2] + p[1] + p[0] : "";
      };
      const regionOf = (meet) => {
        const s = String(meet || "").toLowerCase();
        if (s.includes("south africa")) return "South Africa";
        if (s.includes("france")) return "France";
        if (s.includes("united kingdom") || s.includes("ireland")) return "UK/IRE";
        if (s.includes("australia")) return "Australia";
        if (s.includes("hong kong")) return "Hong Kong";
        if (s.includes("japan")) return "Japan";
        if (s.includes("singapore")) return "Singapore";
        if (s.includes("korea")) return "Korea";
        if (s.includes("malaysia") || s.includes("selangor")) return "Malaysia";
        if (s.includes("turkey") || s.includes("t\u00fcrkiye")) return "Turkey";
        if (s.includes("germany")) return "Germany";
        if (s.includes("united states") || s.includes("usa")) return "USA";
        // Ledger short codes: the betlog stores meets as SA/FR/UK/MB/AU/PE/SK/JP/TK/MY/DE,
        // not full venue strings. Without this map every settled leg fell into "Other"
        // and the evidence block fed the model a by-region table that was mostly blind.
        const codes = { sa:"South Africa", fr:"France", uk:"UK/IRE", mb:"Australia", au:"Australia", pe:"Australia", sk:"Korea", jp:"Japan", tk:"Turkey", my:"Malaysia", de:"Germany", hk:"Hong Kong" };
        if (codes[s]) return codes[s];
        return "Other";
      };

      // settled model legs only, most recent ~10 distinct days of evidence
      const settled = log.filter(
        (b) =>
          String(b.ledger || "").trim().toLowerCase() === "model" &&
          ["win", "place", "lose"].includes(normResult(b.result))
      );
      const days = [...new Set(settled.map((b) => b.date))].sort((a, b) =>
        dkey(b).localeCompare(dkey(a))
      );
      const recentDays = new Set(days.slice(0, 10));
      const recent = settled.filter((b) => recentDays.has(b.date));

      const agg = (legs) => {
        const staked = r2(legs.reduce((a, b) => a + num(b.stake), 0));
        const payout = r2(legs.reduce((a, b) => a + num(b.payout), 0));
        return {
          n: legs.length,
          staked,
          payout,
          net: r2(payout - staked),
          roi: staked ? Math.round(((payout - staked) / staked) * 1000) / 10 : 0,
          cashed: legs.filter((b) => num(b.payout) > 0).length,
        };
      };
      // by region, across the recent window and how many distinct days each appeared
      const byRegion = {};
      recent.forEach((b) => {
        const rg = regionOf(b.meet);
        (byRegion[rg] = byRegion[rg] || []).push(b);
      });
      const regionLines = Object.keys(byRegion).map((rg) => {
        const legs = byRegion[rg];
        const daySpan = new Set(legs.map((l) => l.date)).size;
        const a = agg(legs);
        return rg + ": " + a.n + " legs over " + daySpan + " days, net $" + a.net + " (" + a.roi + "% ROI), " + a.cashed + " cashed";
      });
      // by bet type
      const winA = agg(recent.filter((b) => String(b.betType).trim() === "WIN"));
      const plaA = agg(recent.filter((b) => String(b.betType).trim() === "PLA"));
      // by confidence band
      const byConf = {};
      recent.forEach((b) => {
        const c = String(b.confidence).trim() === "Med-High" ? "Medium-High" : (String(b.confidence).trim() || "(none)");
        (byConf[c] = byConf[c] || []).push(b);
      });
      const confLines = Object.keys(byConf).map((c) => {
        const a = agg(byConf[c]);
        return c + ": " + a.n + " legs, " + a.roi + "% ROI";
      });
      // PHASE 5.2 (OVERHAUL.md): ROI by price band and field size. These read the
      // legDiv/fieldSize fields the Phase 5.1 settle upgrade captures, so they render
      // "(none recorded yet)" until settled legs with price data accumulate — that is
      // expected, not broken. This is how the model learns "PLA under $1.40 never
      // pays" from its own ledger instead of a hard-coded rule.
      const bandOf = (b) => {
        const dv = parseFloat(b.legDiv);
        if (!isFinite(dv) || dv <= 0) return null;
        return dv < 1.4 ? "<$1.40" : dv < 1.8 ? "$1.40-1.79" : dv < 2.5 ? "$1.80-2.49" : "$2.50+";
      };
      const byBand = {};
      recent.forEach((b) => { const k = bandOf(b); if (k) (byBand[k] = byBand[k] || []).push(b); });
      const bandLines = ["<$1.40", "$1.40-1.79", "$1.80-2.49", "$2.50+"]
        .filter((k) => byBand[k])
        .map((k) => { const a = agg(byBand[k]); return k + ": " + a.n + " legs, " + a.roi + "% ROI"; });
      const fsOf = (b) => {
        const f = parseInt(b.fieldSize, 10);
        if (!(f >= 2)) return null;
        return f <= 8 ? "<=8 runners" : f <= 11 ? "9-11 runners" : "12+ runners";
      };
      const byFs = {};
      recent.forEach((b) => { const k = fsOf(b); if (k) (byFs[k] = byFs[k] || []).push(b); });
      const fsLines = ["<=8 runners", "9-11 runners", "12+ runners"]
        .filter((k) => byFs[k])
        .map((k) => { const a = agg(byFs[k]); return "field " + k + ": " + a.n + " legs, " + a.roi + "% ROI"; });

      // current promoted laws (candidates for repeal) and lesson themes (candidates for promotion)
      const promoted = (ch.laws || []).filter((l) => l.custom && !l.repealed);
      const promotedText = promoted.length
        ? promoted.map((l) => l.id + ": " + l.title + " — " + l.rule).join("\n")
        : "(none yet)";
      const ledgerThemes = ledger
        .filter((e) => !e.correctsSeq)
        .slice(-14)
        .map((e) => "#" + e.seq + " [" + e.kind + "] " + e.change + (e.why ? " (" + e.why + ")" : ""));

      // founding-law drift: live figures vs the figures each law was enacted on
      const health = charterHealth(log); // full book, so like-for-like with founding figures
      const foundingById = {};
      (ch.laws || []).forEach((l) => { foundingById[l.id] = l; });
      const driftLines = [];
      Object.keys(health).forEach((id) => {
        const d = charterDrift(health[id], 20);
        if (d) {
          const law = foundingById[id];
          driftLines.push(
            (law ? law.title : id) + " [" + id + "]: " + d.text + " \u2014 the law has " + d.direction
          );
        }
      });

      const system =
        "You are the Charter advocate for The Outsider Method, a disciplined horse-racing staking model. " +
        "The Charter is the body of binding law every betlist must obey. It should evolve like common-law precedent: " +
        "a lesson is elevated to law ONLY once it has proven itself across MULTIPLE days, not on a single result, because a law that overfits to noise corrupts the whole method. " +
        "You RECOMMEND promotions and repeals; you never enact them. Be rigorous and sparing. Most reviews should recommend NOTHING: " +
        "an ordinary stretch where the standing laws are working needs no change. Only advocate a PROMOTION when a pattern is genuinely recurring and materially affects returns, " +
        "and only advocate a REPEAL of an existing promoted law when recent evidence has clearly turned against the very pattern it was enacted to capture. " +
        "You may ALSO note when a FOUNDING law's live figures have drifted materially from the figures it was enacted on \u2014 these are observations for the user to review, NOT repeals (founding laws are permanent and can only be amended by the user's own hand). " +
        "Never invent figures; reason only from the evidence given.";

      const prompt =
        "THE STANDING CHARTER (founding + promoted laws):\n" + charterText(ch) +
        "\n\nPROMOTED LAWS currently in force (these, and only these, may be recommended for repeal):\n" + promotedText +
        "\n\nFOUNDING-LAW DRIFT (live figures vs enactment figures; observations only, never repeals):\n  " +
          (driftLines.length ? driftLines.join("\n  ") : "(no founding law has drifted materially)") +
        "\n\nRECENT LEDGER LESSONS (candidate themes for promotion):\n- " + (ledgerThemes.length ? ledgerThemes.join("\n- ") : "(none)") +
        "\n\nEVIDENCE — last " + recentDays.size + " settled days (" + recent.length + " model legs):" +
        "\nBy region:\n  " + (regionLines.join("\n  ") || "(none)") +
        "\nWIN book: " + JSON.stringify(winA) +
        "\nPLA book: " + JSON.stringify(plaA) +
        "\nBy confidence:\n  " + (confLines.join("\n  ") || "(none)") +
        "\nBy price band (legDiv on settled legs):\n  " + (bandLines.join("\n  ") || "(none recorded yet \u2014 price capture began 19/07/2026)") +
        "\nBy field size:\n  " + (fsLines.join("\n  ") || "(none recorded yet)") +
        "\n\nReview whether the Charter should evolve. Respond with ONLY minified JSON, no fences, exactly:\n" +
        '{"summary":"1-2 sentence read of whether the Charter needs to evolve right now",' +
        '"promotions":[{"title":"short law title","rule":"the full binding rule","why":"the multi-day evidence justifying elevation to law","fromLedgerSeq":0}],' +
        '"repeals":[{"id":"custom-N","why":"the recent evidence that has turned against this law"}],' +
        '"foundingObservations":[{"id":"law-id","note":"how this founding law has drifted and what the user might consider"}]}';

      const cr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": AK,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 3000,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!cr.ok) {
        const t = await cr.text();
        return res.status(502).json({ error: "Claude HTTP " + cr.status + ": " + t.slice(0, 200) });
      }
      const cj = await cr.json();
      const text = (cj.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch (e) {
        return res.status(502).json({ error: "Advocate reply was not clean JSON: " + text.slice(0, 200) });
      }
      // validate the recommendations against reality: repeals must name real promoted laws
      const promotedIds = new Set(promoted.map((l) => l.id));
      const promotions = (Array.isArray(parsed.promotions) ? parsed.promotions : [])
        .filter((p) => p && String(p.title || "").trim() && String(p.rule || "").trim())
        .map((p) => ({
          title: String(p.title).trim().slice(0, 200),
          rule: String(p.rule).trim().slice(0, 4000),
          why: String(p.why || "").trim().slice(0, 1000),
          fromLedgerSeq: parseInt(p.fromLedgerSeq, 10) || null,
        }));
      const repeals = (Array.isArray(parsed.repeals) ? parsed.repeals : [])
        .filter((r) => r && promotedIds.has(String(r.id).trim()))
        .map((r) => ({
          id: String(r.id).trim(),
          title: (promoted.find((l) => l.id === String(r.id).trim()) || {}).title || "",
          why: String(r.why || "").trim().slice(0, 1000),
        }));
      // founding-law observations: only for real founding laws that actually drifted
      const foundingIds = new Set((ch.laws || []).filter((l) => !l.custom).map((l) => l.id));
      const foundingObservations = (Array.isArray(parsed.foundingObservations) ? parsed.foundingObservations : [])
        .filter((o) => o && foundingIds.has(String(o.id).trim()) && charterDrift(health[String(o.id).trim()], 20))
        .map((o) => {
          const id = String(o.id).trim();
          const law = foundingById[id];
          const d = charterDrift(health[id], 20);
          return {
            id,
            title: law ? law.title : id,
            note: String(o.note || "").trim().slice(0, 1000),
            drift: d ? d.text : "",
          };
        });

      const result = {
        ok: true,
        summary: String(parsed.summary || "").trim(),
        daysReviewed: recentDays.size,
        legsReviewed: recent.length,
        promotions,
        repeals,
        foundingObservations,
        nothingToDo: promotions.length === 0 && repeals.length === 0 && foundingObservations.length === 0,
        generatedAt: new Date().toISOString(),
      };
      await redis([["SET", "stw:charterrec:latest", JSON.stringify(result)]]);
      return res.status(200).json(result);
    }

    if (action === "run") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      if (!AK)
        return res
          .status(500)
          .json({ error: "ANTHROPIC_API_KEY missing (the brain needs it)" });
      const body = parseBody(req);

      // fetch the pack
      let packKey;
      if (body.date) packKey = "stw:pack:" + String(body.date).replace(/\//g, "");
      else {
        const [latest] = await redis([["GET", "stw:pack:latest"]]);
        packKey = latest;
      }
      if (!packKey)
        return res.status(409).json({ error: "No morning pack. Run the Tout first." });
      const [packRaw] = await redis([["GET", packKey]]);
      if (!packRaw)
        return res.status(404).json({ error: "Pack not found for that date." });
      const pack = JSON.parse(packRaw);
      if (!pack.meets || !pack.meets.length)
        return res.status(422).json({
          error: "The gate left no meets to bet — nothing to propose today.",
          date: pack.date,
          deselected: pack.deselected || [],
        });

      const ch = await getCharter();
      const lessons = await recentLessons();

      const system =
        "You are the analytical engine of The Outsider Method, a disciplined horse-racing staking model run by Hammy. " +
        "You build a proposed betlist for the day from a morning intelligence pack. You are rigorous, honest, and you obey the Charter absolutely — it is a month of hard-won, loss-tested law. " +
        "You do NOT chase winners; a short, selective book is success, not timidity. " +
        "CALIBRATION UPDATE (16/07/2026, rule-decay audit on 429 settled legs) — the following were RETIRED and must NOT be treated as proven: (a) \"WIN bleeds ~2x PLA\" has INVERTED (WIN -14.5%, PLA -18.6%, ratio 0.78x), so do NOT trim WIN legs on that reasoning; (b) \"Medium-High is the only green band\" DECAYED (+19.2% on 19 legs in-sample, -17.6% on 110 legs out-of-sample, -13.4% combined), so Medium-High must NOT bias selection. Both were promoted on samples one to two orders of magnitude too small. " +
        "WHAT SURVIVES: flat staking (confidence is a gauge, never a throttle), and the inverted ladder (High is still the worst WIN band at -19.1%). What the evidence actually supports is BEING PICKIER, not a bet type: after 26/06 WIN improved (-19.6% to -9.8%) as WIN legs were cut to the cleanest spots, while PLA worsened (-9.4% to -22.2%) as place legs were expanded. Fewer, better legs on either pool. Do NOT read that as \"go WIN-heavy\" — that is the same one-window reasoning that produced the retired Medium-High rule. " +
        "Every horse number you cite MUST come from the runner map in the pack (the SGPools coupon card). If you cannot confirm a number there, flag it UNCONFIRMED. Never invent a number from tipster ordering. " +
        "THE SGPools RACE CARD IS THE SINGLE SOURCE OF TRUTH. The runner map in this pack IS that card, fetched from SGPools itself. It is the ONLY authority for what is running, in which race, under which number, on which day. Every tip source — Gold Circle, Race Coast, Racenet, Timeform, all of them — is a SECONDARY OPINION that must be verified back against the card before you may act on a single word of it. A source is not evidence because it is confident, detailed or well known. It is evidence only if the card agrees it is talking about today's meeting. " +
        "VERIFY ON EVERY FIELD: date, meet, venue, race number, horse number, horse name. All six. A preview may be genuine journalism about a real meeting and still be useless here because it is the wrong day or the wrong course. " +
        "THE METHOD, WHICH IS NOT OPTIONAL: form your view from the sources, then take the horse NAME and FIND IT IN THE RUNNER MAP. Use the race number and horse number the RUNNER MAP gives it. NEVER carry a race number or a horse number across from a preview — press sources number races within their own venue and their own card, and those numbers routinely mean something completely different on the SGPools coupon. If the name is not in the runner map, the horse is not bettable here: drop the leg or flag it UNCONFIRMED. Do not guess. " +
        "WHY THIS IS WRITTEN SO FORCEFULLY: on 17/07/2026 the trawl served a Gold Circle tipsheet for a Durbanville meeting SGPools was not carrying, and Race Coast previews for 18/07 and 19/07 — because no source had published anything for that day's actual SA card. The model read them as today's homework. Not one of the six tipped horses appeared anywhere on the SGPools SA card and five of six race distances disagreed, yet six legs were staked on horses nobody had analysed. Every one of those sources fetched perfectly. Fetching a source is not the same as the source being about the meeting you can bet. " +
        "A source marked WITHHELD in this pack failed that verification. Its content is deliberately absent. Do not speculate about what it might have said and do not select from the meet on its strength. A meet marked with an SSOT blind warning has NO verified analysis today: take nothing from it. A short, honest book beats a confident one built on another day's racing.";

      const prompt =
        "THE CHARTER (immovable law):\n" + charterText(ch) +
        "\n\nOUTPUT CONTRACT:\n" +
        "slipFormat: " + ch.outputContract.slipFormat + "\n" +
        "mustInclude: " + ch.outputContract.mustInclude + "\n" +
        "restraint: " + ch.outputContract.restraint +
        (lessons.length ? "\n\nRECENT LESSONS (learn from the graded record):\n- " + lessons.join("\n- ") : "") +
        "\n\nMORNING PACK:\n" + packBrief(pack) +
        "\n\nPHASE 2 OVERHAUL LAW (19/07/2026, OVERHAUL.md \u2014 ENFORCED IN CODE, not requests):\n" +
        "1. ZERO legs from any meet with zero verified external sources. SGPools internal docs alone are SGPools agreeing with itself, not convergence. Any such leg will be vetoed.\n" +
        "2. NEVER propose a PLA leg on the consensus #1 pick of a race. The unanimous top pick is where the $1.10-1.30 place dividends live (60% of all historical PLA collects, book-killing). Declare consensusTop honestly on every leg; a PLA leg with consensusTop=true will be vetoed. If you love a race that strongly, the allowed shapes are: the #2-ranked convergence horse PLA, or the consensus pick WIN-only.\n" +
        "3. NO PLA legs in fields of 8 or fewer runners. Three places in a tiny field breeds odds-on dividends. Vetoed in code.\n" +
        "4. Confidence labels are BINARY from the era's start: Standard (normal-conviction read) or Speculative (reasoned long shot). The four-band system is retired \u2014 across 479 settled legs its cash rates were 53/52/54/42, flat noise. The label is a pure gauge: no stake, no volume rights. Legacy labels (Medium, Low-Med) are still vetoed in code if emitted.\n" +
        "5. PER-MEET LEG CAPS tied to verified external source count: 0 sources = 0 legs, 1 source = 2 legs max, 2+ sources = 4 legs max. Order each meet's legs BEST FIRST \u2014 the cap keeps the first N and vetoes the rest.\n" +
        "A short book is the honest outcome. Every vetoed leg is logged and shown; proposing legs that will be vetoed is worse than not proposing them.\n" +
        "\nPHASE 4 CONVERGENCE INVERSION (OVERHAUL.md):\n" +
        "Structure every race read as ANCHOR vs VALUE TIER. The consensus #1 across sources is the MARKET ANCHOR: it tells you where the crowd's money is crushed, and it is NOT the default bet \u2014 in a parimutuel pool the most agreed-upon horse is by construction the most overbet one. The bettable tier is the horse(s) ranked 2nd-3rd by your QUALITY sources. Weight source QUALITY, not count: a named analyst's reasoned case outweighs three syndicated tips repeating each other, which are ONE opinion wearing three hats.\n" +
        "Legs must come from the value tier. The anchor may be proposed WIN-ONLY, and only with an explicit case in the reason for why the market still underestimates it. Anchor PLA legs are vetoed in code.\n" +
        "Declare your read per race in raceReads, and tag every leg with tier: anchor | value | lone.\n" +
        "\n\nNow produce the betlist. Respond with ONLY minified JSON, no markdown fences, exactly:\n" +
        '{"dayShape":"2-3 sentence summary: meets in play, WIN vs PLA lean, any Trio, overall stance",' +
        '"legs":[{"meet":"","region":"","raceNo":0,"horseNo":0,"horseName":"","betType":"WIN|PLA|TRIO","stake":10,"confidence":"Standard|Speculative","reason":"convergence read: which sources agree and why","tier":"anchor|value|lone","consensusTop":false,"unconfirmed":false}],' +
        '"raceReads":[{"meet":"","raceNo":0,"anchor":"consensus #1 horse name","valueTier":["horse names ranked 2nd-3rd by quality sources"],"note":"one-line read of the race shape"}],' +
        '"trioNote":"if a Trio is proposed, the frame and why; else empty",' +
        '"sourcesChecked":{"MeetName":["source ids used"]},' +
        '"skipped":[{"meet":"","why":"why no or few legs here"}]}';

      // ---- PHASE 3.1/3.3 (OVERHAUL.md): refresh prices at PROPOSE time ----
      // The 8am trawl runs at 03:00 Paris — pools shut, no odds exist yet. So the
      // price sweep happens here, when the book is actually being built. Shadow
      // mode: prices are logged and verdicted but NEVER gate the book this week.
      // A failed sweep must never block a proposal, hence the swallow-and-continue.
      const PRICES_BASE =
        "https://" +
        (process.env.VERCEL_PROJECT_PRODUCTION_URL ||
          process.env.VERCEL_URL ||
          "vibe-arcade-omega.vercel.app");
      let pricedPack = null;
      try {
        const pctrl = new AbortController();
        const pt = setTimeout(() => pctrl.abort(), 70000);
        await fetch(
          PRICES_BASE + "/api/trawl?action=prices&date=" + encodeURIComponent(pack.date),
          { signal: pctrl.signal }
        );
        clearTimeout(pt);
        const [praw] = await redis([["GET", "stw:pack:" + pack.date.replace(/\//g, "")]]);
        pricedPack = praw ? JSON.parse(praw) : null;
      } catch (e) { /* shadow only — a missing price sweep never blocks the book */ }

      const cr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": AK,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!cr.ok) {
        const t = await cr.text();
        return res
          .status(502)
          .json({ error: "Claude HTTP " + cr.status + ": " + t.slice(0, 200) });
      }
      const cj = await cr.json();
      const text = (cj.content || [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch (e) {
        return res
          .status(502)
          .json({ error: "Brain reply was not clean JSON: " + text.slice(0, 200) });
      }

      // ---- Charter enforcement in code: the brain proposes, the law disposes ----
      const legs = Array.isArray(parsed.legs) ? parsed.legs : [];
      const corrections = [];
      const clean = [];
      // build a runner-map index for card-match verification
      const { cardIndex, extCount, fieldSizeOf } = meetIndexes(pack);
      // Legs whose meet label could not be tied to a coupon. Surfaced in the response and
      // vetoed below — an unresolvable label must be loud, never five quiet zeros.
      const meetErrors = [];

      for (const raw of legs) {
        const leg = {
          meet: String(raw.meet || "").trim(),
          region: String(raw.region || "").trim(),
          raceNo: parseInt(raw.raceNo, 10),
          horseNo: raw.horseNo == null ? "" : String(raw.horseNo).trim(),
          horseName: String(raw.horseName || "").trim(),
          betType: String(raw.betType || "").trim().toUpperCase(),
          confidence: String(raw.confidence || "").trim(),
          reason: String(raw.reason || "").trim(),
          tier: String(raw.tier || "").trim().toLowerCase(),
          // Phase 4 normalisation: a leg tagged tier=anchor IS the consensus pick,
          // whatever the model set consensusTop to. One signal, no contradictions.
          consensusTop: !!raw.consensusTop || String(raw.tier || "").trim().toLowerCase() === "anchor",
          unconfirmed: !!raw.unconfirmed,
        };
        // LAW: flat stake, enforced regardless of what the model said
        if (leg.betType === "WIN") leg.stake = 10;
        else if (leg.betType === "PLA") leg.stake = 5;
        else if (leg.betType === "TRIO") leg.stake = 6;
        else {
          corrections.push("dropped a leg with unknown bet type '" + leg.betType + "'");
          continue;
        }
        if (parseInt(raw.stake, 10) && parseInt(raw.stake, 10) !== leg.stake)
          corrections.push(
            leg.horseName + " " + leg.betType + " stake corrected to flat $" + leg.stake
          );
        // RESOLVE THE MEET FIRST. `leg.meet` stays exactly as the model wrote it (it is the
        // course name, which is what a human wants to read on the slip); `leg.venue` is the
        // pack's coupon container, and it is what every meet-keyed lookup below uses.
        const rv = resolveMeet(leg.meet, pack.meets);
        leg.venue = rv.venue;
        leg.venueHow = rv.how || null;
        if (!rv.venue) {
          leg.unconfirmed = true;
          leg.meetUnresolved = rv.why;
          meetErrors.push({
            meet: leg.meet, raceNo: leg.raceNo, horseNo: leg.horseNo,
            horseName: leg.horseName, betType: leg.betType, why: rv.why,
          });
          corrections.push(
            "UNRESOLVED MEET — " + leg.horseName + " (R" + leg.raceNo + " #" + leg.horseNo +
            " " + leg.meet + "): " + rv.why + ". The leg cannot be card-matched or gated " +
            "against a coupon, so it is vetoed rather than guessed at."
          );
        }
        // LAW: card-match — verify the number against the runner map
        const key = leg.venue + "|" + leg.raceNo + "|" + leg.horseNo;
        if (leg.betType !== "TRIO" && leg.venue) {
          if (cardIndex[key] == null) {
            leg.unconfirmed = true;
            corrections.push(
              leg.horseName + " (R" + leg.raceNo + " #" + leg.horseNo + " " + leg.meet + ") could not be matched to the runner map — flagged UNCONFIRMED, verify on SGPools before placing"
            );
          } else if (leg.horseName) {
            const norm = (s) =>
              String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
            const cardName = cardIndex[key];
            if (norm(cardName) !== norm(leg.horseName)) {
              // A NAME MISMATCH IS NOT A TYPO. It is proof that the model's race/horse
              // NUMBER does not mean what the model thought it meant.
              //
              // SGPools INTEGRATES several venues into one renumbered sequence per meet
              // (SA = Turffontein + Durbanville merged into Race 1-17 under one Code).
              // Gold Circle, Race Coast and every press preview number races within their
              // OWN venue. So "Durbanville R6 #1 = Sooty" and "SGPools SA R6 #1 = Fairy
              // Knight" are both true and refer to DIFFERENT RACES.
              //
              // The old code took the card name as authoritative and overwrote the model's
              // name, keeping the number. That produced a leg headed "R6 #1 FAIRY KNIGHT"
              // whose reasoning discussed Sooty — and since the slip is built from the
              // number, it would have put real money on a horse nobody analysed. Silently
              // repairing the symptom made the fatal error invisible.
              //
              // Now: keep BOTH names, keep the model's own name in the leg so the heading
              // and the reasoning cannot contradict each other, and flag UNCONFIRMED so it
              // must be checked on the SGPools card before it is ever staked.
              leg.unconfirmed = true;
              leg.cardName = cardName;
              corrections.push(
                "NUMBERING MISMATCH — DO NOT PLACE UNCHECKED: the model picked '" +
                  leg.horseName + "' as R" + leg.raceNo + " #" + leg.horseNo + " " + leg.meet +
                  ", but the SGPools card says #" + leg.horseNo + " in that race is '" + cardName +
                  "'. These are different horses, which means the source's race numbering does not " +
                  "match the SGPools integrated card (SGPools merges venues and renumbers; press " +
                  "previews number within their own venue). Find '" + leg.horseName +
                  "' on the SGPools card and use ITS integrated race and horse number, or drop the leg. " +
                  "Flagged UNCONFIRMED."
              );
            }
          }
        }
        clean.push(leg);
      }

      // ---- PHASE 2 OVERHAUL GATES (OVERHAUL.md, 19/07/2026) ----
      // The brain proposes, the law disposes \u2014 and after the Med-High label-creep
      // lesson (36%\u219260% share, band inverted to -17.6% over 199 legs), the law no
      // longer lives in the prompt alone. Prompt instructions are requests; these are
      // gates. Every rejection is logged to `vetoes` so the morning reader sees
      // exactly what the law cut and why. A short book is the honest outcome.
      const vetoes = [];
      // extCount / fieldSizeOf come from meetIndexes(pack) above, keyed on the pack's venue \u2014
      // and are read below via leg.venue, the resolved coupon, never the raw label.
      // caps: 0 sources = 0 legs, 1 source = 2 legs, 2+ sources = 4 legs (OVERHAUL 2.5)
      const capFor = (n) => (n <= 0 ? 0 : n === 1 ? 2 : 4);
      const perMeetKept = {};
      const gated = [];
      for (const leg of clean) {
        const veto = (rule, why) =>
          vetoes.push({
            meet: leg.meet, venue: leg.venue || null, raceNo: leg.raceNo, horseNo: leg.horseNo,
            horseName: leg.horseName, betType: leg.betType, rule, why,
          });
        // LOUD FAILURE FIRST. A leg whose meet label could not be tied to a coupon must not
        // reach the gates below: every one of them would read a zero and either wave it
        // through (the field-size floor) or condemn it for the wrong reason (no-external-
        // source). Neither is honest, and the second is what made this bug look like normal
        // operation for as long as it did.
        if (!leg.venue) {
          veto("unresolved-meet", leg.meetUnresolved || "meet label could not be resolved to a pack venue");
          continue;
        }
        const ext = extCount[leg.venue] || 0;
        // 2.1 stand-down: no verified external convergence = no bet, any bet type
        if (ext === 0) {
          veto("no-external-source",
            "meet has zero verified external sources \u2014 internal-only convergence is SGPools agreeing with itself");
          continue;
        }
        // 2.4 confidence bands: Medium and Low-Med are cut entirely
        const conf = leg.confidence.toLowerCase();
        if (conf === "medium" || conf === "low-med" || conf === "low") {
          veto("confidence-band-cut",
            "Medium/Low-Med band vetoed (Medium ran -32.9% over the last window; band cut per OVERHAUL 2.4)");
          continue;
        }
        if (leg.betType === "PLA") {
          // 2.3 field-size floor: no places in fields of 8 or fewer
          const fs = fieldSizeOf[leg.venue + "|" + leg.raceNo] || 0;
          if (fs > 0 && fs <= 8) {
            veto("pla-small-field",
              "PLA in a " + fs + "-runner field \u2014 three places in tiny fields breeds odds-on dividends (floor is 9+)");
            continue;
          }
          // 2.2 anti-consensus: never place-bet the crowd's top pick
          if (leg.consensusTop) {
            veto("pla-consensus-top",
              "PLA on the consensus #1 pick \u2014 the $1.10-1.30 dividend generator (60% of historical PLA collects). Allowed shapes: #2 convergence horse PLA, or this horse WIN-only");
            continue;
          }
        }
        // daily-cap (Charter law, 19/07/2026): ten legs across all meets, full stop.
        // Enacted on the chasing fingerprint (19.1 legs after red days vs 17.2 after
        // green) and plain arithmetic: a negative-edge book bleeds with volume.
        if (gated.length >= 10) {
          veto("daily-cap",
            "the ten-leg daily ceiling is reached (Charter: daily-cap) \u2014 depth beats volume");
          continue;
        }
        // 2.5 per-meet cap by source depth (volume follows sources, not card size)
        const kept = perMeetKept[leg.venue] || 0;
        if (kept >= capFor(ext)) {
          veto("meet-cap",
            "meet cap reached (" + capFor(ext) + " legs for " + ext + " verified source" + (ext === 1 ? "" : "s") + ")");
          continue;
        }
        perMeetKept[leg.venue] = kept + 1;
        gated.push(leg);
      }

      const winCount = gated.filter((l) => l.betType === "WIN").length;
      const plaCount = gated.filter((l) => l.betType === "PLA").length;
      const trioCount = gated.filter((l) => l.betType === "TRIO").length;
      const staked = gated.reduce((a, l) => a + l.stake, 0);

      // ---- PHASE 3.3 SHADOW MODE (OVERHAUL.md): price verdicts, logged only ----
      // Floors: PLA projected div >= $1.60, WIN >= $2.50. During the shadow week
      // these verdicts DO NOT gate anything — the point is a clean week of
      // shadow-book vs actual-book evidence before a single dollar obeys a price.
      const priceIndex = priceIndexOf(pricedPack);
      const shadowOf = (leg) => {
        // keyed on the resolved venue; veto records carry it too, so both call sites below work
        const p = priceIndex[leg.venue + "|" + leg.raceNo + "|" + leg.horseNo];
        if (!p) return { verdict: "nodata" };
        if (leg.betType === "PLA")
          return { price: p, verdict: p.pla == null ? "nodata" : p.pla >= 1.6 ? "pass" : "fail" };
        if (leg.betType === "WIN")
          return { price: p, verdict: p.win == null ? "nodata" : p.win >= 2.5 ? "pass" : "fail" };
        return { price: p, verdict: "n/a" };
      };
      const shadowPrices = {
        mode: "shadow",
        note: "Price floors LOGGED ONLY this week (PLA >= $1.60, WIN >= $2.50); they do not gate the book.",
        pricesFetched: !!(pricedPack && pricedPack.prices),
        stats: pricedPack && pricedPack.prices
          ? {
              at: pricedPack.prices.at,
              matchedRaces: pricedPack.prices.matchedRaces,
              pricedRunners: pricedPack.prices.pricedRunners,
              errors: pricedPack.prices.errors,
            }
          : null,
        kept: gated.map((l) =>
          Object.assign(
            { meet: l.meet, raceNo: l.raceNo, horseNo: l.horseNo, horseName: l.horseName, betType: l.betType },
            shadowOf(l)
          )
        ),
        vetoed: vetoes.map((v) =>
          Object.assign(
            { meet: v.meet, raceNo: v.raceNo, horseNo: v.horseNo, horseName: v.horseName, betType: v.betType, rule: v.rule },
            shadowOf(v)
          )
        ),
      };

      // build the vault-ready JSON the Quill's paste lane accepts
      const quillPayload = {
        date: pack.date,
        legs: gated.map((l) => ({
          date: pack.date,
          meet: l.meet,
          raceNo: l.raceNo,
          horseNo: l.horseNo,
          horseName: l.horseName,
          betType: l.betType,
          stake: l.stake,
          confidence: l.confidence,
          ledger: l.betType === "TRIO" ? "Exotic" : "Model",
          reason: l.reason,
          notes: l.unconfirmed ? "UNCONFIRMED card-match — verify on SGPools" : "",
        })),
      };

      const result = {
        ok: true,
        date: pack.date,
        dayShape: parsed.dayShape || "",
        counts: { win: winCount, pla: plaCount, trio: trioCount, staked },
        legs: gated,
        trioNote: parsed.trioNote || "",
        sourcesChecked: parsed.sourcesChecked || {},
        raceReads: parsed.raceReads || [],
        skipped: parsed.skipped || [],
        corrections,
        // Legs whose meet label could not be tied to a coupon. Present and non-empty is a
        // REAL problem to look at — either the model invented a course or the pack changed
        // shape — and it is deliberately its own field rather than a line buried in
        // corrections, because the whole failure mode this fixes was one of invisibility.
        meetErrors,
        vetoes,
        shadowPrices,
        quillPayload,
        generatedAt: new Date().toISOString(),
      };
      // stash the latest proposal so the room can show it without re-spending tokens
      await redis([
        ["SET", "stw:proposal:" + pack.date.replace(/\//g, ""), JSON.stringify(result)],
        ["SET", "stw:proposal:latest", JSON.stringify(result)],
      ]);
      return res.status(200).json(result);
    }

    if (action === "latest") {
      const [raw] = await redis([["GET", "stw:proposal:latest"]]);
      if (!raw) return res.status(404).json({ error: "No proposal yet." });
      return res.status(200).json(JSON.parse(raw));
    }

    // ---- THE STEWARDS' NOTEBOOK: draft lessons from the settled day ----
    // Reads a settled day's book, computes its honest shape, and asks Claude to
    // draft proposed ledger entries. It PROPOSES only. Each drafted lesson is
    // reviewed and approved by the user, then written to the ledger with the
    // "approved" author badge through the normal ledgeradd path. Nothing here
    // ever writes to the ledger itself.
    if (action === "draftlessons") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      if (!AK)
        return res
          .status(500)
          .json({ error: "ANTHROPIC_API_KEY missing (the notebook needs it)" });
      const body = parseBody(req);

      const [logRaw, dRaw] = await redis([
        ["GET", "stw:betlog"],
        ["GET", "stw:daily"],
      ]);
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const daily = dRaw ? JSON.parse(dRaw) : [];

      // local numeric helpers, kept self-contained
      const num = (v) => {
        const n = parseFloat(v);
        return isFinite(n) ? n : 0;
      };
      const r2 = (v) => Math.round(num(v) * 100) / 100;
      const normResult = (v) => {
        const s = String(v == null ? "" : v).trim().toLowerCase();
        return s === "loss" ? "lose" : s;
      };
      const dkey = (d) => {
        const p = String(d || "").split("/");
        return p.length === 3 ? p[2] + p[1] + p[0] : "";
      };

      // pick the day: explicit date, else the most recent day that is fully settled
      let date = body.date ? String(body.date).trim() : null;
      if (!date) {
        const dates = [...new Set(log.map((b) => b.date))].sort((a, b) =>
          dkey(b).localeCompare(dkey(a))
        );
        for (const d of dates) {
          const model = log.filter(
            (b) =>
              b.date === d &&
              String(b.ledger || "").trim().toLowerCase() === "model"
          );
          if (!model.length) continue;
          const anyPending = model.some((b) => normResult(b.result) === "pending");
          if (!anyPending) {
            date = d;
            break;
          }
        }
      }
      if (!date)
        return res.status(409).json({
          error:
            "No fully settled day found to draft from. Settle the book first, then draft.",
        });

      const dayLegs = log.filter((b) => b.date === date);
      const model = dayLegs.filter(
        (b) => String(b.ledger || "").trim().toLowerCase() === "model"
      );
      const pending = model.filter((b) => normResult(b.result) === "pending");
      if (pending.length)
        return res.status(409).json({
          error:
            date +
            " still has " +
            pending.length +
            " pending legs. Settle the day fully before drafting lessons.",
          date,
        });

      // compute the honest shape of the day
      const settled = model.filter((b) =>
        ["win", "place", "lose"].includes(normResult(b.result))
      );
      const shapeOf = (legs) => {
        const staked = r2(legs.reduce((a, b) => a + num(b.stake), 0));
        const payout = r2(legs.reduce((a, b) => a + num(b.payout), 0));
        return {
          bets: legs.length,
          staked,
          payout,
          net: r2(payout - staked),
          roi: staked ? Math.round(((payout - staked) / staked) * 1000) / 10 : 0,
          cashed: legs.filter((b) => num(b.payout) > 0).length,
        };
      };
      const winLegs = settled.filter((b) => String(b.betType).trim() === "WIN");
      const plaLegs = settled.filter((b) => String(b.betType).trim() === "PLA");
      const byMeet = {};
      settled.forEach((b) => {
        (byMeet[b.meet] = byMeet[b.meet] || []).push(b);
      });
      const meetLines = Object.keys(byMeet).map((m) => {
        const s = shapeOf(byMeet[m]);
        return m + ": " + s.bets + " legs, net $" + s.net + " (" + s.roi + "% ROI)";
      });
      const blankedWin = winLegs
        .filter((b) => num(b.payout) === 0)
        .map((b) => b.horseName + " (" + b.meet + " R" + b.raceNo + ")");
      const landedWin = winLegs
        .filter((b) => num(b.payout) > 0)
        .map(
          (b) =>
            b.horseName +
            " ($" +
            num(b.stake) +
            "->$" +
            num(b.payout) +
            ")"
        );
      const conf = {};
      settled.forEach((b) => {
        const c =
          String(b.confidence).trim() === "Med-High"
            ? "Medium-High"
            : String(b.confidence).trim() || "(none)";
        conf[c] = conf[c] || { bets: 0, staked: 0, payout: 0 };
        conf[c].bets++;
        conf[c].staked += num(b.stake);
        conf[c].payout += num(b.payout);
      });
      const confLines = Object.keys(conf).map((c) => {
        const x = conf[c];
        const net = r2(x.payout - x.staked);
        const roi = x.staked ? Math.round((net / x.staked) * 1000) / 10 : 0;
        return c + ": " + x.bets + " legs, " + roi + "% ROI";
      });
      const dayRow = daily.find((d) => d.date === date) || {};
      const overall = shapeOf(settled);

      const ch = await getCharter();
      const lessons = await recentLessons();

      const brief = [
        "SETTLED DAY: " + date,
        dayRow.meets ? "Meets: " + dayRow.meets : "",
        "Overall (model legs): " +
          overall.bets +
          " bets, staked $" +
          overall.staked +
          ", net $" +
          overall.net +
          " (" +
          overall.roi +
          "% ROI), " +
          overall.cashed +
          " legs cashed.",
        "WIN book: " + JSON.stringify(shapeOf(winLegs)),
        "PLA book: " + JSON.stringify(shapeOf(plaLegs)),
        "By meet:\n  " + meetLines.join("\n  "),
        "Confidence bands (this day):\n  " + confLines.join("\n  "),
        landedWin.length ? "WIN legs that landed: " + landedWin.join(", ") : "No WIN legs landed.",
        blankedWin.length ? "WIN legs that blanked: " + blankedWin.join(", ") : "No WIN legs blanked.",
      ]
        .filter(Boolean)
        .join("\n");

      const system =
        "You are the notebook of The Outsider Method, a disciplined horse-racing staking model run by Hammy. " +
        "At night, after the day's book has settled, you read the results and draft honest lessons for the permanent Model Ledger. " +
        "You are rigorous and self-critical, never flattering. A lesson is worth recording only if it teaches something real: a pattern confirmed, a rule that held or failed, a genuine surprise. " +
        "On an ordinary day where the method simply did its job, it is correct and honest to draft NO lessons rather than manufacture one. Do not pad. Draw only on the data given; never invent figures. " +
        "The durable spine of the model is: flat staking (confidence is a gauge, not a throttle) and the inverted ladder (High is the worst WIN band). NOTE the 16/07/2026 rule-decay audit RETIRED two long-standing claims — \"WIN bleeds 2x PLA\" (now inverted, ratio 0.78x) and the Medium-High selection bias (-13.4% over 129 legs). Do not restate either as proven. A lesson that re-tests a retired claim against fresh evidence is valuable; a lesson that simply repeats it is not.";

      const prompt =
        "THE CHARTER (the model's current law, for context):\n" +
        charterText(ch) +
        (lessons.length
          ? "\n\nRECENT LESSONS ALREADY ON THE RECORD (do not repeat these):\n- " +
            lessons.join("\n- ")
          : "") +
        "\n\nTONIGHT'S SETTLED DAY:\n" +
        brief +
        "\n\nDraft any lessons this day genuinely teaches. Look in particular at the by-meet performance: " +
        "did certain meets or regions (South Africa, France, UK, Australia and so on) earn their place in the book, or drag it down? " +
        "A meet or region that repeatedly returns or bleeds is a signal for future TRIAGE and meet-selection, so if this day adds " +
        "genuine evidence on which meets deserve more or less weight, say so as a lesson of kind 'trial' or 'observation'. " +
        "Also weigh the WIN-versus-PLA split and the confidence bands against the standing model. " +
        "Be honest and self-critical, never padding: on an ordinary day where the method simply did its job, draft NO lessons. " +
        "Never invent figures; draw only on the data above. Respond with ONLY minified JSON, no markdown fences, exactly:\n" +
        '{"daySummary":"1-2 sentence honest read of how the day went",' +
        '"triageNote":"1 sentence on which meets/regions this day suggests favouring or fading in future selection, or empty if nothing clear",' +
        '"lessons":[{"kind":"observation|amendment|trial|rule","change":"the lesson, one clear sentence","why":"the evidence from THIS day supporting it"}],' +
        '"noLessonReason":"if lessons is empty, one sentence on why the day taught nothing new"}';

      const cr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": AK,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 3000,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!cr.ok) {
        const t = await cr.text();
        return res
          .status(502)
          .json({ error: "Claude HTTP " + cr.status + ": " + t.slice(0, 200) });
      }
      const cj = await cr.json();
      const text = (cj.content || [])
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      let parsed;
      try {
        parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch (e) {
        return res
          .status(502)
          .json({ error: "Notebook reply was not clean JSON: " + text.slice(0, 200) });
      }
      const drafted = (Array.isArray(parsed.lessons) ? parsed.lessons : [])
        .filter((l) => l && String(l.change || "").trim())
        .map((l) => ({
          kind: ["observation", "amendment", "trial", "rule"].includes(String(l.kind))
            ? String(l.kind)
            : "observation",
          change: String(l.change).trim().slice(0, 4000),
          why: String(l.why || "").trim().slice(0, 4000),
        }));

      const result = {
        ok: true,
        date,
        daySummary: parsed.daySummary || "",
        triageNote: String(parsed.triageNote || "").trim(),
        shape: {
          overall,
          win: shapeOf(winLegs),
          pla: shapeOf(plaLegs),
          meets: meetLines,
        },
        drafted,
        noLessonReason: drafted.length ? "" : parsed.noLessonReason || "The day taught nothing new.",
        generatedAt: new Date().toISOString(),
      };
      await redis([
        ["SET", "stw:draftlessons:latest", JSON.stringify(result)],
      ]);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

export default handler;

export {
  packBrief as _packBrief,
  charterText as _charterText,
  charterHealth as _charterHealth,
  charterDrift as _charterDrift,
  // the meet-resolution layer, exported so the safety suite drives the SHIPPED code
  resolveMeet,
  meetIndexes,
  priceIndexOf,
};

// ---- Vercel function configuration ----
// Declared here for the same reason as trawl.js: the vercel.json "functions" entry for
// this file was removed in d625ca5 while chasing a build failure, so ?action=run has
// been executing on the platform default while the client waited the full 120s for it
// (PROPOSE_MAX_MS in stewards.html). This is the endpoint where that gap bites hardest —
// a run does a price sweep with its own 70s budget and THEN a max_tokens 8000 Claude
// call, so it is the one most likely to be killed mid-flight and report a mystery.
//
// One source of truth, next to the code it bounds. If a vercel.json entry for this file
// is ever restored, note that for plain Node /api routes the in-code value wins, so the
// two must agree. Siblings: trawl 300s, stewards 120s, odds2 45s, all declared inline.
export const config = { maxDuration: 120 };
