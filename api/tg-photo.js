// api/tg-photo.js
// Photo uploads for Touch Grass HKT (claim proof + VAR evidence).
//
// A claimed task's photo needs to live at a public URL so Michael Oliver
// (api/oliver.js) can fetch and judge it, and so it can embed in a Bluesky
// share. Local data-URLs on the phone aren't reachable by a backend, so we
// push the bytes to Vercel Blob and hand back the short public URL.
//
// Adapted directly from Mission Phuket's proven api/photo.js. Same robust auth
// handling (modern OIDC or legacy token), same size guard, same clean return.
// The frontend resizes each photo first, so bytes arrive well under Vercel's
// 4.5 MB function body limit and upload fast on weak monsoon wifi.
//
// Needs Blob credentials, added when you connect a Blob store in the Vercel
// dashboard (Storage tab): either OIDC (auto) or BLOB_READ_WRITE_TOKEN.
//
// Endpoint:
//   POST /api/tg-photo?ext=jpg   body = raw (resized) image bytes
//   -> { ok: true, url: "https://....public.blob.vercel-storage.com/..." }

import { put } from "@vercel/blob";

export const config = {
  api: {
    bodyParser: false, // we want the raw image bytes, not a parsed body
  },
};

// read the raw request stream into a single Buffer
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Auth: support both modern OIDC (auto-injected BLOB_STORE_ID +
  // VERCEL_OIDC_TOKEN) and a legacy long-lived BLOB_READ_WRITE_TOKEN. Pass the
  // token only if it exists, else let OIDC kick in (an empty token would break OIDC).
  const rwToken = process.env.BLOB_READ_WRITE_TOKEN || null;
  const hasOidc = !!(process.env.BLOB_STORE_ID || process.env.VERCEL_OIDC_TOKEN);
  if (!rwToken && !hasOidc) {
    res.status(500).json({
      error: "Photo storage not configured",
      detail: "No Blob credentials found. In the Vercel dashboard, connect a Blob store to this project (Storage tab), then redeploy.",
    });
    return;
  }

  try {
    const body = await readRawBody(req);
    if (!body || body.length === 0) {
      res.status(400).json({ error: "Bad request", detail: "No image bytes received." });
      return;
    }
    if (body.length > 4 * 1024 * 1024) {
      res.status(413).json({ error: "Too large", detail: "Image exceeds 4 MB after resize. Try again." });
      return;
    }

    const ext = (req.query && req.query.ext ? String(req.query.ext) : "jpg")
      .replace(/[^a-z0-9]/gi, "").slice(0, 5).toLowerCase() || "jpg";
    const ctype = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const rand = Math.random().toString(36).slice(2, 10);
    const pathname = `touchgrass/${Date.now()}-${rand}.${ext}`;

    const putOpts = {
      access: "public",
      contentType: ctype,
      addRandomSuffix: false, // our pathname is already unique
    };
    if (rwToken) putOpts.token = rwToken;

    const blob = await put(pathname, body, putOpts);

    res.status(200).json({ ok: true, url: blob.url });
  } catch (err) {
    res.status(500).json({ error: "Upload error", detail: String((err && err.message) || err) });
  }
}
