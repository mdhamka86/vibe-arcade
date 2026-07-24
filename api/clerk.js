// api/clerk.js
// NINETY PLUS — the intake clerk.
//
// Reads SGPools transaction-history pages (screenshots or a PDF export) and
// records what was ACTUALLY placed: the real price, the real stake, the receipt
// number, and — where the document has settled — the real payout.
//
// Actions:
//   POST ?action=read   {images:[{media_type,data}], commit?}  -> parse, optionally file
//   POST ?action=file   {bets:[...]}                            -> file already-parsed bets
//   GET  ?action=bets   [&date]                                 -> the placed-bet ledger
//   GET  ?action=orphans                                        -> leg fragments awaiting a parent
//
// WHY THIS EXISTS AND WHAT IT FIXES:
//
// The slip is a PROPOSAL. What reaches the coupon differs: the mirror lags, so
// the price moves between reading and placing; sometimes a leg is dropped;
// sometimes legs are combined into a multiple. A ledger built from proposals
// measures the model's opinions. A ledger built from receipts measures the book.
// Only the second one can tell you whether any of this works.
//
// THE MULTIPLE IS THE WHOLE REASON THIS IS NOT A FLAT LIST.
// Verified on the 18/07/2026 statement: receipt O/0802407/0000083 is ONE $10 bet
// carrying FOUR legs, and it paid $0.00 because the Shenhua leg lost. The same
// four selections also went on as singles (receipts 0078-0081) and three of them
// paid. Flattening the multiple into four legs would invent $30 of stake that was
// never placed and report a day that never happened. So: a BET has legs; legs are
// never bets. A multiple settles as a unit, all-or-nothing.
//
// THE DOCUMENT OUTRANKS MY ARITHMETIC.
// Where a row says Settled with a payout, that figure is SGPools' own and it is
// final. It also covers precisely the cases settle.js refuses to grade: quarter
// Asian lines (Argentina +0.25 paid $14.10 on $10 — a half win), half-time
// markets, and every multiple. Automatic grading is the fallback for bets whose
// receipt has not been uploaded yet, never an override.

const R_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const R_TOK =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const AK = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "";

async function redis(cmds) {
  const r = await fetch(R_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + R_TOK, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("Redis HTTP " + r.status);
  const j = await r.json();
  const bad = j.find((x) => x.error);
  if (bad) throw new Error("Redis: " + bad.error);
  return j.map((x) => x.result);
}

async function writeVerified(kv) {
  const keys = Object.keys(kv);
  const cur = await redis(keys.map((k) => ["GET", k]));
  const snap = [];
  keys.forEach((k, i) => {
    if (cur[i] != null) snap.push(["SET", "ninety:prev:" + k.replace(/^ninety:/, ""), cur[i]]);
  });
  if (snap.length) await redis(snap);
  await redis(keys.map((k) => ["SET", k, kv[k]]));
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
    return typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
  } catch (e) { return {}; }
}

const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(/[$,\s]/g, "")); return isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;

// Same brace-counting extractor as the analysis engine: a reply with a preamble
// should cost a re-read, not the whole intake.
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
  return null;
}

// ---------------------------------------------------------------------------
// THE READ
// ---------------------------------------------------------------------------

