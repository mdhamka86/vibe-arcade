// /api/cardmap  -  Build the SGPools INTEGRATED race -> horse-number map for one
// meet, so a bet slip can be keyed to the exact coupon numbers the app shows.
//
// ?url=<full ViewRaceCard URL>   the meet to map (required)
// ?raw=1                          also return raw extracted text per race

const SP_BASE = "https://www.singaporepools.com.sg";

async function getBuf(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      },
    });
    const ab = await r.arrayBuffer();
    return new Uint8Array(ab);
  } finally {
    clearTimeout(t);
  }
}

async function getText(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
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

function parseRaces(text) {
  const races = [];
  const headerRe = /RACE\s*(\d+)\s*:\s*([\s\S]*?)(?=RACE\s*\d+\s*:|$)/gi;
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    const raceNo = parseInt(m[1], 10);
    const block = m[2];

    const titleMatch = block.match(/^(.*?)(?=PRIZE MONEY|HORSE\s*NO|NO\.\s*HORSE|$)/i);
    let title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
    title = title.slice(0, 140);

    let dist = "?";
    const dm = title.match(/(\d{3,5})\s*M\b/i) || block.match(/(\d{3,5})\s*M\b/i);
    if (dm) dist = dm[1] + "m";

    const runners = [];
    const body = block.replace(/\s+/g, " ");
    const runnerRe =
      /(?:^|\s)(\d{1,2})\s+(?:[0-9xX\/-]{2,7}\s+)?([A-Z][A-Z'’\.\-]+(?:\s+[A-Z'’\.\-]+){0,4})(?=\s+\d{1,2}\s|\s+[A-Z]{1,3}\s|\s+\d{2,3}\s)/g;
    let rm;
    const seen = new Set();
    while ((rm = runnerRe.exec(body)) !== null) {
      const no = parseInt(rm[1], 10);
      const name = rm[2].replace(/\s+/g, " ").trim();
      if (no >= 1 && no <= 24 && name.length >= 2 && !seen.has(no) &&
          !/^(WIN|PLA|NB|NO|HORSE|JOCKEY|TRAINER|BARRIER|RATING|WEIGHT|TIME|PRIZE|MONEY|RACE|TURF|TRACK|FROM|CLASS|DISTANCE)$/.test(name)) {
        runners.push({ no, name });
        seen.add(no);
      }
    }
    runners.sort((a, b) => a.no - b.no);
    races.push({ raceNo, title, dist, fieldSize: runners.length, runners });
  }
  return races;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const url = new URL(req.url, "http://localhost");
    const cardUrl = url.searchParams.get("url");
    const wantRaw = url.searchParams.get("raw");
    if (!cardUrl || cardUrl.indexOf("ViewRaceCard") === -1) {
      res.status(200).json({ error: "Pass ?url=<ViewRaceCard URL>" });
      return;
    }

    const html = await getText(cardUrl, 8000);
    const pdfs = findPdfs(html);

    let source = null, lowConfidence = false;
    if (pdfs.card) source = pdfs.card;
    else if (pdfs.tips) { source = pdfs.tips; lowConfidence = true; }
    else if (pdfs.analysis) { source = pdfs.analysis; lowConfidence = true; }

    if (!source) {
      res.status(200).json({ url: cardUrl, source: null, pdfsFound: pdfs, races: [], note: "No PDFs on this meet to build a map from." });
      return;
    }

    let unpdf;
    try {
      unpdf = await import("unpdf");
    } catch (impErr) {
      res.status(200).json({ stage: "import unpdf", error: String(impErr) });
      return;
    }
    const { extractText, getDocumentProxy } = unpdf;

    let fullText;
    try {
      const buf = await getBuf(source, 9000);
      const pdf = await getDocumentProxy(buf);
      const r = await extractText(pdf, { mergePages: true });
      fullText = String(r.text);
    } catch (pdfErr) {
      res.status(200).json({ stage: "read/extract pdf", source, error: String(pdfErr) });
      return;
    }

   if (url.searchParams.get("dump")) {
      res.status(200).json({ source, totalChars: fullText.length, dump: fullText.slice(0, 6000) });
      return;
    }
    let races = [];
    try {
      races = parseRaces(fullText);
    } catch (parseErr) {
      res.status(200).json({ stage: "parseRaces", source, error: String(parseErr), sampleText: fullText.slice(0, 1500) });
      return;
    }

    const out = {
      url: cardUrl,
      source,
      sourceKind: pdfs.card ? "integrated_form_card" : (pdfs.tips ? "tipsheet" : "analysis"),
      lowConfidence,
      raceCount: races.length,
      races,
    };
    if (wantRaw) {
      out.rawByRace = {};
      const headerRe = /RACE\s*(\d+)\s*:[\s\S]*?(?=RACE\s*\d+\s*:|$)/gi;
      let mm;
      while ((mm = headerRe.exec(fullText)) !== null) {
        const n = mm[0].match(/RACE\s*(\d+)/i)[1];
        out.rawByRace[n] = mm[0].replace(/\s+/g, " ").trim().slice(0, 1500);
      }
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({
      crashed: true,
      error: String(e),
      stack: e && e.stack ? String(e.stack).slice(0, 1500) : "no stack",
    });
  }
};
