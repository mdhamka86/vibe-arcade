// api/forex-hands.js
// EA-FACING ENDPOINT for the Forex Brain hands (Phase 3, log-only).
// MQL5's WebRequest + string parsing is primitive, so this returns a FLAT
// key=value text format rather than JSON. One line per field, easy to parse.
//
// GET ?symbol=EURUSD          -> current verdict for that symbol, flat text
// POST ?action=log            -> EA posts what it WOULD have done; appended to Redis
// GET ?action=ealog&n=50      -> read back the EA decision log (for the dashboard)
//
// This file NEVER places orders and knows nothing about trading. It is a
// read/translate layer over what api/forex-brain.js already wrote to Redis.
//
// Env: UPSTASH_REDIS_REST_URL || KV_REST_API_URL, and matching TOKEN.

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const res = await fetch(`${R_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${R_TOK}` },
  });
  if (!res.ok) throw new Error(`redis ${cmd[0]} ${res.status}`);
  const j = await res.json();
  return j.result;
}
const rGet = (k) => redis(["GET", k]).then((v) => (v ? JSON.parse(v) : null));
const rPush = (k, v) => redis(["LPUSH", k, JSON.stringify(v)]).then(() => redis(["LTRIM", k, "0", "499"]));
const rRange = (k, n) => redis(["LRANGE", k, "0", String(n - 1)]).then((a) => (a || []).map((s) => JSON.parse(s)));

const K = {
  verdict: (s) => `forex:verdict:${s}`,
  eaLog: "forex:eaLog",
};

const PAIRS = ["EURUSD", "USDJPY", "GBPUSD", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"];

// Flat text is what MQL5 parses most easily: one key=value per line.
function toFlat(v) {
  if (!v) return "status=NONE\n";
  const lines = [
    `status=OK`,
    `verdictId=${v.verdictId || ""}`,
    `symbol=${v.symbol || ""}`,
    `direction=${v.direction || "FLAT"}`,
    `conviction=${v.conviction ?? 0}`,
    `expiresAt=${v.expiresAt || ""}`,
  ];
  if (v.direction && v.direction !== "FLAT" && v.entryZone) {
    lines.push(
      `trigger=${v.entryZone.trigger}`,
      `maxChase=${v.entryZone.maxChase}`,
      `slPrice=${v.slPrice}`,
      `tpPrice=${v.tpPrice}`,
      `riskPercent=${v.riskPercent}`,
    );
  }
  return lines.join("\n") + "\n";
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const action = q.action || "verdict";

    if (action === "verdict") {
      const symbol = String(q.symbol || "").toUpperCase();
      if (!PAIRS.includes(symbol)) {
        res.setHeader("content-type", "text/plain");
        return res.status(200).send("status=BADSYMBOL\n");
      }
      const v = await rGet(K.verdict(symbol));
      res.setHeader("content-type", "text/plain");
      return res.status(200).send(toFlat(v));
    }

    // The EA posts its intended action here. Phase 3 = log only, nothing executes.
    if (action === "log") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const entry = {
        at: new Date().toISOString(),
        symbol: String(body.symbol || ""),
        verdictId: String(body.verdictId || ""),
        decision: String(body.decision || ""),      // WOULD_OPEN | SKIP | BLOCKED
        reason: String(body.reason || ""),
        direction: String(body.direction || ""),
        conviction: Number(body.conviction || 0),
        lots: Number(body.lots || 0),
        entry: Number(body.entry || 0),
        sl: Number(body.sl || 0),
        tp: Number(body.tp || 0),
        equity: Number(body.equity || 0),
        dayR: Number(body.dayR || 0),
      };
      await rPush(K.eaLog, entry);
      res.setHeader("content-type", "text/plain");
      return res.status(200).send("status=LOGGED\n");
    }

    if (action === "ealog") {
      const n = Math.min(parseInt(q.n || "50", 10) || 50, 200);
      return res.status(200).json({ ok: true, eaLog: await rRange(K.eaLog, n) });
    }

    res.setHeader("content-type", "text/plain");
    return res.status(400).send("status=BADACTION\n");
  } catch (e) {
    res.setHeader("content-type", "text/plain");
    return res.status(500).send(`status=ERROR\nmessage=${String(e.message || e).slice(0, 120)}\n`);
  }
}