const SYSTEM =
  "You are the intake clerk for Ninety Plus, reading Singapore Pools TRANSACTION HISTORY pages. " +
  "You transcribe what is printed. You never infer, never complete a partial row from knowledge of football, and never tidy a value into what it 'should' be. " +
  "\n\nTHE PAGE IS A TABLE with these columns: TRANSACTION DATE & TIME | TYPE | CHANNEL | SELECTION / DETAILS | AMOUNT | DRAW / EVENT DATE & TIME | STATUS / RECEIPT NO. | PAYOUT / WINNINGS. " +
  "\n\nEXTRACT ONLY ROWS WHERE TYPE IS EXACTLY 'Football'. Ignore Horse Wagering, TOTO, 4D, Deposit, Withdrawal and everything else entirely. " +
  "\n\nA FOOTBALL ROW'S SELECTION CELL holds one or more LEGS. Each leg is two or three printed lines: " +
  "'<Competition> - <Home> vs <Away> - <Market>' then '<Selection> @ <odds>'. The MARKET NAME MAY WRAP onto its own line before the selection line — for example 'Swedish League - Orgryte vs Djurgarden - Half Time Asian' / 'Handicap' / 'Djurgarden -0.5 @ 1.90' is ONE leg whose market is 'Half Time Asian Handicap'. Rejoin wrapped market names. " +
  "\n\nCRITICAL — MULTIPLES. A single row may carry SEVERAL legs under ONE amount, ONE receipt number and ONE payout. That is a MULTIPLE (an accumulator): one bet, all legs must win. Its legs are listed one after another in the same cell, and the DRAW/EVENT column shows one datetime per leg. " +
  "Report it as ONE bet with several entries in its legs array. NEVER split a multiple into separate bets — the stake belongs to the bet, not to each leg, and splitting it would invent money that was never staked. " +
  "A row with exactly one leg is a single: same shape, one entry in legs. " +
  "\n\nSTAKE is the AMOUNT column, once per bet. PAYOUT is the PAYOUT column: a number, or null when the cell shows '-' or is empty. STATUS is 'Placed' or 'Settled' as printed. RECEIPT is the identifier in the STATUS column, which for football always begins 'O/'. " +
  "\n\nCONTINUATION FRAGMENTS. If the page begins mid-row — leg text at the very top with no amount, no receipt and no status of its own — those legs belong to a bet whose header was on the previous page. Report them in 'orphanLegs', never as a bet. Do not guess which bet they belong to. " +
  "\n\nIf a value is genuinely unreadable, use null. A null is recoverable; a confident wrong number is not.";

