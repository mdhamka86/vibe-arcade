// api/ninetyplus.js
// NINETY PLUS — the football desk's analysis engine.
//
// Takes the fixtures you selected in the app, gathers every source that covers
// their competitions, hands the lot to Claude, then ENFORCES the rules in code
// on whatever comes back. Returns a bet slip table and writes it to the vault.
//
// Actions:
//   POST ?action=analyse  {fixtures:[...]}  -> gather, reason, gate, return slip
//   GET  ?action=latest                     -> last proposal, no token spend
//   GET  ?action=proposal&date=DD/MM/YYYY   -> a specific day's proposal
//   GET  ?action=stats                      -> vault headline figures
//   GET  ?action=coverage&league=...        -> what covers a competition
//
// THE DESIGN PRINCIPLE, TAKEN STRAIGHT FROM THE STEWARDS' ROOM:
// the brain proposes, the law disposes. Prompt instructions are REQUESTS; a
// model under pressure will drift from them. Code gates are ENFORCEMENT. Every
// rejection is logged to `vetoes` with the rule that cut it, so a short slip is
// visibly a short slip and never a silent one.
//
// WHAT IS DELIBERATELY *NOT* HERE: a Charter. The Outsider Method has ten laws
// because a month of graded losses argued for them. This book has no settled
// legs yet, so any "law" would be my present opinion wearing a crown — exactly
// the overfit that charterHealth() exists to catch. The gates below are
// STRUCTURAL (does this fixture exist, does this market exist, do the odds
// match what was scraped) rather than STRATEGIC (which bets are good). Strategy
// earns its way into code only once the ledger can argue for it.

import { SOURCES, LEAGUES, coverageFor, tierFor, sourceTotal } from "./sources.js";
import {
  fetchESPN, fetchClubElo, fetchClubEloRatings, fetchXGScore,
  fetchForebet, fetchSoccerStats, fetchTheSportsDB, fetchLivescore,
  fetchApiFootball, teamKey, matchTeam,
} from "./fetchers.js";

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

// Snapshot, write, read back, confirm. Same discipline as the vault's own writes:
// a green tick that has not been read back is a guess.
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
  } catch (e) {
    return {};
  }
}

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(num(v) * 100) / 100;

// The model sometimes clears its throat before the JSON. Brace-count rather than
// regex, and stay string-aware so a "}" inside a team name cannot end the object
// early. Straight port of the Stewards' Room extractor, for the same reason: a
// whole analysis should not be thrown away because the reply had a preamble.
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
  return null; // unbalanced: truncated by max_tokens
}

function parseReply(text) {
  const raw = extractJson(text);
  if (!raw) {
    const t = String(text || "").trim();
    if (!t) throw new Error("The model returned an empty reply. Try again with fewer fixtures.");
    if (t.indexOf("{") !== -1)
      throw new Error("The reply was cut off before the JSON finished — too many fixtures for one pass. Select fewer and re-run.");
    throw new Error('The model replied in prose with no JSON: "' + t.slice(0, 200) + '"');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("The reply contained JSON that would not parse (" + e.message.slice(0, 80) + "), usually a truncation. Select fewer fixtures.");
  }
}

// ---------------------------------------------------------------------------
// SOURCE GATHERING
// ---------------------------------------------------------------------------
//
// Fetch every source that covers the competitions in play, once each, in
// parallel, then index by team so a fixture can be enriched cheaply. One pull
// per source per league — not per fixture — so twelve Norwegian fixtures cost
// the same six calls as one.

// Source payloads are cached in Redis for CACHE_TTL seconds. Elo ratings, xG
// tables and league standings do not change intraday, and re-pulling six sources
// per league on every run is the bulk of the wait. Prices are NOT cached — those
// come from the SGPools mirror on the frontend, fresh every time.
const CACHE_TTL = 600; // 10 minutes

async function cached(key, ttl, produce) {
  try {
    const [hit] = await redis([["GET", key]]);
    if (hit) { const j = JSON.parse(hit); j._cached = true; return j; }
  } catch (e) { /* a cache miss must never break the pull */ }
  const fresh = await produce();
  if (fresh && fresh.ok) {
    try { await redis([["SET", key, JSON.stringify(fresh), "EX", String(ttl)]]); }
    catch (e) { /* best effort */ }
  }
  return fresh;
}

