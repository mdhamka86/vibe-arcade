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

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};

module.exports._packBrief = packBrief;
module.exports._charterText = charterText;