async function readPages(images) {
  const content = [];
  for (const im of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data },
    });
  }
  content.push({
    type: "text",
    text:
      "Transcribe every Football row from these transaction-history pages. Respond with ONLY minified JSON, no fences, exactly:\n" +
      '{"pages":[{"pageLabel":"Page 6 of 7","statementFrom":"18 July 2026","statementTo":"24 July 2026"}],' +
      '"bets":[{"receipt":"O/0802407/0000083","placedAt":"18 Jul 2026 06:24 PM","stake":10,' +
      '"status":"Settled","payout":0,' +
      '"legs":[{"league":"Chinese League","home":"Shenhua","away":"Tianjin Jinmen","market":"1X2",' +
      '"selection":"Shenhua","odds":1.40,"eventAt":"18 Jul 2026 07:35 PM"}]}],' +
      '"orphanLegs":[{"league":"","home":"","away":"","market":"","selection":"","odds":0,"eventAt":"","note":"page began mid-row"}],' +
      '"unreadable":["anything you could not transcribe with confidence"]}',
  });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) throw new Error("Claude HTTP " + r.status + ": " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = (j.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
  const raw = extractJson(text);
  if (!raw) throw new Error("The clerk's reply carried no JSON: " + text.slice(0, 200));
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// NORMALISE + VALIDATE
// ---------------------------------------------------------------------------
//
// Every check here answers a question with a printed answer. Nothing judges
// whether a bet was wise; that is the ledger's job once there is enough of it.

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

// "26 Jul 2026 11:00 PM" -> "2026-07-26". Returns null rather than guessing.
function toISODate(s) {
  const m = String(s || "").match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (mo == null) return null;
  const d = new Date(Date.UTC(Number(m[3]), mo, Number(m[1])));
  return d.toISOString().slice(0, 10);
}

function normaliseBet(b) {
  const legs = (Array.isArray(b.legs) ? b.legs : []).map((l) => ({
    league: String(l.league || "").trim(),
    home: String(l.home || "").trim(),
    away: String(l.away || "").trim(),
    fixture: String(l.home || "").trim() + " v " + String(l.away || "").trim(),
    market: String(l.market || "").trim(),
    selection: String(l.selection || "").trim(),
    odds: num(l.odds),
    eventAt: String(l.eventAt || "").trim(),
    eventDateISO: toISODate(l.eventAt),
  })).filter((l) => l.home && l.away);

  const stake = r2(b.stake);
  const status = /settl/i.test(String(b.status || "")) ? "Settled" : "Placed";
  const payoutRaw = b.payout;
  const payout = (payoutRaw == null || payoutRaw === "" || payoutRaw === "-") ? null : r2(payoutRaw);

  // COMBINED ODDS: the product of the legs. A four-leg multiple at 1.40 x 1.22 x
  // 1.23 x 1.90 is a 3.99 shot, and without this the ledger cannot tell an
  // odds-on single from a long accumulator when it comes to read its own record.
  const combinedOdds = legs.length
    ? Math.round(legs.reduce((a, l) => a * (l.odds || 1), 1) * 100) / 100
    : null;

  return {
    receipt: String(b.receipt || "").trim(),
    placedAt: String(b.placedAt || "").trim(),
    placedDateISO: toISODate(b.placedAt),
    stake,
    status,
    payout,
    legs,
    legCount: legs.length,
    // A multiple is not a bigger single. Naming the shape here means every
    // downstream reader gets it right without re-deriving it from legCount.
    shape: legs.length > 1 ? "multiple" : "single",
    combinedOdds,
    // Settled with a payout figure is FINAL — this is SGPools' own arithmetic,
    // and it covers the quarter-lines and half-time markets the auto-grader
    // deliberately refuses. `result` is derived, never inferred from football.
    result: status === "Settled" && payout != null
      ? (payout > stake ? "win" : (payout === stake ? "push" : "lose"))
      : "pending",
    source: "clerk",
  };
}

// Reject a bet the document cannot vouch for. Loud, itemised, never silent.
function validateBet(b) {
  const problems = [];
  if (!b.receipt) problems.push("no receipt number — the bet cannot be identified or de-duplicated");
  else if (!/^O\//.test(b.receipt)) problems.push('receipt "' + b.receipt + '" is not a football receipt (football receipts begin "O/")');
  if (!b.legs.length) problems.push("no legs could be read from the selection cell");
  if (!(b.stake > 0)) problems.push("no stake amount");
  b.legs.forEach((l, i) => {
    if (!(l.odds > 1)) problems.push("leg " + (i + 1) + " (" + l.fixture + ") has no usable price");
    if (!l.market) problems.push("leg " + (i + 1) + " (" + l.fixture + ") has no market");
  });
  // A settled bet with no payout figure is half-read: the status says the money
  // has moved but the amount is missing, and filing it would quietly zero it.
  if (b.status === "Settled" && b.payout == null)
    problems.push("marked Settled but the payout cell could not be read");
  return problems;
}

async function getBets() {
  const [raw] = await redis([["GET", "ninety:placed"]]);
  return raw ? JSON.parse(raw) : [];
}

// ---------------------------------------------------------------------------

const handler = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    if (!R_URL || !R_TOK) return res.status(500).json({ error: "Redis env vars missing" });
    const action = (req.query.action || "bets").toString();

    if (action === "bets") {
      const bets = await getBets();
      const d = (req.query.date || "").toString();
      const rows = d ? bets.filter((b) => b.placedDateISO === d || b.legs.some((l) => l.eventDateISO === d)) : bets;
      const settled = rows.filter((b) => b.result !== "pending");
      const staked = r2(settled.reduce((a, b) => a + num(b.stake), 0));
      const returned = r2(settled.reduce((a, b) => a + num(b.payout), 0));
      return res.status(200).json({
        count: rows.length,
        singles: rows.filter((b) => b.shape === "single").length,
        multiples: rows.filter((b) => b.shape === "multiple").length,
        settled: settled.length,
        pending: rows.length - settled.length,
        staked, returned, net: r2(returned - staked),
        roi: staked ? Math.round(((returned - staked) / staked) * 1000) / 10 : 0,
        bets: rows.slice().reverse(),
      });
    }

    if (action === "orphans") {
      const [raw] = await redis([["GET", "ninety:orphans"]]);
      const o = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ count: o.length, orphanLegs: o });
    }

    if (action === "read") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!AK) return res.status(500).json({ error: "ANTHROPIC_API_KEY missing (the clerk needs it)" });
      const body = parseBody(req);
      const images = Array.isArray(body.images) ? body.images : [];
      if (!images.length) return res.status(400).json({ error: "Provide at least one page image" });
      if (images.length > 8) return res.status(400).json({ error: "Max 8 pages per read; upload fewer." });

      let parsed;
      try { parsed = await readPages(images); }
      catch (e) { return res.status(502).json({ error: String(e.message || e) }); }

      const bets = (Array.isArray(parsed.bets) ? parsed.bets : []).map(normaliseBet);
      const accepted = [], rejected = [];
      for (const b of bets) {
        const problems = validateBet(b);
        if (problems.length) rejected.push({ receipt: b.receipt || "(none)", stake: b.stake, legCount: b.legCount, problems });
        else accepted.push(b);
      }

      const result = {
        ok: true,
        pages: parsed.pages || [],
        read: bets.length,
        accepted: accepted.length,
        rejected,
        // Leg fragments from a bet whose header sat on a page not uploaded. Held,
        // never guessed at: attaching them to the wrong receipt would corrupt a
        // real bet, which is worse than leaving them visible and unfiled.
        orphanLegs: Array.isArray(parsed.orphanLegs) ? parsed.orphanLegs : [],
        unreadable: Array.isArray(parsed.unreadable) ? parsed.unreadable : [],
        bets: accepted,
      };

      if (!body.commit) return res.status(200).json({ ...result, filed: false, note: "Preview only. Send commit:true to file these." });

      const fileRes = await fileBets(accepted, result.orphanLegs);
      return res.status(200).json({ ...result, filed: true, ...fileRes });
    }

    if (action === "file") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const bets = (Array.isArray(body.bets) ? body.bets : []).map((b) => (b.receipt && b.legs ? b : normaliseBet(b)));
      if (!bets.length) return res.status(400).json({ error: "No bets to file" });
      const bad = [];
      const good = [];
      bets.forEach((b) => { const p = validateBet(b); if (p.length) bad.push({ receipt: b.receipt, problems: p }); else good.push(b); });
      const fileRes = await fileBets(good, Array.isArray(body.orphanLegs) ? body.orphanLegs : []);
      return res.status(200).json({ ok: true, rejected: bad, ...fileRes });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

