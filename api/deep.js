// /api/deep  -  Stage 2: read the analysis PDFs for ONE chosen meet.
// Called only on the meets that survived triage, so it handles 1-3 PDFs at a
// time, well within the serverless time/memory budget.
//
// Uses unpdf (pure-JS, zero native deps, serverless-safe) for text extraction.
//
// Query params:
//   ?url=<full ViewRaceCard URL>   the meet to deep-read (required)
//
// Returns the extracted text from each analysis PDF, lightly cleaned, so the
// convergence read can happen in chat against the model picks.

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
  const plain = html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
  function classify(label, href) {
    const t = (label || "").toLowerCase();
    if (t.indexOf("integrated") !== -1) pdfs.card = abs(href);
    else if (t.indexOf("selection") !== -1 || t.indexOf("media") !== -1) pdfs.tips = abs(href);
    else if (t.indexOf("analysis") !== -1) pdfs.analysis = abs(href);
  }
  let m;
  const mdRe = /\[([^\]]*?)\]\((https?:[^)]+\.pdf)\)/gi;
  while ((m = mdRe.exec(plain)) !== null) classify(m[1], m[2]);
  const aRe = /<a[^>]+href="([^"]+\.pdf)"[^>]*>([^<]*)<\/a>/gi;
  while ((m = aRe.exec(html)) !== null) classify(m[2], m[1]);
  return pdfs;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = new URL(req.url, "http://localhost");
    const cardUrl = url.searchParams.get("url");
    if (!cardUrl || cardUrl.indexOf("ViewRaceCard") === -1) {
      res.status(400).json({ error: "Pass ?url=<ViewRaceCard URL>" });
      return;
    }

    const html = await getText(cardUrl, 8000);
    const pdfs = findPdfs(html);
    if (!Object.keys(pdfs).length) {
      res.status(200).json({ url: cardUrl, pdfs: {}, docs: [], note: "No analysis PDFs on this meet." });
      return;
    }

    // unpdf is loaded lazily so the triage function never bundles it
    const { extractText, getDocumentProxy } = await import("unpdf");

    async function readPdf(label, pdfUrl) {
      try {
        const buf = await getBuf(pdfUrl, 9000);
        const pdf = await getDocumentProxy(buf);
        const { text } = await extractText(pdf, { mergePages: true });
        // light clean + cap length so the response stays small
        const clean = String(text).replace(/\s+/g, " ").trim().slice(0, 12000);
        return { label, url: pdfUrl, chars: clean.length, text: clean };
      } catch (e) {
        return { label, url: pdfUrl, error: String(e) };
      }
    }

    // prefer tips + analysis (the selection content); skip the bulky integrated
    // form card unless it's the only one present
    const jobs = [];
    if (pdfs.tips) jobs.push(readPdf("Media selections", pdfs.tips));
    if (pdfs.analysis) jobs.push(readPdf("Race analysis", pdfs.analysis));
    if (!jobs.length && pdfs.card) jobs.push(readPdf("Integrated card", pdfs.card));

    const docs = await Promise.all(jobs);
    res.status(200).json({ url: cardUrl, pdfs, docs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
};
