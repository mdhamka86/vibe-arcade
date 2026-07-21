// /api/odds2  -  SGPools football odds for The Spread Slip, triage2-style.
//
// Two modes, mirroring triage2's list + deep split:
//   (default)        list view: pull the mirror's current-odds page, return
//                    every fixture with headline 1X2 + its per-match page URL.
//   ?match=<url>     deep view: server-side fetch ONE fixture's own mirror page
//                    and parse every market it exposes (1X2, Asian Handicap,
//                    Total Goals O/U, Halftime), the football analogue of
//                    triage2's deep racecard read.
//
// Source is the sgodds.com mirror (renders as server-side text, like the SP
// horse cards triage2 reads). HARD RULE: mirror codes are NOT SGPools app
// codes, and payouts/exotics are not exhaustive. Card-match in the app before
// betting. Mirror lags; your SGPools app is source of truth at bet time.

const MIRROR_BASE = "https://sgodds.com";
const MIRROR_LIST = "https://sgodds.com/football/current-odds";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch text with a real timeout AND one automatic retry. Mirror hiccups
// (cold start + slow Cloudflare challenge) are usually transient, so a single
// 8s one-shot was the whole reason Pull odds threw AbortError. We now give
// each attempt 15s and retry once with a short backoff.
async function getText(url, ms, attempts) {
  const budget = ms || 15000;
  const tries = attempts || 2;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), budget);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
          Accept: "text/html",
        },
      });
      if (!r.ok) throw new Error("mirror returned HTTP " + r.status);
      return await r.text();
    } catch (e) {
      lastErr = e;
      // Only retry on abort/network-style failures, and only if we have a try left.
      const isAbort = e && (e.name === "AbortError" || /aborted/i.test(String(e)));
      if (i < tries - 1) {
        await sleep(600);
        continue;
      }
      // Out of retries: translate the opaque AbortError into something the
      // punter can actually act on.
      if (isAbort) {
        throw new Error(
          "mirror timed out after " + (budget / 1000) + "s x" + tries +
          " tries (sgodds.com slow or blocking). Screenshot the SGPools card and I'll read it manually."
        );
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

function abs(href) {
  if (!href) return href;
  href = href.replace(/&amp;/g, "&");
  if (href.startsWith("http")) return href;
  return MIRROR_BASE + (href.startsWith("/") ? "" : "/") + href;
}

// ---- LIST: parse the current-odds page into fixtures with their match URLs ----
function parseList(html) {
  // Capture each fixture's link (carries home/away + mirror id) alongside the
  // nearest code/time and the next three 1X2 prices.
  const linkRe =
    /href="([^"]*\/current-odds\/([^"]+?)-(\d+))"[^>]*>([^<]*vs[^<]*)<\/a>/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({
      url: abs(m[1]),
      mirror_id: m[3],
      title: m[4].replace(/&amp;/g, "&").trim(),
    });
  }

  // Flatten to a text stream to recover code/time/prices around each title.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const lk of links) {
    const ti = text.findIndex((t) => t === lk.title);
    if (ti === -1) continue;
    let code = null, time = null, league = null;
    for (let b = ti - 1; b >= Math.max(0, ti - 6); b--) {
      if (!code && /^\d{4}$/.test(text[b])) code = text[b];
      if (!time && /^\d{1,2}:\d{2}$/.test(text[b])) time = text[b];
      if (!league && /(W Cup|League|Liga|Serie|Bundesliga|Ligue)/i.test(text[b])) league = text[b];
    }
    const prices = [];
    for (let f = ti + 1; f < Math.min(text.length, ti + 12) && prices.length < 3; f++) {
      const p = text[f].match(/^(\d{1,2}\.\d{2})\b/);
      if (p) prices.push(parseFloat(p[1]));
    }
    const vs = lk.title.match(/^(.+?)\s+vs\s+(.+?)$/i);
    out.push({
      mirror_code: code,
      mirror_id: lk.mirror_id,
      match_url: lk.url,
      time_sgt: time,
      league: league || "",
      home: vs ? vs[1].trim() : lk.title,
      away: vs ? vs[2].trim() : "",
      odds_1x2: prices.length === 3 ? { home: prices[0], draw: prices[1], away: prices[2] } : null,
    });
  }
  // de-dupe by url
  const seen = new Set();
  return out.filter((f) => (seen.has(f.match_url) ? false : (seen.add(f.match_url), true)));
}

// ---- DEEP: parse ONE match page for every market the mirror exposes ----
function parseMatch(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  // Walk the stream; when we hit a known market heading, collect the
  // selection/price pairs that follow until the next heading.
  const MARKET_HEADS = [
    { key: "1X2", re: /^1\s*X\s*2$/i },
    { key: "Halftime 1X2", re: /^halftime\s*1\s*x\s*2/i },
    { key: "Asian Handicap", re: /^asian\s*handicap/i },
    { key: "Total Goals O/U", re: /^total\s*goals?\s*(over\/under|o\/u)?/i },
    { key: "1/2 Goal", re: /^1\/2\s*goal/i },
  ];
  function isHead(s) {
    for (const h of MARKET_HEADS) if (h.re.test(s)) return h.key;
    return null;
  }

  const markets = {};
  let cur = null;
  for (let i = 0; i < text.length; i++) {
    const head = isHead(text[i]);
    if (head) { cur = head; markets[cur] = markets[cur] || []; continue; }
    if (!cur) continue;
    // A selection line is text; the price is the next decimal token.
    const price = text[i].match(/^(\d{1,3}\.\d{2})\b/);
    if (price) {
      // selection label is the previous non-numeric line we haven't consumed
      const prev = text[i - 1] || "";
      if (prev && !/^\d/.test(prev) && prev.length < 40) {
        markets[cur].push({ selection: prev, odds: parseFloat(price[1]) });
      }
    }
  }
  // drop empties, cap each market to a sane number of lines
  Object.keys(markets).forEach((k) => {
    if (!markets[k].length) delete markets[k];
    else markets[k] = markets[k].slice(0, 12);
  });

  // title + stamp
  let title = "";
  const tm = html.match(/<title>([^<]+)<\/title>/i);
  if (tm) title = tm[1].replace(/&amp;/g, "&").trim();
  let stamp = null;
  const sm = html.match(/Last Updated on\s*([\d-]+\s[\d:]+)/i);
  if (sm) stamp = sm[1];

  return { title, last_updated: stamp, markets };
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json");
  try {
    const url = new URL(req.url, "http://localhost");
    const matchUrl = url.searchParams.get("match");

    if (matchUrl) {
      if (matchUrl.indexOf("sgodds.com") === -1) {
        res.status(400).json({ error: "match url must be an sgodds.com fixture page" });
        return;
      }
      const html = await getText(matchUrl, 15000, 2);
      const parsed = parseMatch(html);
      res.status(200).json({
        build: "odds2 v1.2 deep",
        match_url: matchUrl,
        ...parsed,
        disclaimer:
          "Mirror data, lagging and not exhaustive (no live payouts / some exotics absent). Card-match the real SGPools code and confirm live price in the app before betting.",
      });
      return;
    }

    const listHtml = await getText(MIRROR_LIST, 15000, 2);
    const fixtures = parseList(listHtml);
    let stamp = null;
    const sm = listHtml.match(/Last Updated on\s*([\d-]+\s[\d:]+)/i);
    if (sm) stamp = sm[1];

    res.status(200).json({
      build: "odds2 v1.2 list",
      pulled_at: new Date().toISOString(),
      source: "sgodds.com (unofficial SGPools mirror)",
      last_updated: stamp,
      fixture_count: fixtures.length,
      fixtures,
      disclaimer:
        "Reference only. mirror_code is NOT the SGPools app code. Always card-match and confirm the live price in your SGPools app before betting.",
    });
  } catch (e) {
    // getText already gives a plain-English message on timeout; strip the
    // "Error: " prefix so the frontend shows just the actionable sentence.
    // Guarantee a JSON body so the frontend never has to parse a Vercel
    // plain-text crash page (the "Unexpected token 'A'" bug).
    const msg = String(e && e.message ? e.message : e).replace(/^Error:\s*/, "");
    try {
      res.status(200).json({ error: msg, soft: true });
    } catch (_) {
      res.status(200).send(JSON.stringify({ error: msg, soft: true }));
    }
  }
}

// Under ESM the handler is the default export and the platform config is a
// separate named export, so the old CommonJS hazard is gone by construction:
// `module.exports = fn` used to replace the whole exports object and wipe any
// `module.exports.config` set before it - which is what produced Vercel's
// plain-text "An error occurred" page and the frontend JSON parse crash.
export default handler;
export const config = { maxDuration: 45 };
