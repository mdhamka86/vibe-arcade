// api/tg-state.js
// Shared household save for Touch Grass HKT.
// One JSON blob holds the shared, cross-phone state that both Hammy and Naddy
// contribute to: the memory wall, the running season leaderboard, the shelf of
// archived weekly scrapbooks, the VAR verdict notices, AND (as of this version)
// the live competitive board itself: per-week claims and throw-down dares.
//
// Why claims now live here: they used to be device-local for speed, but that
// meant a claim made on one phone never reached the other, so the duel was two
// people playing solitaire side by side. They travel in a SLIM form only (the
// heavyweight proof-photo bytes stay on-device; just the public photo URL rides
// along), exactly the same discipline the memory wall already follows.
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

// A gentle guard for the week-keyed books (claims and dares). These are objects
// shaped like { w1: ..., w2: ... }. They are naturally small, since a season
// resets after five weeks, but a defensive cap keeps a runaway client from ever
// bloating the single Redis value. We keep the most recent weeks by their
// numeric suffix and quietly drop anything older beyond the cap.
function clampWeekBook(book, maxWeeks) {
  if (!book || typeof book !== "object" || Array.isArray(book)) return {};
  const keys = Object.keys(book);
  if (keys.length <= maxWeeks) return book;
  const weekNum = (k) => {
    const m = /^w(\d+)$/.exec(k);
    return m ? Number(m[1]) : -1;
  };
  const kept = keys.sort((a, b) => weekNum(b) - weekNum(a)).slice(0, maxWeeks);
  const out = {};
  kept.forEach((k) => { out[k] = book[k]; });
  return out;
}

// The empty shared state, used the very first time before anyone writes.
//   memories      : the living memory wall (penned thoughts + free-moment photos)
//   season        : { Hammy: <weeksWon>, Naddy: <weeksWon> } running tally
//   scrapbooks    : archived weekly recaps, newest first
//   varNotices    : cross-phone VAR verdict notices (both parties get told)
//   seasonsArchive: completed-season records, newest first
//   spoils        : the current leader's diss + funny punishment for the loser
//   claims        : week-keyed board claims, e.g. { w1: { taskId: {...} } }
//   dares         : week-keyed throw-down dares, e.g. { w1: [ {...}, ... ] }
//   quizzes       : week-keyed Coach Saliba quiz results, e.g. { w1: { Hammy:{score}, Naddy:{score} } }
//   duels         : week-keyed big-one photo duel, e.g. { w1: { Hammy:{photoUrl}, Naddy:{...}, verdict } }
//   themeDuels    : week-keyed photo-theme duel, same shape as duels
//   resets        : week-keyed dev-reset wipe stamps, so a cleared week can't be
//                   resurrected from the other phone's older copy on merge
function emptyState() {
  return {
    memories: [],
    season: { Hammy: 0, Naddy: 0 },
    scrapbooks: [],
    varNotices: [],
    seasonsArchive: [],
    spoils: null,
    claims: {},
    dares: {},
    quizzes: {},
    duels: {},
    themeDuels: {},
    resets: {},
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
      // Merge whatever is stored over a fresh empty state, so an older blob that
      // predates the newer fields (claims, dares, resets, varNotices, archive)
      // still comes back with those keys present rather than undefined.
      const stored = raw ? JSON.parse(raw) : {};
      const state = { ...emptyState(), ...stored };
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
      // sanitise + stamp the server write time so clients can tell whose is newer.
      // Every genuinely shared field must be named here, or it gets dropped on
      // the way in. That omission is exactly what stranded the claims before:
      // the phones sent them faithfully, but this whitelist quietly binned them.
      const toSave = {
        memories: Array.isArray(incoming.memories) ? incoming.memories.slice(0, 500) : [],
        season: (incoming.season && typeof incoming.season === "object")
          ? { Hammy: Number(incoming.season.Hammy) || 0, Naddy: Number(incoming.season.Naddy) || 0 }
          : { Hammy: 0, Naddy: 0 },
        scrapbooks: Array.isArray(incoming.scrapbooks) ? incoming.scrapbooks.slice(0, 60) : [],
        varNotices: Array.isArray(incoming.varNotices) ? incoming.varNotices.slice(0, 300) : [],
        seasonsArchive: Array.isArray(incoming.seasonsArchive) ? incoming.seasonsArchive.slice(0, 60) : [],
        spoils: (incoming.spoils && typeof incoming.spoils === "object") ? incoming.spoils : null,
        claims: clampWeekBook(incoming.claims, 40),
        dares: clampWeekBook(incoming.dares, 40),
        quizzes: clampWeekBook(incoming.quizzes, 40),
        duels: clampWeekBook(incoming.duels, 40),
        themeDuels: clampWeekBook(incoming.themeDuels, 40),
        resets: (incoming.resets && typeof incoming.resets === "object" && !Array.isArray(incoming.resets))
          ? incoming.resets : {},
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
