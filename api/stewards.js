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
  leg.horseNo = raw.horseNo == null ? "" : String(raw.horseNo).trim();
  if (!leg.horseNo) errors.push("leg " + idx + ": horseNo is required");
  leg.horseName = raw.horseName == null ? "" : String(raw.horseName).trim();
  leg.betType = String(raw.betType || "").trim().toUpperCase();
  if (!leg.betType) errors.push("leg " + idx + ": betType is required");
  else if (!KNOWN_TYPES.includes(leg.betType))
    notices.push("leg " + idx + ": unusual betType '" + leg.betType + "' accepted");
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
        const rec = receiptOf(sib);
        return rec ? byReceipt[rec] || null : null;
      };

      const proposal = [];
      const untouched = [];
      for (const leg of pending) {
        const rec = receiptOf(leg);
        const row = rec ? byReceipt[rec] : null;
        if (!row) {
          untouched.push({
            xlRow: leg.xlRow, receipt: rec,
            label: leg.date + " R" + leg.raceNo + " #" + leg.horseNo + " " + leg.betType,
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
          result = pay > 0 ? "Win" : "Lose";
        }
        proposal.push({
          xlRow: leg.xlRow,
          receipt: rec,
          label: leg.date + " R" + leg.raceNo + " #" + leg.horseNo + " " +
            (leg.horseName || "") + " " + leg.betType,
          result,
          payout: r2(pay),
          position: result === "Win" ? 1 : null,
          stake: leg.stake,
          note,
        });
      }

      const pendingRecs = new Set(
        pending.map((b) => receiptOf(b)).filter(Boolean)
      );
      const unmatched = rows
        .filter((r) => {
          const rec = r && r.receipt
            ? String(r.receipt).toUpperCase().replace(/[^0-9A-Z]/g, "") : null;
          return rec && !pendingRecs.has(rec);
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
        proposal,
        untouched,
        unmatched,
        wallet,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

module.exports.computeAudit = computeAudit; // exposed for test harnesses
