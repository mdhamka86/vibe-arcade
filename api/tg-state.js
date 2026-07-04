// api/tg-state.js
// Shared household save for Touch Grass HKT.
// One JSON blob holds the shared, cross-phone state that both Hammy and Naddy
// contribute to: the memory wall, the running season leaderboard, and the shelf
// of archived weekly scrapbooks. (The competitive board's per-week claims stay
// device-local for speed; this backend is for the genuinely SHARED things.)
//
// Adapted directly from Mission Phuket's proven api/mission.js. Same reliable
// design: both phones GET the same blob and POST the full state back, last write
// wins, and frequent polling means they converge within seconds.
//
// No npm packages. Talks to Upstash Redis over its REST API using fetch,
// reading the two env vars the Vercel + Upstash integration injects:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//
// Endpoints (all on this one file):
//   GET  /api/tg-state              -> returns the current shared state
//   POST /api/tg-state  { state }   -> overwrites the shared state, returns it

const KEY = "touchgrass:household:v1";

function env() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  return { url, token };
}

// minimal Upstash REST helpers (single-command endpoints, JSON string values)
async function redisGet(url, token, key) {
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Upstash GET failed: ${res.status}`);
  const data = await res.json();
  return data.result; // Upstash returns { result: <stringOrNull> }
}

async function redisSet(url, token, key, value) {
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: value,
  });
  if (!res.ok) throw new Error(`Upstash SET failed: ${res.status}`);
  return res.json();
}

// The empty shared state, used the very first time before anyone writes.
//   memories : the living memory wall (penned thoughts + free-moment photos)
//   season   : { Hammy: <weeksWon>, Naddy: <weeksWon> } running tally
//   scrapbooks: archived weekly recaps, newest first
//   spoils   : the current leader's diss + funny punishment for the loser
function emptyState() {
  return {
    memories: [],
    season: { Hammy: 0, Naddy: 0 },
    scrapbooks: [],
    spoils: null,
    updatedAt: 0,
  };
}

export default async function handler(req, res) {
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
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      const incoming = body && body.state ? body.state : null;
      if (!incoming || typeof incoming !== "object") {
        res.status(400).json({ error: "Bad request", detail: "Expected a JSON body of the shape { state: { ... } }." });
        return;
      }
      // sanitise + stamp the server write time so clients can tell whose is newer
      const toSave = {
        memories: Array.isArray(incoming.memories) ? incoming.memories.slice(0, 500) : [],
        season: (incoming.season && typeof incoming.season === "object")
          ? { Hammy: Number(incoming.season.Hammy) || 0, Naddy: Number(incoming.season.Naddy) || 0 }
          : { Hammy: 0, Naddy: 0 },
        scrapbooks: Array.isArray(incoming.scrapbooks) ? incoming.scrapbooks.slice(0, 60) : [],
        spoils: (incoming.spoils && typeof incoming.spoils === "object") ? incoming.spoils : null,
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
