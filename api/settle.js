// api/settle.js
// NINETY PLUS — the clerk of the scales.
//
// Records what was actually placed, then grades it against the scoreline once the
// match finishes. This is the half of the tool that makes the other half mean
// something: until legs settle, every confidence label is an assertion with no
// evidence behind it and the stats header is decoration.
//
// Actions:
//   POST ?action=commit  {legs:[...], date}   -> write proposed legs to the log as pending
//   POST ?action=settle  [{date}]             -> grade pending legs against results
//   GET  ?action=log     [&date]              -> the bet log, newest first
//   GET  ?action=pending                      -> legs awaiting a result
//   POST ?action=void    {id, why}            -> void a leg (never delete)
//
// TWO DISCIPLINES CARRIED OVER FROM THE STEWARDS' ROOM, both earned the hard way:
//
// VOID, NEVER DELETE. A leg that was placed and then shouldn't have been is part
// of the record. Deleting it makes the book look better than it was, which is the
// one thing a book must never do. Voided legs stay, marked, excluded from ROI.
//
// WRITE, THEN READ BACK. A green tick that has not been read back is a guess.
// Every write snapshots the previous value and verifies the stored bytes match.

import { fetchLivescore, teamKey } from "./fetchers.js";

const R_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const R_TOK =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

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

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;

async function getLog() {
  const [raw] = await redis([["GET", "ninety:betlog"]]);
  return raw ? JSON.parse(raw) : [];
}

// ---------------------------------------------------------------------------
// GRADING
// ---------------------------------------------------------------------------
//
// Each market gets its own grader. A market with NO grader returns "manual" —
// deliberately, because a wrong automatic grade is far worse than an ungraded
// leg. The book would look settled and be wrong, and nothing downstream could
// tell. Unknown markets wait for a human rather than being guessed at.

// SGPools football markets settle on 90 MINUTES + stoppage, not extra time and
// not penalties. LiveScore's AP status carries the pre-shootout score in Tr1/Tr2,
// which is exactly what we want — verified 22/07/2026 on two cup ties.
const FINISHED = new Set(["FT", "AP", "AET"]);
const ABANDONED = new Set(["Canc.", "Postp.", "Abd.", "Susp."]);
// 1X2 — the selection is a team name or "Draw".
function grade1X2(leg, res) {
  const h = res.scoreHome, a = res.scoreAway;
  const sel = String(leg.selection || "").toLowerCase().trim();
  const isDraw = sel === "draw" || sel === "x";
  if (isDraw) return h === a ? "win" : "lose";
  // Which side did they back? Match the selection against the fixture's own
  // team names rather than the result's, because the mirror and the feed spell
  // clubs differently and leg.fixture is what the user card-matched against.
  const k = teamKey(leg.selection);
  const kh = teamKey(leg.homeTeam || "");
  const ka = teamKey(leg.awayTeam || "");
  const near = (p, q) => p && q && (p === q || (p.length >= 4 && q.length >= 4 && (p.includes(q) || q.includes(p))));
  if (near(k, kh)) return h > a ? "win" : "lose";
  if (near(k, ka)) return a > h ? "win" : "lose";
  return "manual";
}

// Handicap markets: "Team -1.5", "Team +1.5", "Team -1", "Team 0".
// Quarter-goal Asian lines (-0.25, -0.75) split the stake and are NOT graded
// here — half a leg winning is a different bet shape and forcing it into
// win/lose would misreport the book.
function gradeHandicap(leg, res) {
  const m = String(leg.selection || "").match(/^(.*?)\s*([+-]?\d+(?:\.\d+)?)\s*$/);
  if (!m) return "manual";
  const line = parseFloat(m[2]);
  if (!isFinite(line)) return "manual";
  if (Math.abs(line * 4) % 2 === 1) return "manual";  // quarter line: split stake
  const k = teamKey(m[1]);
  const kh = teamKey(leg.homeTeam || "");
  const ka = teamKey(leg.awayTeam || "");
  const near = (p, q) => p && q && (p === q || (p.length >= 4 && q.length >= 4 && (p.includes(q) || q.includes(p))));
  let margin;
  if (near(k, kh)) margin = res.scoreHome - res.scoreAway;
  else if (near(k, ka)) margin = res.scoreAway - res.scoreHome;
  else return "manual";
  const adj = margin + line;
  if (adj > 0) return "win";
  if (adj < 0) return "lose";
  return "push";                                       // exact whole-goal line
}

