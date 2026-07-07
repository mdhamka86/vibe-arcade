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
    .map((l, i) => i + 1 + ". " + l.title.toUpperCase() + "\n   " + l.rule)
    .join("\n\n");
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
        "You do NOT chase winners; the model's proven edge is fading overbet WIN favourites and milking the place pool on Medium-High convergence spots. A short, selective, PLA-heavy book is success, not timidity. " +
        "Every horse number you cite MUST come from the runner map in the pack (the SGPools coupon card). If you cannot confirm a number there, flag it UNCONFIRMED. Never invent a number from tipster ordering.";

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
              corrections.push(
                "card-match note: R" + leg.raceNo + " #" + leg.horseNo + " " + leg.meet +
                  " is '" + cardName + "' on the SGPools card (model said '" + leg.horseName + "') — using the card name"
              );
              leg.horseName = cardName;
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
        "The proven spine of the model is already known: flat staking, fading overbet WIN favourites, milking the place pool on Medium-High convergence. Only flag these if this day genuinely reinforces or challenges them.";

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
