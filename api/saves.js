export default async function handler(req, res) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // key namespaced per user + slot, e.g. ptp2:save:<userId>:<slot>
  const userId = (req.query.user || "guest").replace(/[^a-zA-Z0-9_-]/g, "");
  const slot = Math.max(0, Math.min(2, parseInt(req.query.slot, 10) || 0));
  const key = `ptp2:save:${userId}:${slot}`;

  try {
    if (req.method === "PUT") {
      const value = JSON.stringify(req.body);       // req.body is the serializeState object
      const r = await fetch(`${base}/set/${key}`, {
        method: "POST", ...auth,
        body: JSON.stringify({ value }),
      });
      return res.status(200).json({ ok: r.ok });
    }
    if (req.method === "GET") {
      const r = await fetch(`${base}/get/${key}`, auth);
      const data = await r.json();
      // Upstash returns { result: "<the stringified value>" | null }
      return res.status(200).json({ save: data.result ? JSON.parse(data.result) : null });
    }
    if (req.method === "DELETE") {
      await fetch(`${base}/del/${key}`, { method: "POST", ...auth });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "Storage unavailable" });
  }
}
