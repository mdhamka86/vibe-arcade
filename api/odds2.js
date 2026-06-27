// /api/odds2  -  Pull SGPools football odds for the slip builder.
//
// Strategy (per build decision): try BOTH sources in parallel and return
// whichever yields usable data, each clearly labelled so you always know
// which feed you're looking at.
//   A) SGPools directly (server-side fetch, iPhone UA). The public site paints
//      odds via JS, so this OFTEN returns only a skeleton, but server-side with
//      a real UA sometimes reaches an embedded data blob, so we try anyway.
//   B) sgodds.com mirror (renders odds as server-side text, reliably parseable,
//      but LAGGING and uses its own match numbering, NOT SGPools app codes).
//
// HARD RULE baked into the payload: sgodds codes are mirror codes, never
// SGPools app codes. The UI must tell the user to card-match the real code
// and confirm the live price in the SGPools app before betting.

const MIRROR_URL = "https://sgodds.com/football/current-odds";
const SP_SPORTS = "https://online.singaporepools.com/en/sports";

async function getText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        Accept: "text/html",
      },
    });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// --- Mirror parser: walk the rendered text stream, pair "Home vs Away" titles
//     with the nearest preceding code/time and the next three decimal prices. ---
function parseMirror(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (let i = 0; i < text.length; i++) {
    const vs = text[i].match(/^(.+?)\s+vs\s+(.+?)$/i);
    if (!vs) continue;
    let code = null, time = null, league = null;
    for (let b = i - 1; b >= Math.max(0, i - 6); b--) {
      if (!code && /^\d{4}$/.test(text[b])) code = text[b];
      if (!time && /^\d{1,2}:\d{2}$/.test(text[b])) time = text[b];
      if (!league && /(W Cup|League|Liga|Serie|Bundesliga|Ligue)/i.test(text[b])) league = text[b];
    }
    const prices = [];
    for (let f = i + 1; f < Math.min(text.length, i + 12) && prices.length < 3; f++) {
      const p = text[f].match(/^(\d{1,2}\.\d{2})\b/);
      if (p) prices.push(parseFloat(p[1]));
    }
    if (prices.length < 3) continue;
    out.push({
      mirror_code: code,
      time_sgt: time,
      league: league || "",
      home: vs[1].trim(),
      away: vs[2].trim(),
      odds_1x2: { home: prices[0], draw: prices[1], away: prices[2] },
    });
  }
  // de-dupe by fixture
  const seen = new Set();
  return out.filter((f) => {
    const k = f.home + "|" + f.away;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --- SGPools direct: try to recover any embedded JSON blob the page ships
//     before hydration. If none is found we just report skeleton-only. ---
function parseSgDirect(html) {
  // Look for a large JSON-looking blob with event/odds keys. Defensive: many
  // builds inline initial state in a window.__ var or a <script type=json>.
  const out = [];
  const blobs = html.match(/\{[^{}]*"(?:odds|markets|events?|fixtures?)"[\s\S]{0,40000}?\}/gi) || [];
  // We don't trust a specific schema (it changes), so we only flag whether a
  // data blob was present at all. Real parsing stays on the mirror.
  return { recovered: out, sawDataBlob: blobs.length > 0, skeleton: blobs.length === 0 };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const [mirrorHtml, spHtml] = await Promise.all([
      getText(MIRROR_URL, 8000).catch(() => ""),
      getText(SP_SPORTS, 8000).catch(() => ""),
    ]);

    const mirror = mirrorHtml ? parseMirror(mirrorHtml) : [];
    const direct = spHtml ? parseSgDirect(spHtml) : { skeleton: true, sawDataBlob: false };

    // Pull "last updated" stamp off the mirror if present (honesty about lag).
    let mirrorStamp = null;
    const sm = mirrorHtml.match(/Last Updated on\s*([\d-]+\s[\d:]+)/i);
    if (sm) mirrorStamp = sm[1];

    const payload = {
      build: "odds2 v1.0",
      pulled_at: new Date().toISOString(),
      sources: {
        sgpools_direct: {
          ok: !direct.skeleton,
          note: direct.skeleton
            ? "SGPools returned skeleton only (odds are JS-rendered). Use mirror."
            : "SGPools returned a data blob; treat with caution, schema unverified.",
        },
        sgodds_mirror: {
          ok: mirror.length > 0,
          last_updated: mirrorStamp,
          note:
            "Unofficial lagging mirror. mirror_code is NOT the SGPools app code. Card-match before betting.",
        },
      },
      // The mirror is the trustworthy feed for actual numbers right now.
      primary_source: mirror.length ? "sgodds_mirror" : "none",
      fixtures: mirror,
      fixture_count: mirror.length,
      disclaimer:
        "Reference only. Always card-match the real SGPools code and confirm the live price in your SGPools app before placing any bet.",
    };
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
