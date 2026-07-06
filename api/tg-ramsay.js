// api/tg-ramsay.js
// Chef Gordon Ramsay presides over the weekly Touch Grass HKT scrapbook.
//
// Once a week closes, the frontend sends the whole trawled week (a slim summary
// built by roastSummary(): every claim, caption, taunt, memory-wall thought and
// moment, dare and confession, duel verdict, and the quiz result). This endpoint
// asks Claude to step into Gordon Ramsay's shoes and hand out a spread of
// genuinely EARNED awards in his voice: savage, funny, sweary-ish (kept the
// right side of the line), with the rare tender flip he's loved for.
//
// Same spirit as the Michael Oliver judging endpoints: one model call, strict
// JSON out, graceful failure. No npm packages, two plain fetch-free steps (the
// Anthropic call is the only network hop). The frontend has its own demo roast
// fallback, so if this endpoint errors or is slow, the ceremony still lands.
//
// Endpoint:
//   POST /api/tg-ramsay   { wk, claims:[...], moments:[...], thoughts:[...],
//                           dares:[...], duels:[...], quiz:{...}, scores:{...} }
//   -> { intro: "...", awards: [ { title, line }, ... ] }
//
// Model: Claude Haiku is plenty for this and keeps it a fraction of a cent a
// roast, exactly as the scrapbook was costed before.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(new Error("Bad JSON body")); }
    });
    req.on("error", reject);
  });
}

// Turn the trawled week into a compact, readable brief for the chef. We keep
// this text-only (no image bytes): Gordon judges on the words, the effort, the
// tallies, and the cheek, which is all present in the summary.
function buildBrief(week) {
  const lines = [];
  const nm = (x) => (x === "Hammy" || x === "Naddy") ? x : "someone";

  const sc = week.scores || {};
  lines.push(`WEEK ${week.wk}. Score so far — Hammy ${sc.Hammy || 0}, Naddy ${sc.Naddy || 0}.`);

  if (Array.isArray(week.claims) && week.claims.length) {
    lines.push("\nTASKS CLAIMED:");
    week.claims.forEach((c) => {
      lines.push(`- ${nm(c.by)} claimed "${c.task}"${c.hasPhoto ? " (with photo)" : " (no photo)"}${c.overturned ? " [OVERTURNED by appeal]" : ""}.`
        + (c.caption ? ` Caption: "${c.caption}".` : "")
        + (c.taunt ? ` Taunt: "${c.taunt}".` : ""));
    });
  }
  if (Array.isArray(week.moments) && week.moments.length) {
    lines.push("\nMOMENTS SNAPPED (memory wall photos):");
    week.moments.forEach((m) => lines.push(`- ${nm(m.by)}${m.starred ? " (starred)" : ""}: ${m.text ? '"' + m.text + '"' : "(just a photo)"}.`));
  }
  if (Array.isArray(week.thoughts) && week.thoughts.length) {
    lines.push("\nTHOUGHTS PENNED (memory wall):");
    week.thoughts.forEach((t) => lines.push(`- ${nm(t.by)}${t.starred ? " (starred)" : ""}: "${t.text}".`));
  }
  if (Array.isArray(week.dares) && week.dares.length) {
    lines.push("\nDARES THROWN:");
    week.dares.forEach((d) => lines.push(`- ${nm(d.from)} dared ${nm(d.to)}: "${d.text}" — result: ${d.result}.`
      + (d.secret ? ` They bottled it and confessed: "${d.secret}".` : "")));
  }
  if (Array.isArray(week.duels) && week.duels.length) {
    lines.push("\nPHOTO DUELS:");
    week.duels.forEach((du) => lines.push(`- ${du.kind}${du.theme ? " (" + du.theme + ")" : ""}: winner ${du.verdict && du.verdict.winner ? du.verdict.winner : "undecided"}.`));
  }
  if (week.quiz) {
    const h = week.quiz.hammy ? week.quiz.hammy.score : "didn't sit it";
    const n = week.quiz.naddy ? week.quiz.naddy.score : "didn't sit it";
    lines.push(`\nCOACH SALIBA'S THAI TEST: Hammy ${h}, Naddy ${n}. Winner: ${week.quiz.winner || "none"}.`);
  }
  return lines.join("\n");
}

const SYSTEM = [
  "You ARE Chef Gordon Ramsay, guest-judging a playful weekly scrapbook for a",
  "married couple, Hammy (a Spurs fan) and Naddy (an Arsenal fan), who've just",
  "moved to Phuket with their five cats and compete in a friendly weekly",
  "photo-and-taunt game called Touch Grass HKT.",
  "",
  "Read the week below and hand out 4 to 6 AWARDS. Be unmistakably Gordon:",
  "explosive, hilarious, brutally specific, mildly sweary (damn, hell, bloody,",
  "'you donkey' — nothing stronger, keep it broadcastable). Roast the weak efforts,",
  "the limp captions, the deluded taunts, the bottled dares. BUT you're famous for",
  "the rare tender flip too, so make ONE award genuinely, disarmingly sweet —",
  "usually about the two of them building a life together far from home.",
  "",
  "Each award needs a punchy TITLE (e.g. 'Worst Quip', 'Laziest Effort',",
  "'Chef's Kiss', 'The Bottler's Medal') and a LINE of 1-3 sentences in your voice",
  "that references the ACTUAL content — name the real task, quote the real caption,",
  "call out who did what. Generic roasts are worthless; specificity is everything.",
  "Also write a short INTRO line reacting to who's leading.",
  "",
  "Reply as STRICT JSON only, no markdown, no preamble:",
  '{"intro":"...","awards":[{"title":"...","line":"..."},...]}',
].join("\n");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "No ANTHROPIC_API_KEY configured." }); return; }

  let week;
  try { week = await readJsonBody(req); }
  catch (e) { res.status(400).json({ error: "Bad request", detail: String(e.message || e) }); return; }

  const brief = buildBrief(week || {});

  try {
    const aiRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        system: SYSTEM,
        messages: [{ role: "user", content: "Here is the week. Judge it, chef:\n\n" + brief }],
      }),
    });

    if (!aiRes.ok) {
      let d = `Judge unavailable (${aiRes.status})`;
      try { const j = await aiRes.json(); d = (j.error && j.error.message) || d; } catch (e) {}
      res.status(502).json({ error: "Chef walked out", detail: d });
      return;
    }

    const data = await aiRes.json();
    const text = (data.content || []).map((b) => (b && b.type === "text" ? b.text : "")).join("").trim();

    // Parse the strict JSON, tolerating stray code fences just in case.
    let parsed = null;
    try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch (e) {}
    if (!parsed || !Array.isArray(parsed.awards) || !parsed.awards.length) {
      res.status(502).json({ error: "Chef mumbled", detail: "Could not parse the verdict." });
      return;
    }

    // Sanitise: keep only well-formed awards, cap at 6.
    const awards = parsed.awards
      .filter((a) => a && typeof a.title === "string" && typeof a.line === "string")
      .slice(0, 6)
      .map((a) => ({ title: a.title.slice(0, 80), line: a.line.slice(0, 600) }));

    res.status(200).json({
      intro: typeof parsed.intro === "string" ? parsed.intro.slice(0, 400) : "",
      awards,
    });
  } catch (err) {
    res.status(500).json({ error: "Ramsay error", detail: String((err && err.message) || err) });
  }
}
