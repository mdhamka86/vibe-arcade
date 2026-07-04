// api/farang.js
// Pocket Farang, the two-way English <-> Thai translator for Touch Grass HKT.
//
// Takes a bit of text and a direction, returns a faithful, idiomatic, script-
// correct translation. Thai is one of only a couple of languages where this
// model genuinely beats Google Translate, so it is a happy fit for Ko Kaeo life.
//
// Modelled directly on api/oliver.js and api/gordon.js. Same proven shape:
//   - no npm packages, direct fetch to the Anthropic REST API
//   - Claude Haiku 4.5 (cheapest model); translation is text-only and featherlight,
//     a fraction of a cent per phrase, output capped so it can never run away
//   - graceful handling of missing key / bad body / malformed response
//
// Follows Anthropic's own multilingual guidance: name BOTH languages explicitly,
// ask for idiomatic native-speaker phrasing, use native Thai script, and mind the
// cultural courtesy. Thai politeness particles are gendered to the speaker, so we
// pass the speaker (Hammy -> "kráp", Naddy -> "kâ") and ask for the right ending
// on polite phrases, so both of them sound gracious rather than brusque.
//
// Needs the same ONE env var the other AI features use, from console.anthropic.com:
//   ANTHROPIC_API_KEY
//
// Endpoint:
//   POST /api/farang  { text, dir:"en2th"|"th2en", speaker?:"Hammy"|"Naddy" }
//   -> { ok:true, translation:"...", romanised:"..." (for th results), note?:"..." }

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "Pocket Farang is offline",
      detail: "ANTHROPIC_API_KEY is missing. Add it in the Vercel dashboard (Settings, Environment Variables), then redeploy.",
    });
    return;
  }

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { res.status(400).json({ error: "Bad request", detail: String(e.message || e) }); return; }

  const text = (body.text && String(body.text).slice(0, 1000)) || "";
  if (!text.trim()) { res.status(400).json({ error: "Bad request", detail: "No text to translate." }); return; }
  const dir = body.dir === "th2en" ? "th2en" : "en2th";
  const speaker = body.speaker === "Naddy" ? "Naddy" : (body.speaker === "Hammy" ? "Hammy" : null);
  const particle = speaker === "Naddy" ? "kâ (ค่ะ)" : speaker === "Hammy" ? "kráp (ครับ)" : null;

  const toThai = dir === "en2th";
  const sys = toThai
    ? ("You are an expert English-to-Thai translator for a couple living in Phuket. " +
       "Translate the user's English into natural, idiomatic Thai as a friendly native " +
       "speaker would actually say it, not word-for-word. Use correct Thai script. " +
       (particle ? ("The speaker is " + speaker + ", so where a polite ending fits, use " +
         particle + ". ") : "") +
       "Respond ONLY with compact JSON, no markdown fences, EXACTLY:\n" +
       '{"translation":"<thai script>","romanised":"<easy phonetic reading>","note":"<optional one short tip, or empty>"}')
    : ("You are an expert Thai-to-English translator for a couple living in Phuket. " +
       "Translate the user's Thai into natural, clear English capturing the real meaning, " +
       "tone, and any politeness or warmth. If the Thai is ambiguous or looks mis-heard, " +
       "give your best reading and say so briefly in the note. " +
       "Respond ONLY with compact JSON, no markdown fences, EXACTLY:\n" +
       '{"translation":"<english>","romanised":"","note":"<optional one short tip, or empty>"}');

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        temperature: 0.2,
        system: sys,
        messages: [{ role: "user", content: text }],
      }),
    });

    if (!aiRes.ok) {
      let detail = "Anthropic API error " + aiRes.status;
      try { const j = await aiRes.json(); detail = (j.error && j.error.message) || detail; } catch (e) {}
      res.status(502).json({ error: "Pocket Farang stumbled", detail });
      return;
    }

    const data = await aiRes.json();
    const raw = Array.isArray(data.content)
      ? data.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim()
      : "";

    let parsed = null;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch (e) { parsed = null; }

    if (parsed && typeof parsed.translation === "string") {
      res.status(200).json({
        ok: true,
        translation: parsed.translation.trim(),
        romanised: typeof parsed.romanised === "string" ? parsed.romanised.trim() : "",
        note: typeof parsed.note === "string" ? parsed.note.trim() : "",
      });
      return;
    }

    // model didn't return clean JSON: fall back to the raw text as the translation
    res.status(200).json({ ok: true, translation: raw.slice(0, 400), romanised: "", note: "" });
  } catch (err) {
    res.status(500).json({ error: "Pocket Farang error", detail: String((err && err.message) || err) });
  }
}