// THE RECEIPT IS THE IDENTITY. Uploads are ad hoc — the same page may arrive
// twice, days apart, in any order — so de-duplication cannot rely on upload
// sessions or dates. A receipt number is unique per bet, printed on every row,
// and stable forever. Same receipt means same bet, however many times it arrives.
//
// An existing bet is UPDATED rather than skipped when the new copy carries more:
// a page uploaded on Friday says "Placed" with no payout, the same page uploaded
// Sunday says "Settled $12.20". The second is the better record and must win,
// but only in that direction — a Settled bet is never quietly reverted to Placed.
async function fileBets(bets, orphanLegs) {
  const log = await getBets();
  const byReceipt = {};
  log.forEach((b, i) => { byReceipt[b.receipt] = i; });

  const added = [], updated = [], unchanged = [];
  for (const b of bets) {
    const at = byReceipt[b.receipt];
    if (at == null) {
      b.filedAt = new Date().toISOString();
      log.push(b);
      byReceipt[b.receipt] = log.length - 1;
      added.push(b.receipt);
      continue;
    }
    const cur = log[at];
    const gainsResult = cur.result === "pending" && b.result !== "pending";
    const gainsPayout = cur.payout == null && b.payout != null;
    if (gainsResult || gainsPayout) {
      log[at] = { ...cur, status: b.status, payout: b.payout, result: b.result, updatedAt: new Date().toISOString() };
      updated.push(b.receipt);
    } else unchanged.push(b.receipt);
  }

  const kv = { "ninety:placed": JSON.stringify(log) };
  if (orphanLegs && orphanLegs.length) {
    const [raw] = await redis([["GET", "ninety:orphans"]]);
    const cur = raw ? JSON.parse(raw) : [];
    const seen = new Set(cur.map((o) => JSON.stringify(o)));
    const fresh = orphanLegs.filter((o) => !seen.has(JSON.stringify(o)));
    if (fresh.length) kv["ninety:orphans"] = JSON.stringify(cur.concat(fresh));
  }
  const { verify, allMatch } = await writeVerified(kv);
  return { added: added.length, updated: updated.length, unchanged: unchanged.length,
           addedReceipts: added, updatedReceipts: updated, totalInLedger: log.length, verified: allMatch, verify };
}

export default handler;

export { normaliseBet, validateBet, toISODate, extractJson, fileBets };

// Vision over up to 8 dense table pages, then a max_tokens 8000 transcription.
// The read is the slow part and scales with page count, so this sits at the same
// 120s ceiling as the analysis engine rather than settle.js's 60.
export const config = { maxDuration: 120 };
