// api/photo.js
// Photo uploads for the Mission Phuket memory wall.
//
// The app's shared state lives as text in Upstash Redis, which is the wrong
// place for image bytes. Photos go to Vercel Blob instead, and only the short
// returned URL is saved into Redis (via api/mission.js, under `memories`).
//
// This uses the official @vercel/blob SDK. Even though the FRONTEND has no
// build step (CDN React + in-browser Babel), this BACKEND file does get an
// npm install on Vercel at deploy time, so importing the SDK here is fine and
// is the documented, stable, supported path (no hand-rolled REST guesswork).
//
// The frontend resizes each photo to ~1200px first, so the bytes arrive well
// under Vercel's 4.5 MB function body limit and upload fast on weak wifi.
//
// Needs the env var the Vercel dashboard adds when you create a Blob store:
//   BLOB_READ_WRITE_TOKEN
//
// Endpoint:
//   POST /api/photo?ext=jpg   body = raw (resized) image bytes
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

  // Auth: Vercel now defaults Blob connections to OIDC, which injects
  // BLOB_STORE_ID + VERCEL_OIDC_TOKEN automatically and the SDK uses them with
  // no token needed. Older setups inject a long-lived BLOB_READ_WRITE_TOKEN.
  // We support both: pass the token only if it exists, else let OIDC kick in.
  // (Passing an explicit empty token would override and BREAK OIDC, so we don't.)
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
    const pathname = `memories/${Date.now()}-${rand}.${ext}`;

    // Build options; only include `token` when we actually have one, so that
    // an absent token never overrides OIDC auto-detection.
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
