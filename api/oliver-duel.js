// api/oliver-duel.js
// -----------------------------------------------------------------------------
// Michael Oliver judges the BIG-ONE DUEL.
//
// This is the backend brain for the weekly head-to-head. It receives TWO photo
// URLs (Hammy's and Naddy's) plus the challenge details, looks at both, and
// crowns a winner with a full, honest, gleefully funny written verdict in
// Michael Oliver's particular pompous-but-loveable refereeing voice.
//
// It's a sibling of api/oliver.js (the appeal judge). Same Anthropic call, same
// key handling, just a different job: COMPARE, don't rule on one claim.
//
// Drop this file in your /api folder alongside oliver.js and tg-photo.js, commit,
// and Vercel will deploy it at /api/oliver-duel automatically.
//
// Expects POST JSON: { hammyUrl, naddyUrl, taskTitle, taskBlurb }
// Returns JSON:       { winner: "Hammy" | "Naddy", reason: "..." }
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  try {
    const { hammyUrl, naddyUrl, taskTitle, taskBlurb } = req.body || {};

    if (!hammyUrl || !naddyUrl) {
      res.status(400).json({ error: "Both hammyUrl and naddyUrl are required." });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
      return;
    }

    // Fetch both images and hand them to the model as base64, so it genuinely
    // sees them rather than being told about them.
    async function toBase64(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error("image fetch failed");
      const buf = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get("content-type") || "image/jpeg";
      const media = type.includes("png") ? "image/png"
        : type.includes("webp") ? "image/webp" : "image/jpeg";
      return { media, data: buf.toString("base64") };
    }

    const [hImg, nImg] = await Promise.all([toBase64(hammyUrl), toBase64(naddyUrl)]);

    const system = [
      "You are Michael Oliver, the Premier League referee, moonlighting as the",
      "photo judge for a Phuket scavenger game between a husband (Hammy, Spurs fan)",
      "and his wife (Naddy, Arsenal fan). You are pompous, precise, unshakeably",
      "confident, and secretly warm. You judge two photos of the same challenge and",
      "crown the better one.",
      "",
      "RULES:",
      "- Judge honestly on the actual merits: composition, effort, light, how well",
      "  it captures the challenge, wit, and sheer charm. Do NOT just flip a coin.",
      "- Pick exactly ONE winner. No draws (you always make the call; that's the job).",
      "- Your reason must be GENUINELY funny: dry, refereeing metaphors (offside,",
      "  bookings, VAR, the monitor, half-time, dissent), delivered with total",
      "  authority. Roast the loser affectionately. Keep the household rivalry alive.",
      "- Be specific about what you actually SEE in each photo. That's what makes it",
      "  land and feel fair.",
      "- 2 to 4 sentences. No hedging. The decision is always 'final' and 'correct'.",
      "",
      "Respond with ONLY a JSON object, no preamble, no markdown:",
      '{"winner": "Hammy" or "Naddy", "reason": "your funny verdict"}',
    ].join("\n");

    const userText =
      "The challenge: \"" + (taskTitle || "the big one") + "\"" +
      (taskBlurb ? ("\n" + taskBlurb) : "") +
      "\n\nFirst image is HAMMY's photo. Second image is NADDY's photo. Judge them.";

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "text", text: "HAMMY's photo:" },
            { type: "image", source: { type: "base64", media_type: hImg.media, data: hImg.data } },
            { type: "text", text: "NADDY's photo:" },
            { type: "image", source: { type: "base64", media_type: nImg.media, data: nImg.data } },
          ],
        },
      ],
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: "model call failed", detail: t.slice(0, 300) });
      return;
    }

    const data = await r.json();
    const text = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    // Parse the JSON the model returned, tolerating stray markdown fences.
    let parsed = null;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (e) {
      // Last-ditch: pull the first {...} block out of the text.
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } }
    }

    const winner = parsed && (parsed.winner === "Hammy" || parsed.winner === "Naddy")
      ? parsed.winner : "Hammy";
    const reason = parsed && typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : "After extensive review at the monitor, the decision stands. It is a fine margin, but a referee is paid to decide, and decide I have.";

    res.status(200).json({ winner, reason });
  } catch (err) {
    res.status(500).json({ error: "duel judge crashed", detail: String(err).slice(0, 300) });
  }
}
