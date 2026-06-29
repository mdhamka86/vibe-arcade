// api/mission.js
// Shared household save for Mission Phuket.
// One JSON blob holds the whole mission state (checked tasks, spent points,
// owned stickers, who-ticked-what). Both phones read and write the same blob,
// so Hammy and Naddy share boxes and a combined points pool.
//
// No npm packages. Talks to Upstash Redis over its REST API using fetch,
// reading the two env vars that the Vercel + Upstash integration injects:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//
// Endpoints (all on this one file):
//   GET  /api/mission              -> returns the current shared state
//   POST /api/mission  { state }   -> overwrites the shared state, returns it
//
// The client always sends the FULL state on a write. For a two-person
// checklist that is simple and reliable: last write wins, and because each
// write is near-instant and the polling interval is short, the two phones
// converge within a few seconds.

const KEY = "mission-phuket:household:v1";

function env() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return { url, token };
}

// minimal Upstash REST helpers ------------------------------------------------
// Upstash exposes commands as path segments, e.g. /get/<key> and
// /set/<key>/<value>. We use the pipeline-free single-command endpoints.
// Values are JSON strings; we URL-encode them so any character is safe.

async function redisGet(url, token, key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstash GET failed: ${res.status}`);
  const data = await res.json();
  // Upstash returns { result: <stringOrNull> }
  return data.result;
}

async function redisSet(url, token, key, value) {
  // POST form: body carries the value so we never hit URL length limits.
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: value,
  });
  if (!res.ok) throw new Error(`Upstash SET failed: ${res.status}`);
  return res.json();
}

// the empty mission, used the very first time before anyone has ticked a thing
function emptyState() {
  return { checked: {}, spent: 0, owned: [], lastBy: {}, budget: null, memories: [], deletedMem: [], updatedAt: 0 };
}

export default async function handler(req, res) {
  // permissive CORS so the static page can call this without fuss
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { url, token } = env();
  if (!url || !token) {
    res.status(500).json({
      error: "Storage not configured",
      detail: "KV_REST_API_URL / KV_REST_API_TOKEN are missing. Add the Upstash Redis integration to this project in the Vercel dashboard, then redeploy.",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const raw = await redisGet(url, token, KEY);
      const state = raw ? JSON.parse(raw) : emptyState();
      res.status(200).json({ ok: true, state });
      return;
    }

    if (req.method === "POST") {
      // req.body may arrive parsed (object) or as a string depending on runtime
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      const incoming = body && body.state ? body.state : null;
      if (!incoming || typeof incoming !== "object") {
        res.status(400).json({ error: "Bad request", detail: "Expected a JSON body of the shape { state: { ... } }." });
        return;
      }
      // stamp the server-side write time so clients can tell whose copy is newer
      const toSave = {
        checked: incoming.checked || {},
        spent: Number(incoming.spent) || 0,
        owned: Array.isArray(incoming.owned) ? incoming.owned : [],
        lastBy: incoming.lastBy || {},
        budget: incoming.budget || null,
        memories: Array.isArray(incoming.memories) ? incoming.memories : [],
        deletedMem: Array.isArray(incoming.deletedMem) ? incoming.deletedMem : [],
        updatedAt: Date.now(),
      };
      await redisSet(url, token, KEY, JSON.stringify(toSave));
      res.status(200).json({ ok: true, state: toSave });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Storage error", detail: String(err && err.message || err) });
  }
}
