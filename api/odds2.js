// /api/odds2  -  SGPools football odds for Ninety Plus.
//
// Ninety Plus v1.0  -  structural parse against the real sgodds markup.
// (Supersedes The Spread Slip v1.1 / odds2 v1.2.)
//
// WHAT CHANGED, AND WHY IT MATTERED:
//
//   1. DATE GROUPING  <- the one that nearly cost money.
//      The list page emits date headers as their own rows:
//        <div class="row table-active ..."><div class="col-12 lead ...">Sun, 26 Jul 2026</div></div>
//      v1.2 had no date field at all, so a card three days out looked like
//      tonight's. We now walk rows in document order and stamp every fixture
//      with the most recent header. The list routinely spans 5 days.
//
//   2. DEEP PARSE ACTUALLY WORKS  <- the big one.
//      v1.2 matched market headings against a whitelist of bare strings
//      ("1X2", "Asian Handicap", ...). The real headings are numbered:
//      "01 | 1X2", "33 | Total Goals Over/Under 3.5". Nothing ever matched,
//      so it found ZERO markets and fell through to its guess-from-adjacent-
//      lines path. That is where mislabelled blocks, missing markets and
//      fragmented team names all came from. We now take the heading verbatim.
//
//   3. EZOIC SPAN STRIPPING.
//      The ad network injects placeholder <span>s MID-ROW, splitting a
//      selection block in half. Left in, a label like "Levski Sofia" arrives
//      as "Le" + "ki Sofia". Stripped before anything else is parsed.
//
//   4. OPENING + CURRENT + MOVEMENT per selection, not just current.
//      Groundwork for closing-line-value tracking.
//
//   5. 1X2 MOVEMENT HISTORY parsed out of the inline Chart.js config
//      (~16 timestamped samples per fixture, going back about a day).
//
//   6. parse_warnings[] and mirror_age_seconds, so a bad parse or a stale
//      pull is loud instead of silent.
//
// NOT A BUG, FOR THE RECORD: the mirror-vs-app price gap is real movement plus
// the mirror's ~10 min refresh cycle, not a parsing fault. v1.2 read list-page
// 1X2 prices correctly. Capturing movement % (item 4) is what makes that gap
// legible instead of mysterious.
//
// HARD RULE (unchanged): mirror codes are NOT guaranteed to equal SGPools app
// codes. Card-match in the app before betting. The mirror lags; your SGPools
// app is source of truth at bet time.

