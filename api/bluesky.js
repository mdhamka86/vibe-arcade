// api/bluesky.js
// Posts a single Wall of Words entry to the author's own Bluesky account.
//
// Opt-in only: the frontend calls this just for entries the user explicitly
// taps "Share". The private diary stays private; only chosen lines go public,
// dressed with a flight-board flourish and a running log number.
//
// No npm packages: two plain fetch calls to the AT Protocol (createSession then
// createRecord), same style as our other functions.
//
// CREDENTIALS (added in Vercel -> Settings -> Environment Variables). Each of
// you generates a Bluesky APP PASSWORD (not your real password) at
// https://bsky.app/settings/app-passwords, then we store handle + app password
// per person:
//   BSKY_HANDLE_HAMMY   e.g. hammy.bsky.social
//   BSKY_APPPW_HAMMY    e.g. xxxx-xxxx-xxxx-xxxx
//   BSKY_HANDLE_NADDY   e.g. naddy.bsky.social
//   BSKY_APPPW_NADDY
//
// App passwords are revocable any time, so this is safe: if a key ever leaks,
// revoke it in Bluesky settings and the real account password is untouched.
//
// Endpoint:
//   POST /api/bluesky   { who: "Hammy"|"Naddy", text: "...", logNo: 14 }
//   -> { ok: true, uri, url }

const PDS = "https://bsky.social";

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

// flight-board flourish for a TEXT diary entry, prepended above the user's words
function buildPost(who, text, logNo) {
  const rank = who === "Naddy" ? "Pilot" : "Navigator";
  const n = Number.isFinite(logNo) ? logNo : 1;
  const num = String(n).padStart(3, "0");
  const header = `\u2708 SIN \u2192 HKT \u00b7 log #${num}\n${rank} ${who} \u00b7 #MissionPhuket`;
  // Bluesky's hard limit is 300 graphemes; keep the body trimmed so header fits.
  const room = 300 - header.length - 2;
  let body = String(text || "").trim();
  if (body.length > room) body = body.slice(0, Math.max(0, room - 1)).trimEnd() + "\u2026";
  return `${header}\n\n${body}`;
}

// flight-board flourish for a PHOTO submission. Funny "filed under quest" caption.
function buildPhotoCaption(who, questTitle, logNo) {
  const rank = who === "Naddy" ? "Pilot" : "Navigator";
  const n = Number.isFinite(logNo) ? logNo : 1;
  const num = String(n).padStart(3, "0");
  const quest = String(questTitle || "an unfiled moment").trim();
  // playful "evidence submitted to the mission archive" framing
  return `\u2708 SIN \u2192 HKT \u00b7 log #${num}\n` +
    `${rank} ${who} files photographic evidence under:\n\u201c${quest}\u201d \ud83c\udf96\ufe0f\n#MissionPhuket`;
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

  let body;
  try { body = await readJsonBody(req); }
  catch (e) { res.status(400).json({ error: "Bad request", detail: String(e.message || e) }); return; }

  const who = body && body.who === "Naddy" ? "Naddy" : body && body.who === "Hammy" ? "Hammy" : null;
  const text = body && typeof body.text === "string" ? body.text.trim() : "";
  const imageUrl = body && typeof body.imageUrl === "string" ? body.imageUrl : "";
  const questTitle = body && typeof body.questTitle === "string" ? body.questTitle : "";
  const logNo = body && Number(body.logNo);
  if (!who) { res.status(400).json({ error: "Bad request", detail: "Unknown author." }); return; }
  if (!text && !imageUrl) { res.status(400).json({ error: "Bad request", detail: "Nothing to post." }); return; }

  // Credentials come EITHER from the request body (the user logged in on their
  // own device; we use them for this one post and never store them) OR, as a
  // fallback, from env vars. The in-app login is the primary path now.
  const bodyHandle = body && typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "") : "";
  const bodyApppw = body && typeof body.apppw === "string" ? body.apppw.trim() : "";
  const handle = bodyHandle || process.env[`BSKY_HANDLE_${who.toUpperCase()}`];
  const apppw = bodyApppw || process.env[`BSKY_APPPW_${who.toUpperCase()}`];
  if (!handle || !apppw) {
    res.status(401).json({
      error: "Bluesky login needed",
      detail: "No Bluesky credentials. Log in on this device to share.",
    });
    return;
  }

  try {
    // 1) create a session (login with the app password)
    const sessRes = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: handle, password: apppw }),
    });
    if (!sessRes.ok) {
      let d = `Login failed (${sessRes.status})`;
      try { const j = await sessRes.json(); d = j.message || d; } catch (e) {}
      res.status(502).json({ error: "Bluesky login failed", detail: d });
      return;
    }
    const sess = await sessRes.json();
    const accessJwt = sess.accessJwt;
    const did = sess.did;
    if (!accessJwt || !did) { res.status(502).json({ error: "Bluesky login odd", detail: "No session token returned." }); return; }

    // 2) build the record, optionally with an embedded image
    let record;
    if (imageUrl) {
      // fetch the photo bytes from our public Blob, then upload to Bluesky
      const imgRes = await fetch(imageUrl, { cache: "no-store" });
      if (!imgRes.ok) { res.status(502).json({ error: "Photo fetch failed", detail: `Could not load the photo (${imgRes.status}).` }); return; }
      const ctype = imgRes.headers.get("content-type") || "image/jpeg";
      const mime = ctype.startsWith("image/") ? ctype : "image/jpeg";
      const bytes = Buffer.from(await imgRes.arrayBuffer());
      if (bytes.length > 1000000 * 2) {
        res.status(413).json({ error: "Photo too big for Bluesky", detail: "Bluesky caps images at ~2MB. This one's heftier; share it as text or try another." });
        return;
      }
      const blobRes = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
        method: "POST",
        headers: { "Content-Type": mime, Authorization: `Bearer ${accessJwt}` },
        body: bytes,
      });
      if (!blobRes.ok) {
        let d = `Blob upload failed (${blobRes.status})`;
        try { const j = await blobRes.json(); d = j.message || d; } catch (e) {}
        res.status(502).json({ error: "Bluesky image upload failed", detail: d });
        return;
      }
      const blobJson = await blobRes.json();
      const caption = buildPhotoCaption(who, questTitle, logNo);
      record = {
        $type: "app.bsky.feed.post",
        text: caption,
        createdAt: new Date().toISOString(),
        langs: ["en"],
        embed: {
          $type: "app.bsky.embed.images",
          images: [{ alt: `Mission Phuket photo: ${questTitle || "a moment"}`, image: blobJson.blob }],
        },
      };
    } else {
      record = {
        $type: "app.bsky.feed.post",
        text: buildPost(who, text, logNo),
        createdAt: new Date().toISOString(),
        langs: ["en"],
      };
    }

    const postRes = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessJwt}` },
      body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record }),
    });
    if (!postRes.ok) {
      let d = `Post failed (${postRes.status})`;
      try { const j = await postRes.json(); d = j.message || d; } catch (e) {}
      res.status(502).json({ error: "Bluesky post failed", detail: d });
      return;
    }
    const posted = await postRes.json();
    // build a friendly web URL from the at:// uri
    let url = "";
    try {
      const rkey = String(posted.uri).split("/").pop();
      url = `https://bsky.app/profile/${handle}/post/${rkey}`;
    } catch (e) {}

    res.status(200).json({ ok: true, uri: posted.uri, url });
  } catch (err) {
    res.status(500).json({ error: "Bluesky error", detail: String((err && err.message) || err) });
  }
}