async function gatherSources(leagues, dateISO) {
  const jobs = [];
  const store = {};                   // league -> source -> payload
  const errors = [];
  const cacheHits = [];
  for (const lg of leagues) {
    store[lg] = {};
    const m = LEAGUES[lg];
    if (!m) { errors.push({ league: lg, source: "-", why: "competition not in the source registry" }); continue; }

    const take = (src, key, run) => jobs.push(
      cached(key, CACHE_TTL, run).then((r) => {
        if (r && r.ok) { store[lg][src] = r; if (r._cached) cacheHits.push(lg + "/" + src); }
        else errors.push({ league: lg, source: src, why: (r && r.error) || "no data" });
      })
    );
    const d = dateISO ? dateISO.replace(/-/g, "") : "any";
    if (m.espn)        take("espn",        "ninety:src:espn:" + m.espn + ":" + d, () => fetchESPN(m.espn, dateISO ? dateISO.replace(/-/g, "") : null));
    if (m.clubelo)     take("clubelo",     "ninety:src:clubelo:" + m.clubelo,     () => fetchClubElo(m.clubelo));
    if (m.xgscore)     take("xgscore",     "ninety:src:xgscore:" + m.xgscore,     () => fetchXGScore(m.xgscore));
    if (m.forebet)     take("forebet",     "ninety:src:forebet:" + m.forebet,     () => fetchForebet(m.forebet));
    if (m.soccerstats) take("soccerstats", "ninety:src:soccerstats:" + m.soccerstats, () => fetchSoccerStats(m.soccerstats));
    if (m.tsdb)        take("tsdb",        "ninety:src:tsdb:" + m.tsdb,               () => fetchTheSportsDB(m.tsdb));
    if (m.apifootball && SOURCES.apifootball.enabled)
      take("apifootball", "ninety:src:apif:" + m.apifootball.q + ":" + d, () => fetchApiFootball(m.apifootball, dateISO));
  }
  // LiveScore is fetched ONCE for the whole date - it returns every competition in
  // the world in one response, so per-league fetches would be the same bytes N
  // times over - then each league takes its own filtered slice by country/stage.
  const lsLeagues = leagues.filter((lg) => LEAGUES[lg] && LEAGUES[lg].livescore);
  if (lsLeagues.length && dateISO) {
    const day = dateISO.replace(/-/g, "");
    jobs.push(cached("ninety:src:livescore:" + day, CACHE_TTL, () => fetchLivescore(day))
      .then((r) => {
        if (!(r && r.ok)) { lsLeagues.forEach((lg) => errors.push({ league: lg, source: "livescore", why: (r && r.error) || "no data" })); return; }
        if (r._cached) cacheHits.push("*/livescore");
        for (const lg of lsLeagues) {
          const f = LEAGUES[lg].livescore;
          const slice = r.fixtures.filter((x) =>
            x.country.toLowerCase().includes(String(f.c).toLowerCase()) &&
            (!f.t || (x.stage || "").toLowerCase().includes(String(f.t).toLowerCase())));
          if (slice.length) store[lg].livescore = { source: "livescore", ok: true, fixtures: slice, meta: { count: slice.length } };
        }
      }));
  }
  // Elo ratings are global, so one call serves every European competition.
  let eloRatings = null;
  if (leagues.some((lg) => LEAGUES[lg] && LEAGUES[lg].clubelo)) {
    const day = new Date().toISOString().slice(0, 10);
    jobs.push(cached("ninety:src:elo:" + day, CACHE_TTL, () => fetchClubEloRatings(day))
      .then((r) => { if (r && r.ok) eloRatings = r; else errors.push({ league: "*", source: "clubelo_ratings", why: (r && r.error) || "no data" }); }));
  }
  await Promise.all(jobs);
  return { store, eloRatings, errors, cacheHits };
}

// Find a source's row for one fixture. Cross-source name matching is the whole
// problem here: ClubElo writes "Bodoe Glimt", ESPN writes "Bodo/Glimt", the
// mirror writes "Bodo Glimt". teamKey() folds all three onto one key.
function findFixture(list, home, away) {
  if (!list) return null;
  const h = teamKey(home), a = teamKey(away);
  const hit = (x, y) => {
    const kx = teamKey(x), ky = teamKey(y);
    if (!kx || !ky) return false;
    const near = (p, q) =>
      p === q || (p.length >= 4 && q.length >= 4 && (p.includes(q) || q.includes(p)));
    return near(kx, h) && near(ky, a);
  };
  return list.find((f) => hit(f.home, f.away)) || null;
}

