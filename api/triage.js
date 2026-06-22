// /api/triage  -  Vercel Node.js serverless function
// Fetches the SP race cards page + each meet's Race 1 (server-side, no CORS),
// parses out distance / prize / field size / analysis PDFs, returns JSON.
//
// Query params:
//   ?date=DD/MM/YYYY   optional. defaults to the most recent date on the page.
//   ?list=1           optional. returns just the available dates (no card fetches).

const CARDS_URL =
  "https://www.singaporepools.com.sg/en/HorseRacing/Pages/RaceCards.aspx";

// node18+ on Vercel has global fetch. Helper with a timeout so one slow meet
// can't blow the 10s function budget.
async function getText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // pretend to be a normal browser; some SP endpoints are picky
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

// ---- parse the meeting list page into [{date, venue, id, url}] ----
function parseMeetingList(html) {
  const byId = {};
  // match every ViewRaceCard anchor and its visible text
  // <a href="...ViewRaceCard/29195">Malaysia (Selangor)</a>
  const re =
    /<a[^>]+href="([^"]*ViewRaceCard(?:\.aspx\?RaceEventCalendarID=|\/)(\d+))"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const id = m[2];
    const txt = m[3].replace(/&amp;/g, "&").trim();
    const url = href.startsWith("http")
      ? href
      : "https://www.singaporepools.com.sg" + (href.startsWith("/") ? "" : "/") + href;
    if (!byId[id]) byId[id] = { id, url, date: "", venue: "" };
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(txt)) {
      byId[id].date = txt;
    } else if (txt && txt.length > byId[id].venue.length) {
      byId[id].venue = txt;
    }
  }
  return Object.keys(byId).map((k) => byId[k]);
}

// ---- parse a single race card page for Race 1 summary ----
function parseCard(html) {
  // strip tags to plain-ish text for the header line
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

  const headerMatch = text.match(/RACE\s*1:[^|]*?PRIZE MONEY:[^|]*?(?=RACE\s*2:|Horse No|$)/i);
  let header = headerMatch ? headerMatch[0].trim() : "";
  if (!header) {
    const fallback = text.match(/RACE\s*1:.{0,160}/i);
    header = fallback ? fallback[0].trim() : "(Race 1 header not found)";
  }

  const distMatch = header.match(/(\d{3,5})\s*M\b/i);
  const distance = distMatch ? distMatch[1] + "m" : "?";

  const prizeMatch = header.match(/PRIZE MONEY:\s*([A-Z]{0,3}\$?[\d,]+)/i);
  const prize = prizeMatch ? prizeMatch[1].trim() : "?";

  // field size: count <td> cells that are a lone 1-2 digit number sitting at
  // the start of a table row (the horse-number column).
  let field = 0;
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const cellMatch = row[0].match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (cellMatch) {
      const first = cellMatch[1].replace(/<[^>]+>/g, "").trim();
      if (/^\d{1,2}$/.test(first)) field++;
    }
  }

  // analysis PDFs
  const pdfs = {};
  const pdfRe = /<a[^>]+href="([^"]+\.pdf)"[^>]*>([^<]*)<\/a>/gi;
  let p;
  while ((p = pdfRe.exec(html)) !== null) {
    let href = p[1].replace(/&amp;/g, "&").replace(/ /g, "%20");
    if (!href.startsWith("http"))
      href = "https://www.singaporepools.com.sg" + (href.startsWith("/") ? "" : "/") + href;
    const t = p[2].toLowerCase();
    if (t.indexOf("integrated") !== -1) pdfs.card = href;
    else if (t.indexOf("selection") !== -1 || t.indexOf("media") !== -1) pdfs.tips = href;
    else if (t.indexOf("analysis") !== -1) pdfs.analysis = href;
  }

  return { header, distance, prize, field, pdfs };
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
    meets.forEach((mt) => {
      if (mt.date && dates.indexOf(mt.date) === -1) dates.push(mt.date);
    });

    if (wantList) {
      res.status(200).json({ dates });
      return;
    }

    const chosen = date && dates.indexOf(date) !== -1 ? date : dates[0];
    const todays = meets.filter((mt) => mt.date === chosen);

    // fetch all meets in PARALLEL to stay under the 10s budget
    const results = await Promise.all(
      todays.map(async (mt) => {
        try {
          const html = await getText(mt.url, 7000);
          const parsed = parseCard(html);
          return Object.assign({ venue: mt.venue, url: mt.url }, parsed);
        } catch (e) {
          return { venue: mt.venue, url: mt.url, error: String(e) };
        }
      })
    );

    res.status(200).json({ date: chosen, dates, count: results.length, meets: results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
