// /api/triage  -  Stage 1: fast ranked scan of all meets for a day.
// Pulls each meet's card page (server-side, no CORS), scans the WHOLE card for
// race count, field depth and class spread, detects analysis PDFs, then scores
// and ranks meets by how worth-a-deep-dive they are.
//
// Ranking philosophy (from The Outsider Method journal lesson 22/06):
// prize money and raw field size are HYGIENE, not edge. The real diveability
// signal is whether external analysis exists + whether the card has genuine
// class spread (graded/handicap races) rather than being all maidens.

const CARDS_URL =
  "https://www.singaporepools.com.sg/en/HorseRacing/Pages/RaceCards.aspx";
const SP_BASE = "https://www.singaporepools.com.sg";

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

function abs(href) {
  if (!href) return href;
  href = href.replace(/&amp;/g, "&").replace(/ /g, "%20");
  if (href.startsWith("http")) return href;
  return SP_BASE + (href.startsWith("/") ? "" : "/") + href;
}

function parseMeetingList(html) {
  const byId = {};
  const re =
    /<a[^>]+href="([^"]*ViewRaceCard(?:\.aspx\?RaceEventCalendarID=|\/)(\d+))"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[2];
    const txt = m[3].replace(/&amp;/g, "&").trim();
    if (!byId[id]) byId[id] = { id, url: abs(m[1]), date: "", venue: "" };
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(txt)) byId[id].date = txt;
    else if (txt && txt.length > byId[id].venue.length) byId[id].venue = txt;
  }
  return Object.keys(byId).map((k) => byId[k]);
}