// Assemble everything known about one fixture into a compact brief block.
// Each source's numbers are reported AS THAT SOURCE'S VIEW, never blended into
// a house number — the disagreement between them is the signal, and averaging
// destroys exactly the information worth having.
function enrichFixture(fx, store, eloRatings) {
  const lg = fx.league;
  const s = store[lg] || {};
  const out = { sources: {}, present: [] };

  if (s.espn) {
    const e = findFixture(s.espn.fixtures, fx.home, fx.away);
    if (e) {
      out.sources.espn = {
        homeForm: e.homeForm, awayForm: e.awayForm,
        homeRecord: e.homeRecord, awayRecord: e.awayRecord,
        marketProvider: e.oddsProvider, marketSpread: e.spread, marketTotal: e.overUnder,
      };
      out.present.push("espn");
    }
  }
  if (s.clubelo) {
    const c = findFixture(s.clubelo.fixtures, fx.home, fx.away);
    if (c) {
      out.sources.clubelo = {
        pHome: Math.round(c.pHome * 1000) / 10,
        pDraw: Math.round(c.pDraw * 1000) / 10,
        pAway: Math.round(c.pAway * 1000) / 10,
        fairHome: c.fairHome ? r2(c.fairHome) : null,
        fairDraw: c.fairDraw ? r2(c.fairDraw) : null,
        fairAway: c.fairAway ? r2(c.fairAway) : null,
        pOver25: Math.round(c.pOver25 * 1000) / 10,
        pOver35: Math.round(c.pOver35 * 1000) / 10,
        topScores: c.topScores.map((x) => x.score + " " + Math.round(x.p * 1000) / 10 + "%"),
      };
      out.present.push("clubelo");
    }
  }
  if (s.forebet) {
    const f = findFixture(s.forebet.fixtures, fx.home, fx.away);
    if (f) {
      out.sources.forebet = {
        pHome: f.pHome, pDraw: f.pDraw, pAway: f.pAway,
        pick: f.pick, predScore: f.predScore, avgGoals: f.avgGoals,
      };
      out.present.push("forebet");
    }
  }
  if (s.xgscore) {
    const h = matchTeam(fx.home, s.xgscore.teams);
    const a = matchTeam(fx.away, s.xgscore.teams);
    if (h || a) {
      // ptsOverperformance is the useful column: a big positive means the table
      // flatters them and their price is probably short for the wrong reason.
      out.sources.xgscore = {
        home: h ? { pos: h.pos, pts: h.pts, xpts: h.xpts, over: h.ptsOverperformance, xg: h.xg, xga: h.xga } : null,
        away: a ? { pos: a.pos, pts: a.pts, xpts: a.xpts, over: a.ptsOverperformance, xg: a.xg, xga: a.xga } : null,
      };
      out.present.push("xgscore");
    }
  }
  if (eloRatings) {
    const h = matchTeam(fx.home, eloRatings.teams);
    const a = matchTeam(fx.away, eloRatings.teams);
    if (h || a) {
      out.sources.elo = { home: h ? Math.round(h.elo) : null, away: a ? Math.round(a.elo) : null };
      out.present.push("elo");
    }
  }
  if (s.tsdb) {
    const h = matchTeam(fx.home, s.tsdb.teams);
    const a = matchTeam(fx.away, s.tsdb.teams);
    if (h || a) {
      out.sources.tsdb = { home: h || null, away: a || null, partial: !!(s.tsdb.meta || {}).partial };
      out.present.push("tsdb");
    }
  }
  if (s.livescore) {
    const f = findFixture(s.livescore.fixtures, fx.home, fx.away);
    if (f) {
      out.sources.livescore = { status: f.status, startsAt: f.startsAt, stage: f.stage };
      out.present.push("livescore");
    }
  }
  if (s.apifootball) {
    const f = findFixture(s.apifootball.fixtures, fx.home, fx.away);
    if (f) {
      out.sources.apifootball = { pHome: f.pHome, pDraw: f.pDraw, pAway: f.pAway, advice: f.advice,
                                  untested: !!(s.apifootball.meta || {}).untested };
      out.present.push("apifootball");
    }
  }
  if (s.soccerstats) {
    const h = matchTeam(fx.home, s.soccerstats.teams);
    const a = matchTeam(fx.away, s.soccerstats.teams);
    if (h || a) {
      out.sources.soccerstats = {
        home: h ? { club: h.club, raw: h.raw } : null,
        away: a ? { club: a.club, raw: a.raw } : null,
      };
      out.present.push("soccerstats");
    }
  }
  return out;
}

// Convert decimal odds to an implied probability, and report the edge a source
// implies against the price on offer. This is the number worth staring at.
function edgeVs(price, probPct) {
  if (!price || !probPct) return null;
  const p = probPct / 100;
  return Math.round((price * p - 1) * 1000) / 10;    // +EV % if positive
}

// ---------------------------------------------------------------------------
// THE BRIEF
// ---------------------------------------------------------------------------

