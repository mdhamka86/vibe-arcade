// api/picme.js
// Doctor Picme TM, the Memory Wall's resident AI photography judge.
//
// Takes a photo URL (already public, hosted on Vercel Blob) plus a tiny bit of
// quest context, sends it to Claude Haiku 4.5 (the cheapest vision-capable
// model) with a dramatic-diva judge persona, and returns a letter grade and a
// short sassy verdict.
//
// This costs real money (drawn from your Anthropic credit), but only a fraction
// of a cent per call. We keep it cheap on purpose:
//   - Haiku 4.5 is the cheapest current model ($1 / $5 per million tokens).
//   - The frontend already resized photos to ~1200px, so the image is small.
//   - We cap output tokens hard, so a runaway verdict can't run up a bill.
//
// No npm packages: we call the Anthropic REST API directly with fetch, same
// style as api/mission.js talking to Upstash.
//
// Needs ONE env var you add in the Vercel dashboard (Settings -> Environment
// Variables), from your Anthropic account at console.anthropic.com:
//   ANTHROPIC_API_KEY
//
// Endpoint:
//   POST /api/picme   { url, questTitle?, quirk? }
//   -> { ok: true, grade: "A", verdict: "..." }

const MODEL = "claude-haiku-4-5-20251001";
const GRADES = ["S", "A", "B", "C", "F"];

// fetch the image bytes and turn them into base64 for the Anthropic API.
// (The API can take a URL source too, but fetching ourselves keeps it robust
// and lets us guard the size.)
async function fetchImageBase64(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not fetch image (${res.status})`);
  const ctype = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5 * 1024 * 1024) throw new Error("Image too large to judge");
  const media = ctype.startsWith("image/") ? ctype : "image/jpeg";
  return { data: buf.toString("base64"), media };
}

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Doctor Picme is off duty",
      detail: "ANTHROPIC_API_KEY is missing. Add it in the Vercel dashboard (Settings, Environment Variables), then redeploy.",
    });
    return;
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { res.status(400).json({ error: "Bad request", detail: String(e.message || e) }); return; }

  const url = body && body.url;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Bad request", detail: "No photo url provided." });
    return;
  }
  const questTitle = (body.questTitle && String(body.questTitle).slice(0, 120)) || "an unlabelled moment";
  const quirk = (body.quirk && String(body.quirk).slice(0, 200)) || "";

  try {
    const img = await fetchImageBase64(url);

    const sys =
      "You are Doctor Picme, a legendary, theatrical, devastatingly perceptive " +
      "photography critic judging photos on a couple's 'moving from Singapore to " +
      "Phuket' memory wall. The couple are Hammy (Tottenham fan) and Naddy, plus " +
      "their five cats. Your whole shtick: you are FLAMBOYANT and absurd, but your " +
      "eye is genuinely razor-sharp. You notice the tiny specific things a real " +
      "world-class critic would, the exact tilt of a cat's ears, a half-packed box " +
      "in the corner, a reflection, the quality of the light, a stray cable, someone's " +
      "expression, the one sad houseplant, the composition, what's IN focus versus " +
      "what isn't, and you name those real details precisely. Then you spin them into " +
      "a dramatic, very funny verdict. The comedy comes FROM the accuracy: you see " +
      "everything, and you have OPINIONS. Warm, never mean; an F is affectionate " +
      "roasting, an S is reserved for transcendent vibes.\n\n" +
      "You judge on five categories: Cat Cooperation, Chaos Energy, Emotional Damage, " +
      "Technical Merit (which you loudly insist barely matters), and Vibes (the only " +
      "thing that truly counts). You ALWAYS give one overall letter grade: S, A, B, C, or F.\n\n" +
      "Respond ONLY with a compact JSON object, no markdown fences, in EXACTLY this form:\n" +
      '{"grade":"A","verdict":"1-2 punchy in-character sentences naming a real detail you see",' +
      '"notes":[{"cat":"Cat Cooperation","line":"short witty take referencing the actual photo"},' +
      '{"cat":"Chaos Energy","line":"..."},{"cat":"Emotional Damage","line":"..."},' +
      '{"cat":"Technical Merit","line":"..."},{"cat":"Vibes","line":"..."}]}\n' +
      "Every 'line' must reference something genuinely visible in THIS photo, not generic " +
      "filler. Keep each line under 140 characters and the verdict under 240. Be specific, " +
      "be observant, be hilarious.";

    const userText =
      `This photo was submitted for the quest: "${questTitle}".` +
      (quirk ? ` Bonus brief: ${quirk}.` : "") +
      " Examine it closely and judge it, Doctor. Notice the real details.";

    const payload = {
      model: MODEL,
      max_tokens: 700,
      system: sys,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: img.media, data: img.data } },
            { type: "text", text: userText },
          ],
        },
      ],
    };

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    if (!aiRes.ok) {
      let detail = `Anthropic API error ${aiRes.status}`;
      try { const j = await aiRes.json(); detail = (j.error && j.error.message) || detail; } catch (e) {}
      res.status(502).json({ error: "Picme stumbled", detail });
      return;
    }

    const data = await aiRes.json();
    const text = Array.isArray(data.content)
      ? data.content.map(b => (b.type === "text" ? b.text : "")).join("").trim()
      : "";

    // parse the JSON Picme returned, tolerating stray fences just in case
    let grade = "B", verdict = "Doctor Picme is speechless. That's rare.", notes = [];
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed.grade === "string") {
        const g = parsed.grade.trim().toUpperCase().slice(0, 1);
        grade = GRADES.includes(g) ? g : "B";
      }
      if (parsed && typeof parsed.verdict === "string") {
        verdict = parsed.verdict.trim().slice(0, 260);
      }
      if (parsed && Array.isArray(parsed.notes)) {
        notes = parsed.notes
          .filter(n => n && typeof n.cat === "string" && typeof n.line === "string")
          .slice(0, 5)
          .map(n => ({ cat: String(n.cat).slice(0, 40), line: String(n.line).slice(0, 180) }));
      }
    } catch (e) {
      // model didn't return clean JSON; salvage a verdict from the raw text
      if (text) verdict = text.slice(0, 260);
    }

    res.status(200).json({ ok: true, grade, verdict, notes });
  } catch (err) {
    res.status(500).json({ error: "Picme error", detail: String((err && err.message) || err) });
  }
}
