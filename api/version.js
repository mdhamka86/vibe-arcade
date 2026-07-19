// /api/version — deploy healthcheck (enhancement #4, 19/07/2026).
// Returns the git SHA Vercel built from, so deploy.sh can poll until the live
// deployment matches the local HEAD. Born of the 19/07 incident where a stale
// vercel.json broke every build for hours while GitHub byte-checks read green:
// GitHub-green is not production-green, and this endpoint is how we know.
module.exports = (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    ref: process.env.VERCEL_GIT_COMMIT_REF || null,
    at: new Date().toISOString(),
    region: process.env.VERCEL_REGION || null,
  });
};