function buildBrief(fixtures, enriched) {
  const L = [];
  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i];
    const en = enriched[i];
    const cov = coverageFor(fx.league);
    const tier = tierFor(fx.league);

    L.push("\n#### [" + fx.mirrorCode + "] " + fx.home + " v " + fx.away);
    L.push("Competition: " + fx.league + " | " + fx.matchDate + " " + (fx.kickoff || "") + " SGT");
    // Coverage stated plainly per fixture: a two-source K League read and a
    // six-source Norwegian read must not look alike in the brief.
    L.push("DATA COVERAGE: " + cov.count + " of " + cov.total + " sources carry this competition (" +
      (cov.sources.join(", ") || "none") + ")" +
      (cov.missing.length ? " | NOT available: " + cov.missing.join(", ") : ""));
    if (en.present.length < cov.count) {
      L.push("  (of those, " + en.present.length + " returned data for this specific fixture: " +
        (en.present.join(", ") || "none") + ")");
    }

    // SGPools markets, verbatim from the mirror — the only prices that exist
    L.push("SGPOOLS MARKETS (the only prices you may cite):");
    for (const mk of Object.keys(fx.markets || {})) {
      const sels = (fx.markets[mk] || []).map((s) =>
        "    " + s.selection + " @ " + s.odds +
        (s.movement != null && s.movement !== 0
          ? "  (" + (s.movement > 0 ? "+" : "") + s.movement + "% since open " + s.opening + ")"
          : "")).join("\n");
      L.push("  [" + mk + "]\n" + sels);
    }

    const S = en.sources;
    if (S.clubelo) {
      const c = S.clubelo;
      L.push("CLUBELO (independent Elo model, full scoreline distribution):");
      L.push("  P(home/draw/away) = " + c.pHome + "% / " + c.pDraw + "% / " + c.pAway + "%");
      L.push("  fair odds = " + c.fairHome + " / " + c.fairDraw + " / " + c.fairAway);
      L.push("  P(over 2.5) = " + c.pOver25 + "%, P(over 3.5) = " + c.pOver35 + "%");
      L.push("  likeliest scorelines: " + c.topScores.join(", "));
    }
    if (S.forebet) {
      const f = S.forebet;
      L.push("FOREBET (model): P = " + f.pHome + "% / " + f.pDraw + "% / " + f.pAway +
        "%, pick " + f.pick + ", predicted " + f.predScore + ", avg goals " + f.avgGoals);
    }
    if (S.xgscore) {
      const x = S.xgscore;
      const line = (t, who) => t
        ? who + ": " + t.pts + " pts vs " + t.xpts + " xPTS (" + (t.over > 0 ? "+" : "") + t.over +
          "), xG " + t.xg + " / xGA " + t.xga + ", " + t.pos + "th"
        : who + ": not found";
      L.push("XGSCORE (expected points — a big + means the table FLATTERS them):");
      L.push("  " + line(x.home, fx.home));
      L.push("  " + line(x.away, fx.away));
    }
    if (S.elo) L.push("ELO RATINGS: " + fx.home + " " + S.elo.home + " vs " + fx.away + " " + S.elo.away);
    if (S.espn) {
      const e = S.espn;
      L.push("ESPN: form " + fx.home + " " + e.homeForm + " (" + e.homeRecord + ") vs " +
        fx.away + " " + e.awayForm + " (" + e.awayRecord + ")");
      if (e.marketProvider)
        L.push("  " + e.marketProvider + " line: spread " + e.marketSpread + ", total " + e.marketTotal +
          "  <- a SECOND bookmaker's price, compare against SGPools above");
    }
    if (S.tsdb) {
      const t = S.tsdb;
      const row = (x, who) => x
        ? who + ": " + x.rank + ". P" + x.played + " " + x.w + "-" + x.d + "-" + x.l + ", GF" + x.gf + " GA" + x.ga + ", " + x.pts + " pts"
        : who + ": not in table";
      L.push("THESPORTSDB TABLE" + (t.partial ? " (PARTIAL - not the full standings)" : "") + ":");
      L.push("  " + row(t.home, fx.home));
      L.push("  " + row(t.away, fx.away));
    }
    if (S.livescore) {
      L.push("LIVESCORE: fixture confirmed on the worldwide feed (" + S.livescore.stage + ", status " + S.livescore.status + ")");
    }
    if (S.apifootball) {
      const a = S.apifootball;
      L.push("API-FOOTBALL MODEL" + (a.untested ? " (first live run - treat gently)" : "") + ": P = " +
        a.pHome + "% / " + a.pDraw + "% / " + a.pAway + "%" + (a.advice ? ", advice: " + a.advice : ""));
    }
    if (S.soccerstats) {
      const s = S.soccerstats;
      if (s.home) L.push("SOCCERSTATS " + fx.home + ": [" + s.home.raw.join(", ") + "]");
      if (s.away) L.push("SOCCERSTATS " + fx.away + ": [" + s.away.raw.join(", ") + "]");
    }

    // Pre-computed divergence. The single most useful line in the brief: where a
    // model and the tote disagree, in the tote's own currency.
    if (S.clubelo && fx.markets) {
      const oneX2 = fx.markets["1X2"] || [];
      const homeSel = oneX2[0], drawSel = oneX2[1], awaySel = oneX2[2];
      const bits = [];
      if (homeSel) { const e = edgeVs(homeSel.odds, S.clubelo.pHome); if (e != null) bits.push(fx.home + " " + (e > 0 ? "+" : "") + e + "%"); }
      if (drawSel) { const e = edgeVs(drawSel.odds, S.clubelo.pDraw); if (e != null) bits.push("Draw " + (e > 0 ? "+" : "") + e + "%"); }
      if (awaySel) { const e = edgeVs(awaySel.odds, S.clubelo.pAway); if (e != null) bits.push(fx.away + " " + (e > 0 ? "+" : "") + e + "%"); }
      if (bits.length) L.push("EDGE vs SGPools 1X2 (ClubElo probability x SGPools price - 1): " + bits.join(" | "));
    }
    if (!en.present.length)
      L.push("*** NO SOURCE RETURNED DATA FOR THIS FIXTURE. You have the SGPools prices and nothing else. Say so plainly if you propose anything here, or skip it. ***");
  }
  return L.join("\n");
}

