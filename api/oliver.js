// api/oliver.js
// Michael Oliver, the VAR booth's resident AI judge for Touch Grass HKT.
//
// Takes a photo URL (already public, hosted on Vercel Blob) plus the task the
// claim was made against, sends it to Claude Haiku 4.5 (the cheapest vision
// model) with a warm, fair, wonderfully-particular referee persona, and returns
// a verdict: does the photo genuinely show the task completed? uphold | overturn.
//
// Modelled directly on api/picme.js from Mission Phuket. Same proven shape:
//   - no npm packages, we call the Anthropic REST API directly with fetch
//   - Haiku 4.5 (cheapest vision model), output tokens capped hard so a runaway
//     verdict can never run up a bill (a fraction of a cent per call)
//   - graceful handling of a missing key, a bad request, an oversized image,
//     and malformed JSON coming back
//
// Michael Oliver is written to be FAIR and a little generous: he only overturns
// when the photo clearly fails to show the task. He judges the picture, never
// the person who submitted it. Blind to who, sharp-eyed to what.
//
// Needs ONE env var you add in the Vercel dashboard (Settings -> Environment
// Variables), from console.anthropic.com:
//   ANTHROPIC_API_KEY
//
// Endpoint:
//   POST /api/oliver   { url, taskTitle?, taskBlurb?, accuserNote? }
//   -> { ok: true, verdict: "uphold"|"overturn", line: "one warm in-character sentence" }

const MODEL = "claude-haiku-4-5-20251001";

// fetch the image bytes and turn them into base64 for the Anthropic API.
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
      error: "Michael Oliver is off duty",
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
  const taskTitle = (body.taskTitle && String(body.taskTitle).slice(0, 120)) || "an unlabelled task";
  const taskBlurb = (body.taskBlurb && String(body.taskBlurb).slice(0, 400)) || "";
  const accuserNote = (body.accuserNote && String(body.accuserNote).slice(0, 300)) || "";

  try {
    const img = await fetchImageBase64(url);

    const sys =
      "You are Michael Oliver, working the VAR booth for a playful two-person " +
      "challenge game in Phuket. The two players are Hammy (a Tottenham fan) and " +
      "Naddy (an Arsenal fan), a married couple who go out and do little challenges " +
      "together. You are warm, fair, and wonderfully particular: hyper-focused on " +
      "details, you like the evidence lined up just so, you draw your careful little " +
      "lines, and you are prone to a gentle tangent. It is an affectionate, neuro" +
      "divergent-coded character, always kind, never a caricature.\n\n" +
      "Your ONE job: look at the photo and decide whether it genuinely shows the " +
      "task completed. You judge the PICTURE, never the person who submitted it. " +
      "You are fair and a little generous: only overturn if the photo CLEARLY fails " +
      "to show the task. If it plausibly shows it, uphold. Benefit of the doubt goes " +
      "to the claim. You notice real, specific things in the image and name them.\n\n" +
      "Respond ONLY with a compact JSON object, no markdown fences, EXACTLY:\n" +
      '{"verdict":"uphold","line":"one warm, in-character sentence naming a real detail you see"}\n' +
      "verdict is either \"uphold\" (the claim is good, it stands) or \"overturn\" " +
      "(the photo does not show the task). The 'line' must reference something " +
      "genuinely visible in THIS photo, stay under 200 characters, and sound like you.";

    const userText =
      `The task claimed is: "${taskTitle}".` +
      (taskBlurb ? ` What counts as done: ${taskBlurb}.` : "") +
      (accuserNote ? ` The opponent's doubt: ${accuserNote}.` : "") +
      " Examine the photo closely and rule, Michael. Judge the picture, not the person. Be fair.";

    const payload = {
      model: MODEL,
      max_tokens: 300,
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
      res.status(502).json({ error: "The VAR booth stumbled", detail });
      return;
    }

    const data = await aiRes.json();
    const text = Array.isArray(data.content)
      ? data.content.map(b => (b.type === "text" ? b.text : "")).join("").trim()
      : "";

    // parse the JSON Oliver returned, tolerating stray fences just in case.
    // Default to UPHOLD if anything is unclear: fair, and never punishes on a glitch.
    let verdict = "uphold", line = "I've looked at it properly, and I'm satisfied. The claim stands.";
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed.verdict === "string") {
        const v = parsed.verdict.trim().toLowerCase();
        verdict = v === "overturn" ? "overturn" : "uphold";
      }
      if (parsed && typeof parsed.line === "string") {
        line = parsed.line.trim().slice(0, 220);
      }
    } catch (e) {
      // model didn't return clean JSON; salvage a line, keep the fair default verdict
      if (text) line = text.slice(0, 220);
    }

    res.status(200).json({ ok: true, verdict, line });
  } catch (err) {
    res.status(500).json({ error: "Michael Oliver error", detail: String((err && err.message) || err) });
  }
}
