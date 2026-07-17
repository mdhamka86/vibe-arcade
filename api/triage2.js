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
// Ranking philosophy unchanged (journal lesson 22/06): external analysis +
// genuine class spread are the diveability signal; prize money / raw field are
// hygiene. With the /All view we now also get WHOLE-CARD field depth + class
// spread instead of just Race 1.
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
  // cardUrl may be .../ViewRaceCard/29263  or  .../ViewRaceCard.aspx?RaceEventCalendarID=29263
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
// Returns { races:[{raceNo,title,dist,coupon,fieldSize,runners:[{no,name}]}],
//           coupon, hasGraded, hasHandicapSpread, maidenHeavy, raceCount,
//           firstField }
function parseAll(html) {
  // strip scripts/styles so table regex stays clean & fast
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const races = [];
  // A race starts at "RACE <n>:" and runs until the next "RACE <n>:" or end.
  const blockRe = /RACE\s+(\d+)\s*:\s*([\s\S]*?)(?=RACE\s+\d+\s*:|$)/gi;
  let m;
  let docCoupon = null;
  while ((m = blockRe.exec(clean)) !== null) {
    const raceNo = parseInt(m[1], 10);
    const block = m[2] || "";

    // title = text up to the first tag or newline after the header
    const titleM = block.match(/^([^<\n]*)/);
    const title = (titleM ? titleM[1] : "").replace(/\s+/g, " ").trim().slice(0, 140);

    let dist = "?";
    const dm = title.match(/(\d{3,5})\s*M\b/i);
    if (dm) dist = dm[1] + "m";

    // coupon code for this meet (same across races; capture first seen)
    const cm = block.match(/Mark\s*["']?\s*(Code\s*\d+)/i);
    const coupon = cm ? cm[1].replace(/\s+/g, " ") : null;
    if (coupon && !docCoupon) docCoupon = coupon;

    // runners: each <tr> whose first two cells are number + name
    const runners = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(block)) !== null) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim()
      );
      // A runner row is: number | name | ... The first cell must be a plain integer
      // (this correctly rejects the header rows, whose first cells read "HorseNo",
      // "Jockey", "Colour", "Sire") and the second must contain a letter.
      //
      // The bound was /^\d{1,2}$/, which silently dropped any runner numbered 100+.
      // Verified 17/07/2026 against the live card: the highest number across all 8
      // meets is 18, so this was never firing — but the cap was arbitrary, and a
      // dropped runner here is invisible everywhere downstream. \d{1,3} costs nothing.
      //
      // Deliberately NOT loosened to accept "1a"/"1b" coupled entries: checked every
      // runner on all 8 of today's meets and every horse number is a plain integer.
      // SGPools renumbers into its own unambiguous coupon sequence, which is what a
      // tote operator must do because the number IS the bet. Do not add speculative
      // tolerance to the one parser the whole book trusts.
      if (cells.length >= 2 && /^\d{1,3}$/.test(cells[0]) && /[A-Za-z]/.test(cells[1])) {
        runners.push({ no: parseInt(cells[0], 10), name: cells[1] });
      }
    }
    races.push({ raceNo, title, dist, coupon, fieldSize: runners.length, runners });
  }

  // Per-race class detection so we can locate a feature ANYWHERE in the card,
  // not just judge off Race 1. This is the fix for "major race buried deep".
  const gradedRe = /\b(GROUP\s*[123]|GRADE\s*[123]|GR\.?\s*[123]|\bG[123]\b|LISTED|\bGR1\b|\bGR2\b|\bGR3\b|CLASSIC|DERBY|OAKS|GUINEAS|CUP\b|STAKES|PLATE\s+\(LR\)|FEATURE)/i;
  const handicapRe = /\b(HANDICAP|HCP|BENCHMARK|BM\d|CLASS\s*\d|CL\d|RATING|RTG)\b/i;

  races.forEach((r) => {
    const t = r.title.toUpperCase();
    r.graded = gradedRe.test(t);
    r.handicap = handicapRe.test(t);
    r.maiden = /\b(MDN|MAIDEN)\b/i.test(t);
  });

  const featureRaces = races
    .filter((r) => r.graded)
    .map((r) => ({ raceNo: r.raceNo, title: r.title, fieldSize: r.fieldSize }));

  const titlesJoined = races.map((r) => r.title).join(" ");
  const hasGraded = featureRaces.length > 0;
  const hasHandicapSpread = races.some((r) => r.handicap) ||
    /\b(HANDICAP|HCP|BENCHMARK|BM\d|CLASS\s*\d|CL\d|MDN PLATE|PLATE)\b/i.test(titlesJoined);

  const maidenCount = races.filter((r) => r.maiden).length;
  const maidenHeavy = races.length > 0 && maidenCount >= Math.max(2, races.length * 0.5);

  // Whole-card field depth, not just R1. avgField rewards a consistently
  // competitive card; maxField catches a big-field feature deep in the meet.
  const fields = races.map((r) => r.fieldSize).filter((n) => n > 0);
  const firstField = races.length ? races[0].fieldSize : 0;
  const avgField = fields.length ? fields.reduce((a, b) => a + b, 0) / fields.length : 0;
  const maxField = fields.length ? Math.max(...fields) : 0;
  // how many races have a genuinely competitive field (8+)
  const deepRaces = fields.filter((n) => n >= 8).length;

  return {
    races,
    coupon: docCoupon,
    raceCount: races.length,
    hasGraded,
    hasHandicapSpread,
    maidenHeavy,
    firstField,
    avgField: Math.round(avgField * 10) / 10,
    maxField,
    deepRaces,
    featureRaces,
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
  // External analysis availability stays the strongest single signal (journal
  // 22/06: the mandatory external-opinion check is the core of the method).
  const docScore = (Math.min(pdfCount, 3) / 3) * 40; // 0-40

  // Class: a graded/feature race ANYWHERE in the card is the big prize. This is
  // the fix for features buried deep (e.g. Irish Derby in R7) being missed.
  let classScore;
  if (s.hasGraded) classScore = 25;
  else if (s.hasHandicapSpread) classScore = 14;
  else classScore = 5;
  if (s.maidenHeavy) classScore = Math.max(4, classScore - 8);

  // Field depth across the WHOLE card, not just R1.
  // avgField (consistently competitive) + a nudge for many deep races.
  const avg = typeof s.avgField === "number" ? s.avgField : 0;
  const avgScore = (Math.min(avg, 12) / 12) * 20;             // 0-20
  const deepScore = (Math.min(s.deepRaces || 0, 8) / 8) * 8;  // 0-8, depth bonus

  // Race count = hygiene (more races, more chances), capped.
  const raceScore = (Math.min(s.raceCount || 0, 12) / 12) * 7; // 0-7

  const total = Math.round(docScore + classScore + avgScore + deepScore + raceScore);

  const bits = [];
  bits.push(pdfCount ? pdfCount + " analysis doc" + (pdfCount > 1 ? "s" : "") : "no analysis docs");
  bits.push(s.raceCount + " races");
  bits.push("avg field " + (s.avgField || 0) + " (max " + (s.maxField || 0) + ")");
  if (s.featureRaces && s.featureRaces.length) {
    const fr = s.featureRaces.map((f) => "R" + f.raceNo).join(",");
    bits.push("feature @ " + fr);
  } else if (s.maidenHeavy) {
    bits.push("maiden-heavy");
  } else if (s.hasHandicapSpread) {
    bits.push("handicap spread");
  } else {
    bits.push("low class signal");
  }
  return { score: total, reason: bits.join(", ") };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const url = new URL(req.url, "http://localhost");
    const wantList = url.searchParams.get("list");
    const date = url.searchParams.get("date");
    const wantMap = url.searchParams.get("map") !== "0"; // default ON

    const listHtml = await getText(CARDS_URL, 8000);
    const meets = parseMeetingList(listHtml);
    if (!meets.length) {
      res.status(502).json({ error: "No meetings parsed. SP layout may have changed." });
      return;
    }

    const dates = [];
    meets.forEach((mt) => { if (mt.date && dates.indexOf(mt.date) === -1) dates.push(mt.date); });
    if (wantList) { res.status(200).json({ dates }); return; }

    // DATE SELECTION. If a caller ASKS for a date, they must get that date or an
    // error — never a different day's card wearing the right day's clothes.
    //
    // The old line was:
    //   const chosen = date && dates.indexOf(date) !== -1 ? date : dates[0];
    // which silently fell back to the FIRST available date whenever the requested
    // one was absent or misspelled. On 17/07/2026 that returned the 11/07 card to a
    // caller asking for today, six days stale, with a 200 and no hint anything was
    // wrong. A stale card is worse than no card: it is authoritative-looking and
    // false, and everything downstream (the trawl's SSOT checks, the card-match law,
    // the bet slip itself) treats whatever this returns as ground truth.
    //
    // No date param still defaults to dates[0] — that is the documented convenience
    // for exploratory calls — but an EXPLICIT and unavailable date is now a 404.
    let chosen;
    if (date) {
      if (dates.indexOf(date) === -1) {
        res.status(404).json({
          error:
            "No SGPools race card for " + date + ". Available dates: " +
            (dates.length ? dates.join(", ") : "(none)") +
            ". Refusing to substitute a different day's card.",
          requested: date,
          dates,
        });
        return;
      }
      chosen = date;
    } else {
      chosen = dates[0];
    }
    const todays = meets.filter((mt) => mt.date === chosen);

    const results = await Promise.all(
      todays.map(async (mt) => {
        try {
          // Fetch the /All view: one fetch gives whole-card tables + PDFs.
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
            avgField: parsed.avgField,
            maxField: parsed.maxField,
            deepRaces: parsed.deepRaces,
            featureRaces: parsed.featureRaces,
            pdfs,
            docCount: pdfCount,
          };
          // Full race -> horse coupon map (the cardmap replacement).
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