const SYSTEM =
  "You are the analytical engine of Ninety Plus, a disciplined football staking model run by Hammy, betting through Singapore Pools (a PARIMUTUEL TOTE, not a fixed-odds bookmaker). " +
  "You are rigorous, honest, and sparing. A short slip is success, not timidity: proposing nothing on a card you cannot read is the correct outcome. " +
  "\n\nTHE TOTE MATTERS. On a pari-mutuel pool the most agreed-upon selection is by construction the most overbet one. Consensus is where the crowd's money is crushed, not where value lives. A price that looks short because 'everyone knows' the favourite wins is exactly the price to fade. " +
  "\n\nUSE THE DISAGREEMENT. Each fixture below carries several INDEPENDENT views: ClubElo (a pure Elo model with a full scoreline distribution), Forebet (a separate statistical model), xGscore (expected points, which exposes teams whose league position is luck-inflated), ESPN form and a second bookmaker's line, and SoccerSTATS tables. Where they AGREE with the SGPools price there is no edge to take. Where a model's probability implies materially better odds than SGPools is offering, that gap is the whole reason this tool exists. The EDGE line is pre-computed for you. " +
  "\n\nBEWARE THE TABLE. A team can top the league on luck. xGscore's expected-points column is the check: a large positive gap between points and xPTS means the table flatters them and their price is short for the wrong reason. A large negative gap means the opposite. Say so when it bites. " +
  "\n\nDATA COVERAGE IS NOT UNIFORM AND YOU MUST RESPECT IT. Every fixture states how many of the available sources carry its competition. Norwegian and Swedish fixtures have up to six, including Elo and xG. K League and the other Asian leagues have fewer, with NO Elo and NO xG anywhere; some of what they do have is standings-grade rather than model-grade. Thai, Singapore and Malaysian competitions may have one. A read built on two sources is not the same animal as one built on six, and you must SAY SO in the reason field rather than writing with equal confidence either way. Never imply a model backs you when no model covers that league. " +
  "\n\nHARD RULES, ENFORCED IN CODE AFTER YOU REPLY (proposing a leg that will be vetoed is worse than not proposing it): " +
  "(1) You may ONLY cite a market and selection that appears verbatim in that fixture's SGPOOLS MARKETS block. Never invent a market, never carry a price from another source. " +
  "(2) The odds you quote MUST match the scraped price exactly. " +
  "(3) State the bet type unambiguously, e.g. '1X2 straight win' or 'Asian Handicap -0.75' or 'Total Goals Over 2.5' — never a bare team name. " +
  "(4) Stakes are FLAT: $10 for a standard leg, $5 for a speculative one. Conviction changes WHETHER you bet, never HOW MUCH. " +
  "(5) Maximum 5 legs across the whole card. Depth beats volume on a negative-takeout pool. " +
  "\n\nNever invent a figure. If a source did not return data for a fixture, reason without it and say the read is thinner." +
  "\n\nBE BRIEF. This is read on a phone at the betting counter, not in a report. " +
  "cardShape: at most 2 sentences on the whole card. " +
  "Each faded entry: ONE sentence, and at most one per fixture — pick the single strongest reason you are not betting it, not every reason. " +
  "notes: at most 2 sentences for the entire card, and only if something genuinely needs flagging; leave it empty otherwise. " +
  "\n\nEACH LEG'S REASON IS A LIST, NOT A PARAGRAPH. Give 2 to 4 short points, each a single clause, ordered strongest first. " +
  "Lead with the NUMBER that makes the case — the edge, the probability gap, the rating difference — because that is what is being looked at, and a point that opens with a figure is read in a glance. " +
  "One point per idea: the edge is one point, the xPTS read is another, the form is another. Do not bundle three arguments into one sentence. " +
  "If the edge is thin, say so as a point in its own right rather than burying it. " +
  "Length is not rigour. A long paragraph explaining why you did not bet something is wasted on a reader who has already moved on.";

// ---------------------------------------------------------------------------
// CODE GATES — the law disposes
// ---------------------------------------------------------------------------
//
// Deliberately STRUCTURAL, not strategic. Each one asks a question with a
// factual answer ("does this market exist in the scrape?"), never an opinion
// ("is this a good bet?"). Strategic gates are what the ledger will eventually
// earn; asserting them now would just be encoding today's guesses as law.

const MAX_LEGS = 5;
const STAKE_STANDARD = 10;
const STAKE_SPECULATIVE = 5;

