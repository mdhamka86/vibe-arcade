// api/stewards.js
// THE STEWARDS' ROOM — vault API for The Outsider Method.
// Phase 1: seed the v52 journal into Redis, serve it, and audit it on demand.
// Redis is the source of truth; the Excel journal becomes a report the vault prints.
//
// Actions:
//   GET  ?action=status              -> vault status + seed preview
//   POST ?action=import  {force}     -> seed vault from bundled v52 JSON, verify after write
//   GET  ?action=state&slice=betlog|daily|notes|running|formulas|all
//   GET  ?action=audit               -> full integrity re-check from Redis
//
// Keys: stw:meta, stw:betlog, stw:daily, stw:notes, stw:running, stw:formulas

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
  if (s === "loss") return "lose"; // 22/06 Greyville spelling variant
  return s;
}
function normConf(v) {
  const s = String(v == null ? "" : v).trim();
  if (s === "Med-High") return "Medium-High"; // label variant, one tier
  return s || "(no label)";
}
function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

// ---- the audit engine: recompute everything from a bet log array ----
function computeAudit(betLog) {
  const flags = [];
  const by = (l) =>
    betLog.filter(
      (b) => String(b.ledger || "").trim().toLowerCase() === l
    );
  const model = by("model");
  const exotic = by("exotic");
  const misclick = by("misclick");
  const refund = by("refund");
  const accounted =
    model.length + exotic.length + misclick.length + refund.length;
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

  // hygiene notices (informational, not failures)
  const lossSpelled = betLog.filter(
    (b) => String(b.result).trim() === "Loss"
  ).length;
  if (lossSpelled)
    flags.push(
      "NOTICE: " +
        lossSpelled +
        ' legs spelled "Loss" — normalised to Lose in all computed figures'
    );
  const medHigh = betLog.filter(
    (b) => String(b.confidence).trim() === "Med-High"
  ).length;
  if (medHigh)
    flags.push(
      "NOTICE: " +
        medHigh +
        ' legs tagged "Med-High" — folded into Medium-High for calibration'
    );

  const pendingNoReceipt = pending.filter(
    (b) => !/receipt\s+[0-9A-F-]{6,}/i.test(String(b.notes || ""))
  ).length;
  if (pendingNoReceipt)
    flags.push(
      "OBJECTION: " +
        pendingNoReceipt +
        " pending legs have no receipt number in Notes"
    );

  const sum = (arr, k) => Math.round(arr.reduce((a, b) => a + num(b[k]), 0) * 100) / 100;

  // WIN vs PLA split (settled model only)
  const split = {};
  for (const t of ["WIN", "PLA"]) {
    const legs = settled.filter((b) => String(b.betType).trim() === t);
    split[t] = {
      bets: legs.length,
      staked: sum(legs, "stake"),
      payout: sum(legs, "payout"),
      netPL: Math.round((sum(legs, "payout") - sum(legs, "stake")) * 100) / 100,
      cashed: legs.filter((b) => num(b.payout) > 0).length,
    };
  }

  // confidence calibration (settled model, normalised tiers)
  const calib = {};
  for (const b of settled) {
    const c = normConf(b.confidence);
    calib[c] = calib[c] || { bets: 0, staked: 0, payout: 0 };
    calib[c].bets++;
    calib[c].staked += num(b.stake);
    calib[c].payout += num(b.payout);
  }
  for (const c in calib) {
    calib[c].staked = Math.round(calib[c].staked * 100) / 100;
    calib[c].payout = Math.round(calib[c].payout * 100) / 100;
    calib[c].netPL =
      Math.round((calib[c].payout - calib[c].staked) * 100) / 100;
    calib[c].roi = calib[c].staked
      ? Math.round((calib[c].netPL / calib[c].staked) * 1000) / 10
      : 0;
  }

  // exotic ledger (refund excluded from settled, per journal convention)
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
      netPL: Math.round((sum(settled, "payout") - sum(settled, "stake")) * 100) / 100,
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
      netPL:
        Math.round(
          (sum(exoticSettled, "payout") - sum(exoticSettled, "stake")) * 100
        ) / 100,
    },
    flags,
  };
}

const SLICES = {
  betlog: "stw:betlog",
  daily: "stw:daily",
  notes: "stw:notes",
  running: "stw:running",
  formulas: "stw:formulas",
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    if (!R_URL || !R_TOK)
      return res.status(500).json({
        error:
          "Redis env vars missing (UPSTASH_REDIS_REST_URL / _TOKEN or KV_REST_API_URL / _TOKEN)",
      });

    const action = (req.query.action || "status").toString();

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
      let body = {};
      try {
        body =
          typeof req.body === "object" && req.body
            ? req.body
            : JSON.parse(req.body || "{}");
      } catch (e) {}
      const [existing] = await redis([["EXISTS", "stw:meta"]]);
      if (existing && !body.force)
        return res.status(409).json({
          error:
            "Vault already seeded. Send {\"force\":true} to overwrite (raw v52 reseed, wipes nothing else).",
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
        checksums,
      };
      const cmds = Object.entries(payloads).map(([k, v]) => ["SET", k, v]);
      cmds.push(["SET", "stw:meta", JSON.stringify(meta)]);
      await redis(cmds);

      // read-back verification: what Redis holds must hash-match what we sent
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
        weighedIn: allMatch && !audit.flags.some((f) => f.startsWith("OBJECTION")),
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
        checksum: { stored: meta.checksums["stw:betlog"], now: checksumNow, match: checksumOk },
        importedAt: meta.importedAt,
        seedVersion: meta.seedVersion,
        audit,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

module.exports.computeAudit = computeAudit; // exposed for test harnesses
