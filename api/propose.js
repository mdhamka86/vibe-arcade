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

const charterSeed = require("./charter-seed.json");

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

module.exports = async (req, res) => {
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
        if (s.includes("united states") || s.includes("usa")) return "USA";
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
        "THE NUMBERING TRAP — THIS IS THE ONE THAT PUTS MONEY ON THE WRONG HORSE. SGPools MERGES several venues into ONE meet and RENUMBERS the races end to end (a \"South Africa\" meet is often Turffontein + Durbanville combined into Race 1-17 under a single coupon Code). Every press source — Gold Circle, Race Coast, Racenet — numbers races within ITS OWN venue. So \"Durbanville Race 6\" and SGPools \"SA Race 6\" are almost never the same race. NEVER carry a race or horse number across from a preview. The ONLY correct method: take the horse NAME from your analysis, then FIND THAT NAME in the runner map, and use the race number and horse number the runner map gives it. The runner map is the SGPools card itself and is the sole authority. If the name is not in the runner map, do not guess a number — flag the leg UNCONFIRMED and say so. A leg whose name and number disagree is worse than no leg at all, because it looks confident while pointing at a stranger.";

      const prompt =
        "THE CHARTER (immovable law):\n" + charterText(ch) +
        "\n\nOUTPUT CONTRACT:\n" +
        "slipFormat: " + ch.outputContract.slipFormat + "\n" +
        "mustInclude: " + ch.outputContract.mustInclude + "\n" +
        "restraint: " + ch.outputContract.restraint +
        (lessons.length ? "\n\nRECENT LESSONS (learn from the graded record):\n- " + lessons.join("\n- ") : "") +
        "\n\nMORNING PACK:\n" + packBrief(pack) +
        "\n\nNow produce the betlist. Respond with ONLY minified JSON, no markdown fences, exactly:\n" +
        '{"dayShape":"2-3 sentence summary: meets in play, WIN vs PLA lean, any Trio, overall stance",' +
        '"legs":[{"meet":"","region":"","raceNo":0,"horseNo":0,"horseName":"","betType":"WIN|PLA|TRIO","stake":10,"confidence":"High|Medium-High|Medium|Low-Med","reason":"convergence read: which sources agree and why","unconfirmed":false}],' +
        '"trioNote":"if a Trio is proposed, the frame and why; else empty",' +
        '"sourcesChecked":{"MeetName":["source ids used"]},' +
        '"skipped":[{"meet":"","why":"why no or few legs here"}]}';

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
      const cardIndex = {};
      pack.meets.forEach((m) => {
        (m.raceMap || []).forEach((r) => {
          (r.runners || []).forEach((h) => {
            cardIndex[m.venue + "|" + r.raceNo + "|" + h.no] = h.name;
          });
        });
      });

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
        // LAW: card-match — verify the number against the runner map
        const key = leg.meet + "|" + leg.raceNo + "|" + leg.horseNo;
        if (leg.betType !== "TRIO") {
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

      const winCount = clean.filter((l) => l.betType === "WIN").length;
      const plaCount = clean.filter((l) => l.betType === "PLA").length;
      const trioCount = clean.filter((l) => l.betType === "TRIO").length;
      const staked = clean.reduce((a, l) => a + l.stake, 0);

      // build the vault-ready JSON the Quill's paste lane accepts
      const quillPayload = {
        date: pack.date,
        legs: clean.map((l) => ({
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
        legs: clean,
        trioNote: parsed.trioNote || "",
        sourcesChecked: parsed.sourcesChecked || {},
        skipped: parsed.skipped || [],
        corrections,
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

module.exports._packBrief = packBrief;
module.exports._charterText = charterText;
module.exports._charterHealth = charterHealth;
module.exports._charterDrift = charterDrift;