// Totals: "Over 2.5" / "Under 3.5" / "Over 3" (whole lines can push).
function gradeTotals(leg, res) {
  const m = String(leg.selection || "").match(/(over|under)\s*(\d+(?:\.\d+)?)/i);
  if (!m) return "manual";
  const line = parseFloat(m[2]);
  const total = res.scoreHome + res.scoreAway;
  if (total === line) return "push";
  const over = /over/i.test(m[1]);
  return (over ? total > line : total < line) ? "win" : "lose";
}

// Both teams to score.
function gradeBTTS(leg, res) {
  const sel = String(leg.selection || "").toLowerCase();
  const both = res.scoreHome > 0 && res.scoreAway > 0;
  if (/\byes\b/.test(sel)) return both ? "win" : "lose";
  if (/\bno\b/.test(sel)) return both ? "lose" : "win";
  return "manual";
}

// Odd/even total goals.
function gradeOddEven(leg, res) {
  const sel = String(leg.selection || "").toLowerCase();
  const total = res.scoreHome + res.scoreAway;
  const odd = total % 2 === 1;
  if (/\bodd\b/.test(sel)) return odd ? "win" : "lose";
  if (/\beven\b/.test(sel)) return odd ? "lose" : "win";
  return "manual";
}

// Exact scoreline — "2-1", "1:0", and the catch-all "Any Other Score".
function gradeCorrectScore(leg, res) {
  const sel = String(leg.selection || "").trim();
  const m = sel.match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!m) return /any other/i.test(sel) ? "manual" : "manual";
  return (Number(m[1]) === res.scoreHome && Number(m[2]) === res.scoreAway) ? "win" : "lose";
}

// Route a market to its grader by name. Deliberately narrow: HALFTIME markets
// are excluded because the feed's Tr1/Tr2 are full-time figures and grading a
// half-time bet against a full-time score would be confidently, silently wrong.
function gradeLeg(leg, res) {
  // GUARD FIRST, ROUTE SECOND. Every grader below does arithmetic on scoreHome
  // and scoreAway, and JavaScript will happily compare null to a number: on
  // 25/07 an unplayed Colo Colo fixture (status NS, scores null) graded as a
  // LOSS through the handicap grader, because null - null = 0 and 0 + -1.5 < 0.
  // The endpoint checks status separately, so this never reached the log — but a
  // grader that returns a confident wrong answer when called directly is a trap
  // waiting for the next caller. The guard belongs where the arithmetic is.
  if (!res || !FINISHED.has(res.status)) return "manual";
  if (res.scoreHome == null || res.scoreAway == null) return "manual";
  const mk = String(leg.market || "").toLowerCase();
  if (/half\s*time|halftime|1st half|ht /.test(mk)) return "manual";
  if (/^1x2$/.test(mk) || /match result/.test(mk)) return grade1X2(leg, res);
  if (/handicap|1\/2 goal/.test(mk)) return gradeHandicap(leg, res);
  if (/odd\/even|odd or even/.test(mk)) return gradeOddEven(leg, res);
  if (/total goals over|over\/under|total goals o\/u/.test(mk)) return gradeTotals(leg, res);
  if (/both teams score|btts/.test(mk)) return gradeBTTS(leg, res);
  if (/pick the score|correct score/.test(mk)) return gradeCorrectScore(leg, res);
  if (/^total goals$/.test(mk)) return "manual";       // banded totals, not a line
  return "manual";
}

// Payout follows the grade. A push returns the stake; a void returns it too but
// is excluded from ROI entirely, because a voided leg is not a decision the
// model got right or wrong and counting it either way flatters or maligns it.
function payoutFor(grade, stake, odds) {
  if (grade === "win") return r2(num(stake) * num(odds));
  if (grade === "push" || grade === "void") return r2(num(stake));
  if (grade === "lose") return 0;
  return null;                                          // manual / pending
}