function scanCard(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  let r1 = "";
  const hm = plain.match(
    /RACE\s*1:[\s\S]*?PRIZE MONEY\s*:?\s*[^\n]*?(?=\s+NO\.\s+HORSE|\s+Horse No|RACE\s*2:|$)/i
  );
  r1 = hm ? hm[0].trim() : (plain.match(/RACE\s*1:.{0,140}/i) || ["(R1 not found)"])[0];
  r1 = r1.replace(/\s+NO\.\s+HORSE NAME[\s\S]*$/i, "").trim();

  let dist = "?";
  const dm = r1.match(/(\d{3,5})\s*M\b/i) || r1.match(/DISTANCE\s*:?\s*(\d{3,5})/i);
  if (dm) dist = dm[1] + "m";
  let prize = "?";
  const pm = r1.match(
    /PRIZE MONEY\s*:?\s*([A-Z]{0,3}[$\u20ac\u00a3\u00a5\u20ba]?[\d][\d.,\s]*\d)/i
  );
  if (pm) prize = pm[1].trim().replace(/(\d)\s+(\d)/g, "$1,$2");

  // Race count: the page shows a race selector strip like "Race * 1 2 3 4 5 6 7 All".
  // Only Race 1's body is rendered, so counting "RACE N:" headers undercounts.
  // Read the selector instead; fall back to header count if absent.
  let races = 0;
  const sel = plain.match(/Race\s*\*?\s*((?:\d+\s+){1,30}?)All/i);
  if (sel) {
    races = sel[1].trim().split(/\s+/).filter((x) => /^\d+$/.test(x)).length;
  }
  if (!races) races = (text.match(/RACE\s*\d+:/gi) || []).length || 1;
  const hasGraded = /\b(GROUP\s*[123]|GRADE\s*[123]|LISTED|STAKES)\b/i.test(text);
  const hasHandicapSpread = /\b(HANDICAP|HCP|BENCHMARK|BM\d|CLASS\s*\d|CL\d)\b/i.test(text);
  const maidenHeavy = (text.match(/MDN|MAIDEN/gi) || []).length >= Math.max(2, races * 0.4);

  // Only Race 1's runner table is rendered in the page body, so this counts R1's
  // field, not a whole-card average. Report it honestly as the R1 field size.
  let r1Field = 0;
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const c = row[0].match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (c && /^\d{1,2}$/.test(c[1].replace(/<[^>]+>/g, "").trim())) r1Field++;
  }
  if (r1Field <= 0 || r1Field > 30) r1Field = "?";

  // PDFs: find every .pdf URL in the RAW html (works whether SP serves them as
  // HTML <a href> or markdown). Classify by FILENAME first (SP's naming is
  // reliable: _FORM_, _TIPSHEET_, _RFA_), label text only as a fallback.
  const pdfs = {};
  function put(kind, href) { if (!pdfs[kind]) pdfs[kind] = abs(href); }
  const urlRe = /([^\s"'>\]\)(]+\.pdf)/gi;
  let u;
  while ((u = urlRe.exec(html)) !== null) {
    const href = u[1];
    const fn = href.toUpperCase();
    if (/_FORM_|EXPRESSFORM/.test(fn)) { put("card", href); continue; }
    if (/_TIPSHEET_/.test(fn)) { put("tips", href); continue; }
    if (/_RFA_|RC\d{6}/.test(fn)) { put("analysis", href); continue; }
    // fallback: label from preceding text
    const before = html.slice(Math.max(0, u.index - 60), u.index)
      .replace(/<[^>]+>/g, " ").replace(/[\[\]()]/g, " ").toLowerCase();
    if (before.indexOf("integrated") !== -1) put("card", href);
    else if (before.indexOf("selection") !== -1 || before.indexOf("media") !== -1) put("tips", href);
    else if (before.indexOf("analysis") !== -1 || before.indexOf("comment") !== -1) put("analysis", href);
  }
  const docCount = Object.keys(pdfs).length;

  return { r1, dist, prize, races, r1Field, hasGraded, hasHandicapSpread, maidenHeavy, pdfs, docCount };
}

function scoreMeet(s) {
  const docScore = Math.min(s.docCount, 3) / 3 * 45;           // external analysis = the signal
  const raceScore = Math.min(s.races || 0, 12) / 12 * 25;      // full-card depth
  const f = typeof s.r1Field === "number" ? s.r1Field : 0;
  const fieldScore = Math.min(f, 14) / 14 * 10;                // R1 field, minor
  let classScore = s.hasGraded ? 20 : s.hasHandicapSpread ? 12 : 4;
  if (s.maidenHeavy) classScore = Math.max(4, classScore - 8);
  const total = Math.round(docScore + raceScore + fieldScore + classScore);
  const bits = [];
  bits.push(s.docCount ? s.docCount + " analysis doc" + (s.docCount > 1 ? "s" : "") : "no analysis docs");
  bits.push(s.races + " races");
  bits.push("R1 field " + s.r1Field);
  bits.push(s.hasGraded ? "graded/listed present" : s.maidenHeavy ? "maiden-heavy" : s.hasHandicapSpread ? "handicap spread" : "low class signal");
  return { score: total, reason: bits.join(", ") };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = new URL(req.url, "http://localhost");
    const wantList = url.searchParams.get("list");
    const date = url.searchParams.get("date");

    const listHtml = await getText(CARDS_URL, 8000);
    const meets = parseMeetingList(listHtml);
    if (!meets.length) {
      res.status(502).json({ error: "No meetings parsed. SP layout may have changed." });
      return;
    }

    const dates = [];
    meets.forEach((mt) => { if (mt.date && dates.indexOf(mt.date) === -1) dates.push(mt.date); });
    if (wantList) { res.status(200).json({ dates }); return; }

    const chosen = date && dates.indexOf(date) !== -1 ? date : dates[0];
    const todays = meets.filter((mt) => mt.date === chosen);

    const results = await Promise.all(
      todays.map(async (mt) => {
        try {
          const html = await getText(mt.url, 7000);
          const s = scanCard(html);
          const sc = scoreMeet(s);
          return {
            venue: mt.venue, url: mt.url, score: sc.score, reason: sc.reason,
            r1: s.r1, dist: s.dist, prize: s.prize,
            races: s.races, r1Field: s.r1Field, pdfs: s.pdfs, docCount: s.docCount,
          };
        } catch (e) {
          return { venue: mt.venue, url: mt.url, score: 0, reason: "fetch failed", error: String(e) };
        }
      })
    );

    results.sort((a, b) => b.score - a.score);
    res.status(200).json({ build: "v2.1-mdpdf", date: chosen, dates, count: results.length, meets: results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
