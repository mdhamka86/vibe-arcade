// /api/probe  -  TEMPORARY Phase 3 scouting tool (OVERHAUL.md, 19/07/2026).
//
// Purpose: test candidate PRICE sources (assessed odds, morning odds, tote
// approximates) from the REAL production environment, because reachability
// from a dev box means nothing — Racenet/Punters/racing.com all 403 Vercel
// while Race Coast's WP API and Selangor-on-iPhone-UA sail through, and the
// only way that was learned was probing from here (16/07 adapter session).
//
// This endpoint fetches ONE url server-side and reports the shape of what
// came back. It returns at most a short snippet, never the full body.
//
// GUARD: requires ?key=<token>. It is not an open proxy.
// LIFESPAN: delete this file once Phase 3 adapters are locked. It exists to
// answer questions, not to serve traffic.
//
// Query params:
//   ?key=   required, must match PROBE_KEY below
//   ?url=   required, http(s) URL to probe
//   ?ua=    optional: "chrome" | "iphone" | "none"   (default chrome)
//   ?ms=    optional timeout ms (default 15000, max 30000)

const PROBE_KEY = "outsider-probe-1907";

const UAS = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.searchParams.get("key") !== PROBE_KEY)
      return res.status(403).json({ error: "bad key" });
    const target = u.searchParams.get("url");
    if (!target || !/^https?:\/\//.test(target))
      return res.status(400).json({ error: "Pass ?url=https://..." });
    const ua = u.searchParams.get("ua") || "chrome";
    const maxSnip = Math.min(parseInt(u.searchParams.get("max") || "600", 10) || 600, 8000);
    const ms = Math.min(parseInt(u.searchParams.get("ms") || "15000", 10) || 15000, 30000);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const started = Date.now();
    let out;
    try {
      const headers = { Accept: "*/*" };
      if (ua !== "none" && UAS[ua]) headers["User-Agent"] = UAS[ua];
      const r = await fetch(target, { signal: ctrl.signal, headers, redirect: "follow" });
      const text = await r.text();
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      let looksJson = false;
      let jsonTopKeys = null;
      let jsonArrayLen = null;
      try {
        const j = JSON.parse(text);
        looksJson = true;
        if (Array.isArray(j)) jsonArrayLen = j.length;
        else if (j && typeof j === "object") jsonTopKeys = Object.keys(j).slice(0, 12);
      } catch (e) { /* not JSON, fine */ }
      out = {
        url: target,
        ua,
        status: r.status,
        contentType: r.headers.get("content-type") || null,
        bytes: text.length,
        strippedChars: stripped.length,
        looksJson,
        jsonTopKeys,
        jsonArrayLen,
        snippet: (looksJson ? text : stripped).slice(0, maxSnip),
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      out = {
        url: target,
        ua,
        error: String(e && e.name === "AbortError" ? "timeout after " + ms + "ms" : e),
        elapsedMs: Date.now() - started,
      };
    } finally {
      clearTimeout(t);
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