const MIRROR_BASE = "https://sgodds.com";
const MIRROR_LIST = "https://sgodds.com/football/current-odds";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const isAbort = e && (e.name === "AbortError" || /aborted/i.test(String(e)));
      if (i < tries - 1) {
        await sleep(600);
        continue;
      }
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Ezoic injects <span id="ezoic-pub-ad-placeholder-NNN"> and <span data-ez-ph-id>
// in the MIDDLE of odds rows. Left in place they fragment selection labels.
// Also drop scripts/styles/comments and decode the entities the mirror uses.
function scrub(html) {
  return html
    .replace(/<span[^>]*ezoic-pub-ad-placeholder[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<span[^>]*data-ez-ph-id[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<span[^>]*class="[^"]*ezoic-autoinsert-ad[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
}

function decode(s) {
  return String(s == null ? "" : s)
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(s) {
  return decode(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function abs(href) {
  if (!href) return href;
  href = decode(href);
  if (href.startsWith("http")) return href;
  return MIRROR_BASE + (href.startsWith("/") ? "" : "/") + href;
}

// Movement cell looks like:
//   <span class="text-success"><i class="fas fa-caret-up"></i> +7.7%</span>
// Returns a signed number, or null when the cell is empty (no movement).
function parseMovement(cellHtml) {
  if (!cellHtml) return null;
  const m = cellHtml.match(/([+-]\s*\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/\s+/g, ""));
  return isNaN(v) ? null : v;
}

function parseStamp(html) {
  const m = html.match(/Last Updated on\s*([\d-]+\s[\d:]+)/i);
  return m ? m[1].trim() : null;
}

// The mirror stamps SGT wall-clock with no timezone marker. Treat as +08:00.
function ageSeconds(stamp) {
  if (!stamp) return null;
  const iso = stamp.replace(" ", "T") + "+08:00";
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

// "Sun, 26 Jul 2026" -> "2026-07-26" (keeps the display string too).
const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function normaliseDate(display) {
  if (!display) return null;
  const m = display.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (!m) return null;
  const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mm) return null;
  return m[3] + "-" + mm + "-" + String(m[1]).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// LIST: /football/current-odds
// ---------------------------------------------------------------------------
//
// Structure (one fixture row):
//   <div class="row border-bottom py-1 m-0">
//     <div class="col py-1"><i class="fas fa-tv"></i> 23:00</div>
//     <div class="col py-1">Norwegian League</div>
//     <div class="col-sm-4 py-1">
//       <span class="badge ...">6238</span>
//       <h3 class="tbl-h3"><a href=".../Sandefjord-vs-Bodo-Glimt-140612">Sandefjord vs Bodo Glimt</a></h3>
//     </div>
//     <div class="col py-1"><strong>6.50</strong> <span class="text-danger">... -1.5%</span></div>
//     ... X ... 2 ...
//   </div>
//
// Date headers appear between fixture rows as:
//   <div class="row table-active py-1 m-0"><div class="col-12 lead font-weight-bold">Sun, 26 Jul 2026</div></div>

function parseList(html) {
  const warnings = [];
  const clean = scrub(html);

  // Split on row boundaries, keeping the class so we can tell headers from fixtures.
  const rowRe = /<div class="row ([^"]*?)"[^>]*>([\s\S]*?)(?=<div class="row |<p class="mt-3 mb-4">|$)/gi;

  let currentDateDisplay = null;
  let currentDateIso = null;
  const fixtures = [];
  let m;

  while ((m = rowRe.exec(clean)) !== null) {
    const cls = m[1];
    const body = m[2];

    // Date header row.
    if (/table-active/.test(cls) && /col-12/.test(body)) {
      const label = stripTags(body);
      const iso = normaliseDate(label);
      if (iso) {
        currentDateDisplay = label;
        currentDateIso = iso;
      }
      continue;
    }

    // Fixture row.
    if (!/border-bottom/.test(cls)) continue;

    const link = body.match(
      /<a\s+href="([^"]*\/current-odds\/([^"]+?)-(\d+))"[^>]*>([\s\S]*?)<\/a>/i
    );
    if (!link) continue;

    const title = stripTags(link[4]);
    const vs = title.match(/^(.+?)\s+vs\s+(.+)$/i);

    const badge = body.match(/<span class="badge[^"]*"[^>]*>\s*(\d+)\s*<\/span>/i);
    const time = body.match(/(\d{1,2}:\d{2})/);

    // Column cells, in document order: time, league, fixture, 1, X, 2.
    const cells = [];
    const cellRe = /<div class="col(?:-sm-4)? py-1"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="col|$)/gi;
    let c;
    while ((c = cellRe.exec(body)) !== null) cells.push(c[1]);

    // Price cells are the ones containing <strong>N.NN</strong>.
    const priced = [];
    for (const cell of cells) {
      const p = cell.match(/<strong>\s*(\d{1,3}(?:\.\d{1,2})?)\s*<\/strong>/i);
      if (p) priced.push({ odds: parseFloat(p[1]), movement: parseMovement(cell) });
    }

    // League = the cell that is plain text and isn't the time.
    let league = "";
    for (const cell of cells) {
      const t = stripTags(cell);
      if (!t || /^\d{1,2}:\d{2}$/.test(t) || /^\d+(\.\d+)?$/.test(t)) continue;
      if (/vs/i.test(t)) continue;
      league = t;
      break;
    }

    const fx = {
      mirror_code: badge ? badge[1] : null,   // the card-match badge (e.g. 6238)
      mirror_id: link[3],                      // stable event id from the URL (e.g. 140612)
      match_url: abs(link[1]),
      match_date: currentDateIso,
      match_date_display: currentDateDisplay,
      time_sgt: time ? time[1] : null,
      league: league,
      home: vs ? vs[1].trim() : title,
      away: vs ? vs[2].trim() : "",
      odds_1x2:
        priced.length >= 3
          ? { home: priced[0].odds, draw: priced[1].odds, away: priced[2].odds }
          : null,
      movement_1x2:
        priced.length >= 3
          ? { home: priced[0].movement, draw: priced[1].movement, away: priced[2].movement }
          : null,
    };

    if (!fx.match_date) warnings.push("no date header seen before " + title);
    if (!fx.mirror_code) warnings.push("no card-match badge for " + title);
    if (!fx.odds_1x2) warnings.push("incomplete 1X2 for " + title + " (got " + priced.length + " prices)");

    fixtures.push(fx);
  }

  // De-dupe on the stable event id.
  const seen = new Set();
  const deduped = fixtures.filter((f) =>
    seen.has(f.mirror_id) ? false : (seen.add(f.mirror_id), true)
  );

  return { fixtures: deduped, warnings };
}

// ---------------------------------------------------------------------------
// DEEP: one fixture page
// ---------------------------------------------------------------------------
//
// Each market is:
//   <div class="container mt-3">
//     <div class="row table-dark"><div class="col border font-weight-bold py-1">01 | 1X2</div></div>
//     ... selection blocks ...
//   </div>
//
// Each selection block is a four-cell row:
//   <div class="col-4 border-right table-active py-1 text-center">Bodo Glimt</div>
//   <div class="col-2 py-1">1.37</div>                              <- opening
//   <div class="col-2 font-weight-bold py-1">1.35</div>              <- current
//   <div class="col-4 py-1"><span class="text-danger">... -1.5%</span></div>

// Legitimately short selection labels seen on the mirror.
const SHORT_OK = new Set(["no", "1", "2", "x", "1x", "x2", "12"]);

function parseMatch(html) {
  const warnings = [];
  const clean = scrub(html);

  const markets = {};
  const marketOrder = [];

  // Split the document at each market header, so each chunk is one market.
  const headRe =
    /<div class="row table-dark"><div class="col border font-weight-bold py-1">([\s\S]*?)<\/div><\/div>([\s\S]*?)(?=<div class="row table-dark">|<p class="mt-3">|$)/gi;

  let m;
  while ((m = headRe.exec(clean)) !== null) {
    const rawHead = stripTags(m[1]);          // e.g. "33 | Total Goals Over/Under 3.5"
    const chunk = m[2];

    // Keep the mirror's own numbering separate from the readable name.
    const parts = rawHead.split("|").map((s) => s.trim());
    const code = parts.length > 1 && /^\d+$/.test(parts[0]) ? parts[0] : null;
    const name = parts.length > 1 && code ? parts.slice(1).join(" | ") : rawHead;

    const selections = [];
    const selRe =
      /<div class="col-4 border-right table-active py-1 text-center">([\s\S]*?)<\/div>\s*<div class="col-2 py-1">\s*([\d.]+)\s*<\/div>\s*<div class="col-2 font-weight-bold py-1">\s*([\d.]+)\s*<\/div>\s*<div class="col-4 py-1">([\s\S]*?)<\/div>/gi;

    let s;
    while ((s = selRe.exec(chunk)) !== null) {
      const label = stripTags(s[1]);
      const opening = parseFloat(s[2]);
      const current = parseFloat(s[3]);
      if (!label) {
        warnings.push("empty selection label in market '" + rawHead + "'");
        continue;
      }
      // Short labels are usually legitimate: Total Goals uses "0".."9+", Pick
      // The Score uses "2-1", Halftime-Fulltime uses "H-A", BTTS uses "Yes"/"No",
      // Odd/Even uses "Odd"/"Even". Warn only on a short ALPHABETIC label that
      // isn't one of those - that is the fingerprint of a fragment-split label
      // (the "Le" / "ki Sofia" nonsense v1.2 emitted for Levski Sofia).
      if (
        label.length < 3 &&
        /[A-Za-z]/.test(label) &&
        !SHORT_OK.has(label.toLowerCase()) &&
        !/^[HDA](-[HDA])?$/.test(label)
      ) {
        warnings.push("suspiciously short label '" + label + "' in '" + rawHead + "'");
      }
      selections.push({
        selection: label,
        opening: isNaN(opening) ? null : opening,
        odds: isNaN(current) ? null : current,   // 'odds' = current, keeps v1 field name
        movement: parseMovement(s[4]),
      });
    }

    if (!selections.length) {
      warnings.push("market '" + rawHead + "' parsed zero selections");
      continue;
    }

    const key = name || rawHead;
    markets[key] = { market_code: code, selections: selections };
    marketOrder.push(key);
  }

  // 1X2 movement history lives in the inline Chart.js config (unscrubbed html).
  let history = null;
  try {
    const labels = html.match(/labels:\s*\[([\s\S]*?)\]/);
    const sets = [...html.matchAll(/label:\s*'([^']+)'[\s\S]*?data:\s*\[([\s\S]*?)\]/g)];
    if (labels && sets.length) {
      const times = labels[1]
        .split(",")
        .map((x) => x.trim().replace(/^'|'$/g, ""))
        .filter(Boolean);
      const series = {};
      for (const st of sets) {
        series[st[1]] = st[2]
          .split(",")
          .map((x) => parseFloat(x.trim()))
          .filter((x) => !isNaN(x));
      }
      if (times.length) history = { samples: times, series: series };
    }
  } catch (e) {
    warnings.push("1X2 history parse failed: " + e.message);
  }

  let title = "";
  const tm = html.match(/<title>([^<]+)<\/title>/i);
  if (tm) title = decode(tm[1]).trim();

  // Date is in the <title>: "Sandefjord vs Bodo Glimt - 26 Jul 2026 - Match Odds - sgodds"
  const match_date = normaliseDate(title);

  // Card-match badge sits next to the H1.
  let mirror_code = null;
  const h1 = clean.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const badge = h1[1].match(/<small[^>]*>\s*(\d+)\s*<\/small>/i);
    if (badge) mirror_code = badge[1];
  }

  if (!Object.keys(markets).length) warnings.push("no markets parsed at all");

  return {
    title,
    match_date,
    mirror_code,
    last_updated: parseStamp(html),
    market_count: marketOrder.length,
    market_order: marketOrder,
    markets,
    history_1x2: history,
    parse_warnings: warnings,
  };
}

// ---------------------------------------------------------------------------

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
        build: "ninetyplus v1.0 deep",
        match_url: matchUrl,
        mirror_age_seconds: ageSeconds(parsed.last_updated),
        ...parsed,
        disclaimer:
          "Mirror data, refreshed ~10 min. Card-match the real SGPools code and confirm live price in the app before betting.",
      });
      return;
    }

    const listHtml = await getText(MIRROR_LIST, 15000, 2);
    const { fixtures, warnings } = parseList(listHtml);
    const stamp = parseStamp(listHtml);

    // Group by date so the frontend can render dividers without regrouping.
    const byDate = {};
    for (const f of fixtures) {
      const k = f.match_date || "unknown";
      (byDate[k] = byDate[k] || []).push(f.mirror_id);
    }

    res.status(200).json({
      build: "ninetyplus v1.0 list",
      pulled_at: new Date().toISOString(),
      source: "sgodds.com (unofficial SGPools mirror)",
      last_updated: stamp,
      mirror_age_seconds: ageSeconds(stamp),
      fixture_count: fixtures.length,
      dates: Object.keys(byDate).sort(),
      fixtures,
      parse_warnings: warnings,
      disclaimer:
        "Reference only. mirror_code is NOT guaranteed to equal the SGPools app code. Always card-match and confirm the live price in your SGPools app before betting.",
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).replace(/^Error:\s*/, "");
    try {
      res.status(200).json({ error: msg, soft: true });
    } catch (_) {
      res.status(200).send(JSON.stringify({ error: msg, soft: true }));
    }
  }
}

export default handler;
export const config = { maxDuration: 45 };