// `answeredBy` maps mirrorCode -> the source ids that actually returned data for
// THAT fixture. A competition's coverage and a fixture's coverage are different
// numbers, and the first live slip showed "6/6 sources" on a leg only four
// sources had informed. The leg must report what fed it, not what might have.
function gateLegs(rawLegs, fixtures, answeredBy) {
  const byCode = {};
  fixtures.forEach((f) => { byCode[String(f.mirrorCode)] = f; });
  const answered = answeredBy || {};

  const kept = [];
  const vetoes = [];
  const corrections = [];

  for (const raw of rawLegs) {
    const leg = {
      mirrorCode: String(raw.mirrorCode || "").trim(),
      market: String(raw.market || "").trim(),
      selection: String(raw.selection || "").trim(),
      betType: String(raw.betType || "").trim(),
      odds: num(raw.odds),
      confidence: String(raw.confidence || "").trim(),
      // Accept EITHER an array of points or a plain string. Asking for a list is a
      // request; a model under pressure will sometimes send prose anyway, and the
      // reasoning is the last thing that should be dropped for a format slip.
      reason: Array.isArray(raw.reason)
        ? raw.reason.map((x) => String(x).trim()).filter(Boolean)
        : String(raw.reason || "").trim()
            ? [String(raw.reason).trim()]
            : [],
      sourcesUsed: Array.isArray(raw.sourcesUsed) ? raw.sourcesUsed.map(String) : [],
    };
    const fx = byCode[leg.mirrorCode];
    // A vetoed leg carries its FULL proposal — the bet, the price the model
    // thought it was taking, and the reasoning — not just a rule name. If the law
    // cuts something you should be able to read what it cut and judge whether the
    // law was right. It stays out of the slip table and out of the staked total,
    // because a gate that only decorates is not a gate; but it is never silent.
    const veto = (rule, why) =>
      vetoes.push({
        ...leg,
        fixture: fx ? fx.home + " v " + fx.away : "(unknown)",
        league: fx ? fx.league : null,
        rule, why,
      });

    // GATE 1: the fixture must be one the user actually selected. A leg on a
    // fixture that was not pulled cannot be card-matched to anything.
    if (!fx) {
      veto("unknown-fixture",
        "code " + leg.mirrorCode + " is not among the fixtures pulled for this card, so it cannot be verified or placed");
      continue;
    }

    // GATE 2: the market must exist in the scrape. This is the football
    // equivalent of the card-match law: the mirror is the only authority for
    // what can actually be bet, and a market the model remembers from a
    // different fixture is not on this coupon.
    const markets = fx.markets || {};
    const marketKeys = Object.keys(markets);
    let mk = marketKeys.find((k) => k.toLowerCase() === leg.market.toLowerCase());
    if (!mk) mk = marketKeys.find((k) => k.toLowerCase().includes(leg.market.toLowerCase()) || leg.market.toLowerCase().includes(k.toLowerCase()));
    if (!mk) {
      veto("unknown-market",
        '"' + leg.market + '" is not a market scraped for this fixture (available: ' + marketKeys.join(", ") + ")");
      continue;
    }
    if (mk !== leg.market) {
      corrections.push('market "' + leg.market + '" resolved to the scraped "' + mk + '"');
      leg.market = mk;
    }

    // GATE 3: the selection must exist within that market.
    //
    // MATCH IN BOTH DIRECTIONS. The first version of this only asked whether the
    // SCRAPED name contained the PROPOSED one, which quietly assumed the model
    // always writes a substring of the coupon. It does not: on 24/07 it proposed
    // "Orgryte @ 4.8" — the selection with its price glued on — against a scraped
    // "Orgryte", so the longer string could never be found inside the shorter one.
    // The leg was vetoed with the self-contradicting message '"Orgryte @ 4.8" is
    // not a selection in [1X2] (available: Vasteras, Draw, Orgryte)', and the slip
    // then reported "no leg proposed" when a leg had in fact been proposed and
    // silently binned. A gate that lies about its own output is worse than no gate.
    const sels = markets[mk] || [];
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
    // Strip the decorations a model tends to add: a trailing "@ 4.8", a bracketed
    // note, surrounding quotes. What is left should be the bare selection.
    const bare = (s) => norm(s)
      .replace(/\s*@\s*[\d.]+\s*$/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    let sel = sels.find((s) => norm(s.selection) === norm(leg.selection));
    if (!sel) sel = sels.find((s) => bare(s.selection) === bare(leg.selection));
    if (!sel) {
      // containment, tried BOTH ways round, longest scraped match wins so that
      // "Over 2.5" cannot be satisfied by a stray "Over" somewhere in the list
      const p = bare(leg.selection);
      let best = null;
      for (const s of sels) {
        const c = bare(s.selection);
        if (c.length < 2 || p.length < 2) continue;
        if (c === p || c.includes(p) || p.includes(c)) {
          if (!best || c.length > bare(best.selection).length) best = s;
        }
      }
      sel = best;
    }
    if (!sel) {
      veto("unknown-selection",
        '"' + leg.selection + '" is not a selection in [' + mk + "] (available: " +
        sels.map((s) => s.selection).join(", ") + ")");
      continue;
    }
    if (sel.selection !== leg.selection) {
      corrections.push('selection "' + leg.selection + '" resolved to the scraped "' + sel.selection + '"');
      leg.selection = sel.selection;
    }

    // GATE 4: the price must be the scraped price. A model that misquotes odds
    // is proposing a bet that does not exist, and the whole slip is built to be
    // placed verbatim.
    if (leg.odds && Math.abs(leg.odds - sel.odds) > 0.001) {
      corrections.push(leg.selection + " odds corrected " + leg.odds + " -> " + sel.odds + " (the scraped price is authoritative)");
    }
    leg.odds = sel.odds;
    leg.opening = sel.opening != null ? sel.opening : null;
    leg.movement = sel.movement != null ? sel.movement : null;

    // GATE 5: flat staking. Conviction decides WHETHER, never HOW MUCH — the
    // one lesson from the Outsider Method that survived its own rule-decay audit.
    const spec = /spec/i.test(leg.confidence);
    leg.confidence = spec ? "Speculative" : "Standard";
    const stakeIn = parseInt(raw.stake, 10);
    leg.stake = spec ? STAKE_SPECULATIVE : STAKE_STANDARD;
    if (stakeIn && stakeIn !== leg.stake)
      corrections.push(leg.selection + " stake corrected to flat $" + leg.stake);

    // GATE 6: leg ceiling. Depth beats volume against a tote's takeout.
    if (kept.length >= MAX_LEGS) {
      veto("leg-cap", "the " + MAX_LEGS + "-leg ceiling for one card is reached — depth beats volume");
      continue;
    }

    // Carry the coverage facts onto the leg so the UI can show the caveat
    // beside the bet rather than in a footnote nobody reads.
    const cov = coverageFor(fx.league);
    const got = answered[String(fx.mirrorCode)] || [];
    leg.league = fx.league;
    leg.fixture = fx.home + " v " + fx.away;
    leg.matchDate = fx.matchDate;
    leg.kickoff = fx.kickoff || null;
    leg.coverage = {
      count: cov.count,            // what the COMPETITION has
      sources: cov.sources,
      missing: cov.missing,
      tier: tierFor(fx.league).tier,
      answered: got,               // what actually informed THIS fixture
      answeredCount: got.length,
    };
    kept.push(leg);
  }
  return { kept, vetoes, corrections };
}

// ---------------------------------------------------------------------------
// VAULT
// ---------------------------------------------------------------------------

async function vaultStats() {
  const [logRaw] = await redis([["GET", "ninety:betlog"]]);
  const log = logRaw ? JSON.parse(logRaw) : [];
  // Voided legs stay in the record but leave the figures entirely: a leg struck
  // for a reason that was not the model's fault is neither a win it earned nor a
  // loss it deserved, and counting it either way misreports the book.
  const live = log.filter((b) => String(b.ledger || "Model").toLowerCase() !== "void");
  // A void-result (match postponed) returns the stake and is likewise excluded
  // from ROI — the model never got to be right or wrong. A push IS counted,
  // because the model did make a call and the line landed exactly on it.
  const settled = live.filter((b) => ["win", "lose", "push"].includes(String(b.result || "").toLowerCase()));
  const voided = live.filter((b) => String(b.result || "").toLowerCase() === "void-result");
  const pending = live.filter((b) => String(b.result || "pending").toLowerCase() === "pending");
  const staked = r2(settled.reduce((a, b) => a + num(b.stake), 0));
  const payout = r2(settled.reduce((a, b) => a + num(b.payout), 0));
  const wins = settled.filter((b) => String(b.result).toLowerCase() === "win").length;

  // Strike and ROI by confidence tier: the question the ledger exists to answer.
  // Until it has an opinion, it should say so rather than print a lonely 0%.
  const byConf = {};
  settled.forEach((b) => {
    const c = b.confidence || "(none)";
    byConf[c] = byConf[c] || { legs: 0, staked: 0, payout: 0, wins: 0 };
    byConf[c].legs++;
    byConf[c].staked += num(b.stake);
    byConf[c].payout += num(b.payout);
    if (String(b.result).toLowerCase() === "win") byConf[c].wins++;
  });
  Object.keys(byConf).forEach((c) => {
    const x = byConf[c];
    x.staked = r2(x.staked); x.payout = r2(x.payout);
    x.net = r2(x.payout - x.staked);
    x.roi = x.staked ? Math.round((x.net / x.staked) * 1000) / 10 : 0;
    x.strike = x.legs ? Math.round((x.wins / x.legs) * 1000) / 10 : 0;
  });

  return {
    legsLoaded: live.length,
    settled: settled.length,
    pending: pending.length,
    pendingStake: r2(pending.reduce((a, b) => a + num(b.stake), 0)),
    staked, payout,
    netPL: r2(payout - staked),
    roi: staked ? Math.round(((payout - staked) / staked) * 1000) / 10 : 0,
    hits: wins,
    voided: voided.length,
    strikeRate: settled.length ? Math.round((wins / settled.length) * 1000) / 10 : 0,
    byConfidence: byConf,
    // Honest about its own youth: a strike rate off three legs is noise, and the
    // UI should be told that rather than left to imply significance.
    enoughToJudge: settled.length >= 30,
  };
}

// ---------------------------------------------------------------------------

const handler = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    const action = (req.query.action || "latest").toString();

    if (action === "coverage") {
      const lg = (req.query.league || "").toString();
      if (lg) return res.status(200).json({ league: lg, ...coverageFor(lg), tier: tierFor(lg) });
      const all = {};
      Object.keys(LEAGUES).forEach((k) => {
        const c = coverageFor(k);
        all[k] = { count: c.count, sources: c.sources, tier: tierFor(k).tier };
      });
      return res.status(200).json({ sources: SOURCES, leagues: all });
    }

    if (!R_URL || !R_TOK)
      return res.status(500).json({ error: "Redis env vars missing (UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN)" });

    if (action === "stats") return res.status(200).json(await vaultStats());

    if (action === "latest") {
      const [raw] = await redis([["GET", "ninety:proposal:latest"]]);
      if (!raw) return res.status(404).json({ error: "No proposal yet. Pull a card and analyse it." });
      return res.status(200).json(JSON.parse(raw));
    }

    if (action === "proposal") {
      const d = (req.query.date || "").toString().replace(/\//g, "");
      if (!d) return res.status(400).json({ error: "date required (DD/MM/YYYY)" });
      const [raw] = await redis([["GET", "ninety:proposal:" + d]]);
      if (!raw) return res.status(404).json({ error: "No proposal stored for " + req.query.date });
      return res.status(200).json(JSON.parse(raw));
    }

    if (action === "analyse") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      if (!AK) return res.status(500).json({ error: "ANTHROPIC_API_KEY missing (the analysis needs it)" });

      const body = parseBody(req);
      const fixtures = Array.isArray(body.fixtures) ? body.fixtures : [];
      if (!fixtures.length) return res.status(400).json({ error: "Provide fixtures as a non-empty array" });
      if (fixtures.length > 20) return res.status(400).json({ error: "Max 20 fixtures per analysis; select fewer." });

      const t0 = Date.now();
      const leagues = [...new Set(fixtures.map((f) => f.league).filter(Boolean))];
      const dateISO = fixtures[0] && fixtures[0].matchDateISO ? fixtures[0].matchDateISO : null;

      const { store, eloRatings, errors: sourceErrors, cacheHits } = await gatherSources(leagues, dateISO);
      const enriched = fixtures.map((fx) => enrichFixture(fx, store, eloRatings));
      const gatherMs = Date.now() - t0;

      // WHICH SOURCES ANSWERED, not only which failed. A list of failures alone
      // tells you what went wrong without telling you what the read actually
      // rests on, which is the number that matters when weighing the answer.
      const sourcesAnswered = leagues.map((lg) => {
        const got = Object.keys(store[lg] || {});
        const cov = coverageFor(lg);
        return {
          league: lg,
          answered: got,
          answeredCount: got.length,
          expected: cov.count,
          fixturesEnriched: fixtures
            .map((f, i) => (f.league === lg ? enriched[i].present.length : null))
            .filter((x) => x != null),
        };
      });

      const brief = buildBrief(fixtures, enriched);

      const prompt =
        "TODAY'S SELECTED FIXTURES AND EVERY SOURCE THAT COVERS THEM:\n" + brief +
        "\n\nBuild the bet slip. Respond with ONLY minified JSON, no markdown fences, exactly:\n" +
        '{"cardShape":"2-3 sentences: what this card looks like, where the value is, overall stance",' +
        '"legs":[{"mirrorCode":"","market":"exact market name from the SGPOOLS MARKETS block",' +
        '"selection":"exact selection text from that market","betType":"unambiguous, e.g. 1X2 straight win",' +
        '"odds":0,"stake":10,"confidence":"Standard|Speculative",' +
        '"reason":["2-4 short points, strongest first, each opening with its number where it has one"],' +
        '"sourcesUsed":["clubelo","forebet"]}],' +
        '"faded":[{"mirrorCode":"","fixture":"","why":"ONE sentence, one entry per fixture at most"}],' +
        '"notes":"at most 2 sentences for the whole card, or empty"}';

      const cr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 6000,
          system: SYSTEM,
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
      try { parsed = parseReply(text); }
      catch (e) { return res.status(502).json({ error: String(e.message || e) }); }

      const answeredBy = {};
      fixtures.forEach((f, i) => { answeredBy[String(f.mirrorCode)] = enriched[i].present; });
      const { kept, vetoes, corrections } = gateLegs(
        Array.isArray(parsed.legs) ? parsed.legs : [], fixtures, answeredBy);

      const matchDate = fixtures[0] ? fixtures[0].matchDate : "";
      const result = {
        ok: true,
        matchDate,
        generatedAt: new Date().toISOString(),
        cardShape: String(parsed.cardShape || ""),
        legs: kept,
        counts: {
          legs: kept.length,
          staked: r2(kept.reduce((a, l) => a + l.stake, 0)),
          standard: kept.filter((l) => l.confidence === "Standard").length,
          speculative: kept.filter((l) => l.confidence === "Speculative").length,
        },
        // One faded entry per fixture, enforced rather than requested. The first
        // live run returned four entries for two fixtures, three of them about
        // the same match. Brevity asked for in a prompt is brevity hoped for.
        faded: (Array.isArray(parsed.faded) ? parsed.faded : []).filter((f, i, arr) =>
          arr.findIndex((x) => String(x.mirrorCode || x.fixture) === String(f.mirrorCode || f.fixture)) === i),
        notes: String(parsed.notes || ""),
        // Everything the law cut, and why. A short slip must be visibly short.
        vetoes,
        corrections,
        // Which sources answered, and which competitions are thin. Surfaced as
        // its own field because coverage is a standing property of the league,
        // not a footnote on one bet.
        coverage: leagues.map((lg) => ({ league: lg, ...coverageFor(lg), tier: tierFor(lg) })),
        sourcesAnswered,
        sourceErrors,
        timing: { gatherMs, totalMs: Date.now() - t0, cacheHits: (cacheHits || []).length },
      };

      const key = "ninety:proposal:" + String(matchDate).replace(/\//g, "");
      const { verify, allMatch } = await writeVerified({
        [key]: JSON.stringify(result),
        "ninety:proposal:latest": JSON.stringify(result),
      });
      result.stored = { key, verified: allMatch, verify };
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

export default handler;

// exported for the test harness, so the suite drives the SHIPPED code
export { gateLegs, buildBrief, enrichFixture, extractJson, parseReply, edgeVs, vaultStats };

// ---- Vercel function configuration ----
// Six source fetches in parallel (~5-15s, ClubElo and football-data are the slow
// ones) and then a max_tokens 6000 Claude call over up to 20 fixtures. 120s
// matches the Stewards' Room's propose.js, which does the same shape of work.
// Declared inline deliberately: durations live next to the code they bound.
export const config = { maxDuration: 120 };
