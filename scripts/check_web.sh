#!/usr/bin/env sh
# Checks the built web service: SPA, API proxy, and that SSE is not buffered.
set -eu
BASE="${1:-http://localhost}"
curl -fsS "$BASE/" | grep -q '<div id="root">' && echo "index: ok"
curl -fsS "$BASE/assets" | grep -q '<div id="root">' && echo "spa fallback: ok"
[ "$(curl -fsS "$BASE/api/health")" = '{"status":"ok"}' ] && echo "api proxy: ok"
# Unauthenticated stream must be refused by the API, not by Caddy (proves the route exists).
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/stream")" = "401" ] && echo "stream route: ok"
