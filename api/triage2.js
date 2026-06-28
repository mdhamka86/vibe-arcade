// /api/triage2  -  Stage 1 ranked scan of all meets for a day, NOW with a full
// race -> horse coupon map per meet (cardmap folded in).
//
// KEY CHANGE (28/06/2026): instead of fetching each meet's default ViewRaceCard
// page (which only renders Race 1's body server-side), we fetch the "/All" view
// which returns EVERY race's clean HTML table server-side:
//   ViewRaceCard/<id>/All  ->  canonical ?RaceEventCalendarID=<id>&RaceNumber=All
// Each race is a "RACE N: <title> - <dist>M - TIME: .. PRIZE MONEY: .." header
// followed by a table: Horse No | Horse Name | Jockey | Trainer | Barrier | Wt.
// The Horse No column IS the SGPools coupon number (confirmed against the app),
// so the bet slip can be keyed to it with ZERO manual translation. This retires
// the separate /api/cardmap endpoint and the unpdf PDF parsing entirely.
//
// Query params:
//   ?list=1          return just the available dates
//   ?date=DD/MM/YYYY pick a date (defaults to the first available)
//   ?map=0           skip the per-race horse map (smaller/faster response)

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

// Build the "/All" URL from a default ViewRaceCard URL or an id.
function allUrl(cardUrl) {
  const idM = cardUrl.match(/ViewRaceCard(?:\.aspx\?RaceEventCalendarID=|\/)(\d+)/i);
  if (!idM) return cardUrl;
  const id = idM[1];
  return SP_BASE + "/en/HorseRacing/Pages/ViewRaceCard/" + id + "/All";
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

// Parse the /All page: every "RACE N:" header + its runner table.
function parseAll(html) {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const races = [];
  const blockRe = /RACE\s+(\d+)\s*:\s*([\s\S]*?)(?=RACE\s+\d+\s*:|$)/gi;
  let m;
  let docCoupon = null;
  while ((m = blockRe.exec(clean)) !== null) {
    const raceNo = parseInt(m[1], 10);
    const block = m[2] || "";

    const titleM = block.match(/^([^<\n]*)/);
    const title = (titleM ? titleM[1] : "").replace(/\s+/g, " ").trim().slice(0, 140);

    let dist = "?";
    const dm = title.match(/(\d{3,5})\s*M\b/i);
    if (dm) dist = dm[1] + "m";

    const cm = block.match(/Mark\s*["']?\s*(Code\s*\d+)/i);
    const coupon = cm ? cm[1].replace(/\s+/g, " ") : null;
    if (coupon && !docCoupon) docCoupon = coupon;

    const runners = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(block)) !== null) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim()
      );
      if (cells.length >= 2 && /^\d{1,2}$/.test(cells[0]) && /[A-Za-z]/.test(cells[1])) {
        runners.push({ no: parseInt(cells[0], 10), name: cells[1] });
      }
    }
    races.push({ raceNo, title, dist, coupon, fieldSize: runners.length, runners });
  }

  const titlesJoined = races.map((r) => r.title).join(" ");
  const hasGraded = /\b(GROUP\s*[123]|GRADE\s*[123]|GR\.?\s*[123]|LISTED|STAKES|G1|G2|G3)\b/i.test(titlesJoined);
  const hasHandicapSpread = /\b(HANDICAP|HCP|BENCHMARK|BM\d|CLASS\s*\d|CL\d|MDN PLATE|PLATE)\b/i.test(titlesJoined);
  const maidenCount = (titlesJoined.match(/MDN|MAIDEN/gi) || []).length;
  const maidenHeavy = maidenCount >= Math.max(2, races.length * 0.4);
  const firstField = races.length ? races[0].fieldSize : 0;

  return {
    races,
    coupon: docCoupon,
    raceCount: races.length,
    hasGraded,
    hasHandicapSpread,
    maidenHeavy,
    firstField,
  };
}

// PDFs still detected (tipsheet/analysis remain the external-opinion signal).
function findPdfs(html) {
  const pdfs = {};
  function put(kind, href) { if (!pdfs[kind]) pdfs[kind] = abs(href); }
  let pi = 0;
  while ((pi = html.indexOf(".pdf", pi)) !== -1) {
    let start = pi;
    while (start > 0 && !/[\s"'>\]\)(]/.test(html[start - 1])) start--;
    const href = html.slice(start, pi + 4);
    const fn = href.toUpperCase();
    if (/_FORM_|EXPRESSFORM/.test(fn)) put("card", href);
    else if (/_TIPSHEET_/.test(fn)) put("tips", href);
    else if (/_RFA_|RC\d{6}/.test(fn)) put("analysis", href);
    pi += 4;
  }
  return pdfs;
}

function scoreMeet(s, pdfCount) {
  const docScore = Math.min(pdfCount, 3) / 3 * 45;
  const raceScore = Math.min(s.raceCount || 0, 12) / 12 * 25;
  const f = typeof s.firstField === "number" ? s.firstField : 0;
  const fieldScore = Math.min(f, 14) / 14 * 10;
  let classScore = s.hasGraded ? 20 : s.hasHandicapSpread ? 12 : 4;
  if (s.maidenHeavy) classScore = Math.max(4, classScore - 8);
  const total = Math.round(docScore + raceScore + fieldScore + classScore);
  const bits = [];
  bits.push(pdfCount ? pdfCount + " analysis doc" + (pdfCount > 1 ? "s" : "") : "no analysis docs");
  bits.push(s.raceCount + " races");
  bits.push("R1 field " + s.firstField);
  bits.push(s.hasGraded ? "graded/listed present" : s.maidenHeavy ? "maiden-heavy" : s.hasHandicapSpread ? "handicap spread" : "low class signal");
  return { score: total, reason: bits.join(", ") };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const url = new URL(req.url, "http://localhost");
    const wantList = url.searchParams.get("list");
    const date = url.searchParams.get("date");
    const wantMap = url.searchParams.get("map") !== "0";

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
          const html = await getText(allUrl(mt.url), 9000);
          const parsed = parseAll(html);
          const pdfs = findPdfs(html);
          const pdfCount = Object.keys(pdfs).length;
          const sc = scoreMeet(parsed, pdfCount);
          const out = {
            venue: mt.venue,
            url: mt.url,
            allUrl: allUrl(mt.url),
            score: sc.score,
            reason: sc.reason,
            coupon: parsed.coupon,
            races: parsed.raceCount,
            r1Field: parsed.firstField,
            pdfs,
            docCount: pdfCount,
          };
          if (wantMap) {
            out.raceMap = parsed.races.map((r) => ({
              raceNo: r.raceNo,
              dist: r.dist,
              coupon: r.coupon || parsed.coupon,
              fieldSize: r.fieldSize,
              runners: r.runners,
            }));
          }
          return out;
        } catch (e) {
          return { venue: mt.venue, url: mt.url, score: 0, reason: "fetch failed", error: String(e) };
        }
      })
    );

    results.sort((a, b) => b.score - a.score);
    res.status(200).json({ build: "v2.0-allhtml", date: chosen, dates, count: results.length, meets: results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
