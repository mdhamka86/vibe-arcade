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

// ---- write plumbing: snapshot, write, read-back verify, bump meta ----
async function writeVerified(updates) {
  const keys = Object.keys(updates);
  const current = await redis(keys.map((k) => ["GET", k]));
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
const LEDGERS = { model: "Model", exotic: "Exotic", misclick: "Misclick", refund: "Refund" };
const RESULTS = { win: "Win", place: "Place", lose: "Lose", refund: "Refund", pending: "Pending" };
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
      const { verify, allMatch } = await writeVerified({ "stw:betlog": str });
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

    if (action === "settle") {
      if (req.method !== "POST")
        return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const setts = body.settlements;
      if (!Array.isArray(setts) || !setts.length)
        return res.status(400).json({ error: "Provide settlements as a non-empty array" });

      const [logRaw] = await redis([["GET", "stw:betlog"]]);
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
        row.result = RESULTS[resKey];
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
        } else if (resKey === "lose") {
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

      const str = JSON.stringify(log);
      const { verify, allMatch } = await writeVerified({ "stw:betlog": str });
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
      const { verify, allMatch } = await writeVerified({ "stw:daily": str });
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
      if (!nRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const notes = JSON.parse(nRaw);
      notes.push({ xlRow: nextRow(notes), cols: [text] });
      const str = JSON.stringify(notes);
      const { verify, allMatch } = await writeVerified({ "stw:notes": str });
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
      const { verify, allMatch } = await writeVerified({ "stw:ledger": str });
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
      const { verify, allMatch } = await writeVerified({ "stw:ledger": str });
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
      if (!logRaw) return res.status(404).json({ error: "Vault not seeded yet" });
      const log = JSON.parse(logRaw);
      const rxRec = /receipt\s+([0-9A-Z]+)/i;
      const receiptOf = (b) => {
        const m = rxRec.exec(String(b.notes || ""));
        return m ? m[1].toUpperCase() : null;
      };
      const pending = log.filter((b) => normResult(b.result) === "pending");
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
        "Respond with ONLY minified JSON, no markdown fences, exactly this shape: " +
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
        parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch (e) {
        return res.status(502).json({
          error: "Vision reply was not clean JSON: " + text.slice(0, 180),
        });
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
        // FALLBACK: no stored receipt (or it didn't match) -> match on coordinates
        if (!row) {
          const c = rowByCoord(leg);
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
        const pay = num(row.payout);
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
        "For each horse bet extract: the RECEIPT number (letters and digits only, e.g. 557A0429); " +
        "the full SELECTION text verbatim; the MEET / country and course if shown; the COUPON CODE if shown; " +
        "the RACE number (the digits attached to the meet code, per the grammar above); the BET TYPE; the UNIT count (the number after 'U'); and the total AMOUNT staked in dollars. " +
        "For the HORSE field: a WIN or PLA bet has a single horse number, put it in horseNo. " +
        "An EXOTIC (TRIO, Forecast, Quartet) is a COMBINATION, not one horse: leave horseNo null and put the full combination string (e.g. '4-5-9/4-5-9/4-5-9' or '1-3-7') in the combo field. Never force a single horse number onto an exotic. " +
        "Read the numbers exactly as printed. If a genuinely single-horse field is unreadable use null; do not guess. " +
        "Respond with ONLY minified JSON, no markdown fences, exactly this shape: " +
        '{"skippedNonHorse":0,' +
        '"bets":[{"receipt":"","selection":"","meet":"","couponCode":"","raceNo":0,"horseNo":null,"combo":"","betType":"WIN|PLA|TRIO|FORECAST|QUARTET","units":1,"amount":0}]} ' +
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
        parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch (e) {
        return res.status(502).json({
          error: "Vision reply was not clean JSON: " + text.slice(0, 180),
        });
      }
      const rawBets = Array.isArray(parsed.bets) ? parsed.bets : [];

      // receipts already in the vault, so re-uploading the same page never double-logs
      const rxRec = /receipt\s+([0-9A-Z]+)/i;
      const existingReceipts = new Set();
      log.forEach((b) => {
        const m = rxRec.exec(String(b.notes || ""));
        if (m) existingReceipts.add(m[1].toUpperCase());
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
          if (/[\-\/]/.test(tail)) selCombo = tail; else selHorse = tail;
        }
        // exotics carry a combination, not a single horse; singles carry a horse number
        const combo = exotic
          ? (String(b.combo || "").trim() || selCombo)
          : "";
        const horseNo = exotic
          ? "" // exotics never store a single horse number
          : (b.horseNo == null ? (selHorse || "") : String(b.horseNo).trim()) || selHorse;

        if (receipt && existingReceipts.has(receipt)) {
          warnings.push(
            "Receipt " + receipt + " is already in the book, skipped to avoid a duplicate."
          );
          continue;
        }
        if (receipt && seen.has(receipt)) {
          warnings.push("Receipt " + receipt + " appeared twice in the upload, kept once.");
          continue;
        }
        if (receipt) seen.add(receipt);

        // stake note. For singles, flat-stake sanity ($10 WIN / $5 PLA). For exotics,
        // stakes legitimately vary with units and combo size, so only a soft note, never a block.
        let stakeNote = "";
        if (!exotic) {
          const expected = betType === "WIN" ? 10 : betType === "PLA" ? 5 : null;
          if (expected != null && amount && Math.abs(amount - expected) > 0.01)
            stakeNote =
              "stake $" + amount + " differs from the usual flat $" + expected + " for " + betType;
        } else if (amount && Math.abs(amount - 6) > 0.01) {
          // soft, informational only: exotics are allowed any stake
          stakeNote = "exotic staked $" + amount + " (exotics vary by units/combo, no flat rule)";
        }

        // build the selection/combo descriptor for the notes and identity
        const comboText = exotic
          ? (combo || String(b.selection || "").trim() || "combo unread")
          : "";

        legs.push({
          date: legDate,
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
