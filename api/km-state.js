// ============================================================================
//  api/km-state.js  —  Know Me async state engine
//  Vercel serverless function + Upstash Redis (REST)
//
//  Mirrors the tg-state.js pattern from vibe-arcade:
//   - each player writes ONLY their own slice (no true write conflict)
//   - MONOTONIC MERGE: never overwrite a set field with an empty one
//   - returns the merged room so the client can TRUST it (no re-fetch race)
//
//  ENV VARS required on Vercel (same ones Touch Grass uses):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
// ============================================================================

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24; // 24h — games are ephemeral

// ---- tiny Upstash REST helpers -------------------------------------------
async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error("redis " + res.status);
  const j = await res.json();
  return j.result;
}
async function getRoom(code) {
  const raw = await redis(["GET", "game:" + code]);
  return raw ? JSON.parse(raw) : null;
}
async function setRoom(code, room) {
  await redis(["SET", "game:" + code, JSON.stringify(room), "EX", String(TTL)]);
  return room;
}

// ---- monotonic merge: only fill blanks, never wipe existing --------------
function mergeMap(target, src) {
  if (!src) return target;
  target = target || {};
  for (const k in src) {
    const v = src[k];
    if (v !== null && v !== undefined && v !== "") target[k] = v;
  }
  return target;
}

// ---- sanitise: keep payloads small and well-formed -----------------------
function cleanName(n) {
  return String(n || "").trim().slice(0, 14);
}
function cleanCode(c) {
  return String(c || "").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

// ---- handler --------------------------------------------------------------
export default async function handler(req, res) {
  // CORS (same-origin in prod, but harmless and helps local testing)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "Redis env vars not set" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const code = cleanCode(body.code);
  const action = body.action;
  const payload = body.payload || {};

  if (!code || code.length !== 4) {
    return res.status(400).json({ error: "bad code" });
  }

  try {
    // ---- CREATE (host) ---------------------------------------------------
    if (action === "create") {
      const existing = await getRoom(code);
      if (existing) {
        // code collision (rare) — just return it so host can retry client-side
        return res.status(200).json({ room: existing, collision: true });
      }
      const room = {
        code,
        category: String(payload.category || "wholesome"),
        questionIds: Array.isArray(payload.questionIds)
          ? payload.questionIds.slice(0, 20)
          : [],
        createdAt: Date.now(),
        playerA: { name: cleanName(payload.hostName), answers: {}, guesses: {}, done: false },
        playerB: { name: "", answers: {}, guesses: {}, done: false },
      };
      await setRoom(code, room);
      return res.status(200).json({ room });
    }

    // ---- JOIN (guest sets playerB name) ---------------------------------
    if (action === "join") {
      const room = await getRoom(code);
      if (!room) return res.status(404).json({ error: "no such game" });
      if (!room.playerB.name) room.playerB.name = cleanName(payload.name);
      await setRoom(code, room);
      return res.status(200).json({ room });
    }

    // ---- WRITE (a player commits their slice) ---------------------------
    if (action === "write") {
      const room = await getRoom(code);
      if (!room) return res.status(404).json({ error: "no such game" });

      const side = payload.side === "B" ? "playerB" : "playerA";
      const slot = room[side];

      // monotonic merge — fills blanks, never wipes committed answers
      slot.answers = mergeMap(slot.answers, payload.answers);
      slot.guesses = mergeMap(slot.guesses, payload.guesses);
      if (payload.done === true) slot.done = true;
      if (payload.name && !slot.name) slot.name = cleanName(payload.name);

      await setRoom(code, room);
      // return the MERGED room — client trusts this directly
      return res.status(200).json({ room });
    }

    // ---- POLL (waiting screens) -----------------------------------------
    if (action === "poll") {
      const room = await getRoom(code);
      if (!room) return res.status(404).json({ error: "no such game" });
      return res.status(200).json({ room });
    }

    return res.status(400).json({ error: "unknown action" });
  } catch (err) {
    return res.status(500).json({ error: "server", detail: String(err.message || err) });
  }
}