// Match a logged leg to a fixture in the results feed.
function findResult(leg, fixtures) {
  const kh = teamKey(leg.homeTeam || "");
  const ka = teamKey(leg.awayTeam || "");
  const near = (p, q) => p && q && (p === q || (p.length >= 4 && q.length >= 4 && (p.includes(q) || q.includes(p))));
  return fixtures.find((f) => near(teamKey(f.home), kh) && near(teamKey(f.away), ka)) || null;
}

// ---------------------------------------------------------------------------

const handler = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    if (!R_URL || !R_TOK) return res.status(500).json({ error: "Redis env vars missing" });
    const action = (req.query.action || "log").toString();

    // ---- COMMIT: record what was placed -----------------------------------
    if (action === "commit") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const legs = Array.isArray(body.legs) ? body.legs : [];
      if (!legs.length) return res.status(400).json({ error: "No legs to commit" });

      const log = await getLog();
      const existing = new Set(log.map((b) => b.id));
      const added = [];
      const skipped = [];

      for (const l of legs) {
        // A stable id from the bet's own identity, so committing the same slip
        // twice cannot double-count it. The user tapping a button twice is a
        // normal thing to do and must not silently corrupt the record.
        const id = [
          String(l.matchDateISO || l.matchDate || "").replace(/\W/g, ""),
          String(l.mirrorCode || ""),
          String(l.market || "").replace(/\W/g, "").slice(0, 20),
          String(l.selection || "").replace(/\W/g, "").slice(0, 20),
        ].join("-");
        if (existing.has(id)) { skipped.push({ id, why: "already in the log" }); continue; }
        const entry = {
          id,
          committedAt: new Date().toISOString(),
          matchDate: l.matchDate || "",
          matchDateISO: l.matchDateISO || "",
          mirrorCode: l.mirrorCode || "",
          league: l.league || "",
          fixture: l.fixture || "",
          homeTeam: l.homeTeam || "",
          awayTeam: l.awayTeam || "",
          market: l.market || "",
          selection: l.selection || "",
          betType: l.betType || "",
          odds: num(l.odds),
          stake: num(l.stake),
          confidence: l.confidence || "",
          reason: Array.isArray(l.reason) ? l.reason : (l.reason ? [String(l.reason)] : []),
          // What the read rested on, frozen at commit time. Without this the
          // ledger can never answer "do thin reads lose?", which is the whole
          // reason the coverage work exists.
          coverage: l.coverage || null,
          result: "pending",
          scoreHome: null,
          scoreAway: null,
          payout: null,
          ledger: "Model",
        };
        log.push(entry);
        existing.add(id);
        added.push(entry);
      }

      const { verify, allMatch } = await writeVerified({ "ninety:betlog": JSON.stringify(log) });
      return res.status(200).json({
        ok: allMatch, added: added.length, skipped, legs: added,
        totalInLog: log.length, verify,
      });
    }

    // ---- SETTLE: grade pending legs against the scoreline ------------------
    if (action === "settle") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const log = await getLog();
      const pending = log.filter((b) => b.result === "pending" && b.ledger !== "Void");
      if (!pending.length)
        return res.status(200).json({ ok: true, settled: 0, note: "Nothing pending to settle." });

      // Group by match date so each date's feed is fetched once.
      const dates = [...new Set(pending.map((b) => String(b.matchDateISO || "").replace(/-/g, "")).filter(Boolean))];
      if (body.date) {
        const want = String(body.date).replace(/-/g, "").replace(/\//g, "");
        dates.length = 0; dates.push(want);
      }
      if (!dates.length)
        return res.status(422).json({ error: "Pending legs carry no usable match date; settle manually." });

      const feeds = {};
      const feedErrors = [];
      await Promise.all(dates.map(async (d) => {
        const r = await fetchLivescore(d);
        if (r.ok) feeds[d] = r.fixtures;
        else feedErrors.push({ date: d, why: r.error });
      }));

      const settled = [];
      const unresolved = [];
      for (const leg of pending) {
        const d = String(leg.matchDateISO || "").replace(/-/g, "");
        const fx = feeds[d];
        if (!fx) { unresolved.push({ id: leg.id, why: "no results feed for " + (leg.matchDate || d) }); continue; }
        const res0 = findResult(leg, fx);
        if (!res0) { unresolved.push({ id: leg.id, fixture: leg.fixture, why: "fixture not found in the feed for that date" }); continue; }

        // A match that never finished voids: the stake comes back and the leg is
        // excluded from ROI. Grading it as a loss would blame the model for a
        // waterlogged pitch.
        if (ABANDONED.has(res0.status)) {
          leg.result = "void-result";
          leg.payout = r2(leg.stake);
          leg.settledAt = new Date().toISOString();
          leg.note = "match " + res0.status;
          settled.push({ id: leg.id, fixture: leg.fixture, result: leg.result, why: res0.status });
          continue;
        }
        if (!FINISHED.has(res0.status)) {
          unresolved.push({ id: leg.id, fixture: leg.fixture, why: "not finished (status " + res0.status + ")" });
          continue;
        }
        if (res0.scoreHome == null || res0.scoreAway == null) {
          unresolved.push({ id: leg.id, fixture: leg.fixture, why: "finished but the feed carries no score" });
          continue;
        }

        const grade = gradeLeg(leg, res0);
        leg.scoreHome = res0.scoreHome;
        leg.scoreAway = res0.scoreAway;
        leg.feedStatus = res0.status;
        if (grade === "manual") {
          // The score is recorded so the leg can be graded by hand without
          // chasing the result again, but it stays out of the settled figures.
          unresolved.push({
            id: leg.id, fixture: leg.fixture,
            score: res0.scoreHome + "-" + res0.scoreAway,
            why: "no automatic grader for market [" + leg.market + "] — grade by hand",
          });
          continue;
        }
        leg.result = grade;
        leg.payout = payoutFor(grade, leg.stake, leg.odds);
        leg.settledAt = new Date().toISOString();
        settled.push({
          id: leg.id, fixture: leg.fixture, market: leg.market, selection: leg.selection,
          score: res0.scoreHome + "-" + res0.scoreAway,
          result: grade, stake: leg.stake, odds: leg.odds, payout: leg.payout,
        });
      }

      const { verify, allMatch } = await writeVerified({ "ninety:betlog": JSON.stringify(log) });
      const staked = r2(settled.reduce((a, s) => a + num(s.stake), 0));
      const returned = r2(settled.reduce((a, s) => a + num(s.payout), 0));
      return res.status(200).json({
        ok: allMatch,
        settled: settled.length,
        legs: settled,
        unresolved,
        feedErrors,
        thisRun: { staked, returned, net: r2(returned - staked) },
        stillPending: log.filter((b) => b.result === "pending" && b.ledger !== "Void").length,
        verify,
      });
    }

    // ---- VOID: strike a leg from the figures, never from the record --------
    if (action === "void") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      const body = parseBody(req);
      const id = String(body.id || "").trim();
      if (!id) return res.status(400).json({ error: "id required" });
      const log = await getLog();
      const leg = log.find((b) => b.id === id);
      if (!leg) return res.status(404).json({ error: "No leg with id " + id });
      leg.ledger = "Void";
      leg.voidedAt = new Date().toISOString();
      leg.voidReason = String(body.why || "").slice(0, 300);
      if (leg.result === "pending") leg.result = "void";
      leg.payout = r2(leg.stake);
      const { verify, allMatch } = await writeVerified({ "ninety:betlog": JSON.stringify(log) });
      return res.status(200).json({ ok: allMatch, voided: id, leg, verify });
    }

    // ---- READ ------------------------------------------------------------
    if (action === "pending") {
      const log = await getLog();
      const p = log.filter((b) => b.result === "pending" && b.ledger !== "Void");
      return res.status(200).json({
        count: p.length,
        staked: r2(p.reduce((a, b) => a + num(b.stake), 0)),
        legs: p,
      });
    }

    if (action === "log") {
      const log = await getLog();
      const d = (req.query.date || "").toString();
      const rows = d ? log.filter((b) => b.matchDate === d || b.matchDateISO === d) : log;
      return res.status(200).json({
        count: rows.length,
        legs: rows.slice().reverse(),
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

export default handler;

export { gradeLeg, grade1X2, gradeHandicap, gradeTotals, gradeBTTS, gradeOddEven,
         gradeCorrectScore, payoutFor, findResult, FINISHED, ABANDONED };

// Results feeds are one fetch per distinct match date, and a settle run covering
// a week of pending legs is still only a handful of calls. 60s is ample.
export const config = { maxDuration: 60 };
