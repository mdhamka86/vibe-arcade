#!/usr/bin/env bash
# deploy.sh — push, then PROVE the deploy (enhancement #4, 19/07/2026).
# Usage: git add/commit as normal, then ./deploy.sh
# Polls /api/version until the live SHA matches local HEAD, then smoke-tests
# every serverless function. Exits nonzero on timeout so a broken build can
# never masquerade as a shipped one again.
set -e
cd "$(dirname "$0")"
BASE="https://vibe-arcade-omega.vercel.app"
git push
SHA=$(git rev-parse HEAD)
echo "pushed $SHA — waiting for Vercel to serve it…"
for i in $(seq 1 30); do
  sleep 10
  LIVE=$(curl -s --max-time 10 "$BASE/api/version" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')
  echo "  attempt $i/30: live=${LIVE:-unreachable}"
  if [ "$LIVE" = "$SHA" ]; then
    echo "DEPLOY LIVE. Smoke tests:"
    ok=0
    for ep in "version" "trawl?action=pack" "propose?action=charter" "stewards?action=status" "triage2?list=1"; do
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$BASE/api/$ep")
      name="${ep%%\?*}"
      echo "  /api/$name -> $code"
      case "$code" in 2*|409) : ;; *) ok=1 ;; esac
    done
    [ $ok -eq 0 ] && echo "ALL GREEN." || echo "CHECK THE FAILURES ABOVE."
    exit $ok
  fi
done
echo "TIMED OUT after 5 minutes — check the Vercel dashboard."
exit 1
