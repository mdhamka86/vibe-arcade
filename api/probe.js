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
//   ?h=     optional request header, "Name: value". Repeatable.
//   ?method= optional, GET (default) or POST
//   ?body=  optional request body (implies POST if ?method= is absent)
//
// HEADERS AND POST ADDED 22/07/2026, for the Australia source hunt. The question
// was whether racing.com's GraphQL API answers from syd1, and it could not be asked:
// it is an AWS AppSync endpoint that needs an x-api-key header and a POST query, and
// a GET without the header returns a clean 401 that proves only that the network path
// is open. "The path is open" is not "the authed call works", and that gap is exactly
// where this project has been burned before — PMU 403s from a dev box and works from
// syd1, TAB returns a 200 with an HTML geo-block body locally and real JSON from syd1.
// A scouting tool that cannot make the call you need to scout answers the wrong question.
//
// This widens the tool: it can now send arbitrary headers and POST bodies, which makes
// the ?key= guard load-bearing rather than decorative. Same lifespan note as above —
// this file goes when the adapters are locked.

const PROBE_KEY = "outsider-probe-1907";

const UAS = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
};

export default async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const u = new URL(req.url, "http://localhost");
    if (u.searchParams.get("key") !== PROBE_KEY)
      return res.status(403).json({ error: "bad key" });
    const target = u.searchParams.get("url");
    if (!target || !/^https?:\/\//.test(target))
      return res.status(400).json({ error: "Pass ?url=https://..." });
    const ua = u.searchParams.get("ua") || "chrome";
    // CEILING RAISED 22/07/2026 (8000 -> 400000) to scout the PMU France adapter.
    // The default stays 600: this endpoint reports the SHAPE of a response, and a fat
    // default would make every casual probe expensive. But 8000 could not answer the
    // question actually being asked of it. PMU's day programme is ~320KB in ONE document
    // (every reunion, every course, distances and start times), and its per-course meta
    // runs 6-9KB — so at 8000 roughly three courses a day came back unparseable, silently
    // dropped out of the candidate pool, and made a sound matcher look 63% accurate.
    // A scouting tool that truncates the document you are scouting answers the wrong
    // question. Still key-guarded; still deliberately temporary.
    //
    // 400000 was the first attempt and it was measured too finely: PMU's 15/07 programme
    // is 416921 bytes and came back 4% short, which is the same silent-truncation failure
    // one order of magnitude up. A ceiling picked to just fit today's biggest document is
    // a ceiling that breaks on a busy Saturday. 2000000 leaves real headroom and is still
    // well under the ~4.5MB response limit.
    const maxSnip = Math.min(parseInt(u.searchParams.get("max") || "600", 10) || 600, 2000000);
    const ms = Math.min(parseInt(u.searchParams.get("ms") || "15000", 10) || 15000, 30000);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const started = Date.now();
    let out;
    try {
      const headers = { Accept: "*/*" };
      if (ua !== "none" && UAS[ua]) headers["User-Agent"] = UAS[ua];
      // ?h=Name: value, repeatable. Split on the FIRST colon only — header values
      // routinely contain colons (URLs, timestamps) and splitting on all of them
      // would quietly truncate the value rather than fail.
      for (const raw of u.searchParams.getAll("h")) {
        const i = String(raw).indexOf(":");
        if (i <= 0) continue;
        headers[String(raw).slice(0, i).trim()] = String(raw).slice(i + 1).trim();
      }
      const body = u.searchParams.get("body");
      const method = (u.searchParams.get("method") || (body ? "POST" : "GET")).toUpperCase();
      if (body && !headers["Content-Type"] && !headers["content-type"])
        headers["Content-Type"] = "application/json";
      const r = await fetch(target, {
        signal: ctrl.signal, headers, method,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "follow",
      });
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
        method,
        // names only, never values: this echoes back into logs and a header is
        // where a credential lives.
        sentHeaders: Object.keys(headers),
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
