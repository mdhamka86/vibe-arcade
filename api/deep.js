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
  function put(kind, href) { if (!pdfs[kind]) pdfs[kind] = abs(href); }
  const urlRe = /([^\s"'>\]\)(]+\.pdf)/gi;
  let u;
  while ((u = urlRe.exec(html)) !== null) {
    const href = u[1];
    const fn = href.toUpperCase();
    if (/_FORM_|EXPRESSFORM/.test(fn)) { put("card", href); continue; }
    if (/_TIPSHEET_/.test(fn)) { put("tips", href); continue; }
    if (/_RFA_|RC\d{6}/.test(fn)) { put("analysis", href); continue; }
    const before = html.slice(Math.max(0, u.index - 60), u.index)
      .replace(/<[^>]+>/g, " ").replace(/[\[\]()]/g, " ").toLowerCase();
    if (before.indexOf("integrated") !== -1) put("card", href);
    else if (before.indexOf("selection") !== -1 || before.indexOf("media") !== -1) put("tips", href);
    else if (before.indexOf("analysis") !== -1 || before.indexOf("comment") !== -1) put("analysis", href);
  }
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
