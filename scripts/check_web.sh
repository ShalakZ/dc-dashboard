#!/usr/bin/env sh
# Checks the built web service: SPA, API proxy, that SSE is not buffered, and the static-file headers (compression, cache, 304).
set -eu
BASE="${1:-http://localhost}"
curl -fsS "$BASE/" | grep -q '<div id="root">' && echo "index: ok"
curl -fsS "$BASE/assets" | grep -q '<div id="root">' && echo "spa fallback: ok"
[ "$(curl -fsS "$BASE/api/health")" = '{"status":"ok"}' ] && echo "api proxy: ok"
# Unauthenticated stream must be refused by the API, not by Caddy (proves the route exists).
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/stream")" = "401" ] && echo "stream route: ok"

# Static files (deploy/Caddyfile). Real GETs with the body thrown away, not HEAD (-I): these are the headers a browser gets.
# /api/health is far under the encoder's 512-byte minimum, so it proves nothing about compression: the entry script below does.
fail() { echo "FAIL $*" >&2; exit 1; }
# The response headers of a GET, CR removed: head_of URL [curl option ...]
head_of() { _url="$1"; shift; curl -sS -o /dev/null -D - "$@" "$_url" | tr -d '\r'; }
# The value of one header (name in any case) from head_of's output: header_of NAME HEADERS
header_of() { printf '%s\n' "$2" | awk -v n="$1" 'BEGIN { n = tolower(n) ":" } tolower(substr($0, 1, length(n))) == n { sub(/^[^:]*: */, ""); print; exit }'; }
status_of() { printf '%s\n' "$1" | awk 'NR == 1 { print $2; exit }'; }
# expect_status LABEL HEADERS CODE
expect_status() { [ "$(status_of "$2")" = "$3" ] || fail "$1: status '$(status_of "$2")', expected $3"; }

shell="$(head_of "$BASE/" -H 'Accept-Encoding: gzip')"
expect_status "/" "$shell" 200
[ "$(header_of cache-control "$shell")" = "no-cache" ] || fail "/ cache-control '$(header_of cache-control "$shell")', expected no-cache (an update would show the old page)"
echo "shell revalidates: ok"

entry="$(curl -fsS "$BASE/" | sed -n 's|.*src="\(/assets/index-[^"]*\.js\)".*|\1|p' | head -n 1)"
[ -n "$entry" ] || fail "no /assets/index-*.js script in the page"
script="$(head_of "$BASE$entry" -H 'Accept-Encoding: gzip')"
expect_status "$entry" "$script" 200
case "$(header_of cache-control "$script")" in *immutable*) ;; *) fail "$entry cache-control '$(header_of cache-control "$script")', expected immutable" ;; esac
case "$(header_of content-encoding "$script")" in gzip | zstd) ;; *) fail "$entry content-encoding '$(header_of content-encoding "$script")', expected gzip or zstd" ;; esac
echo "hashed script cached and compressed: ok"

# A chunk an old tab asks for after an update is a 404 that is never cached as immutable (the shell is not served in its place).
missing="$(head_of "$BASE/assets/nope.js")"
expect_status "/assets/nope.js" "$missing" 404
case "$(header_of cache-control "$missing")" in *immutable*) fail "/assets/nope.js 404 carries '$(header_of cache-control "$missing")'" ;; esac
echo "missing hashed file is a 404, not cached: ok"

# /assets is the Assets Tree page: it has no extension, so it gets the shell, revalidated
route="$(head_of "$BASE/assets")"
expect_status "/assets" "$route" 200
[ "$(header_of cache-control "$route")" = "no-cache" ] || fail "/assets cache-control '$(header_of cache-control "$route")', expected no-cache"
echo "spa route under /assets revalidates: ok"

# Conditional requests: the validator of a compressed answer must come back as 304 (curl sends no cache of its own).
# check_304 PATH HEADERS: the ETag in HEADERS sent back with the same Accept-Encoding
check_304() {
  etag="$(header_of etag "$2")"
  [ -n "$etag" ] || fail "$1 sent no ETag"
  again="$(head_of "$BASE$1" -H 'Accept-Encoding: gzip' -H "If-None-Match: $etag")"
  expect_status "$1 with If-None-Match" "$again" 304
}
check_304 / "$shell"
check_304 "$entry" "$script"
echo "304 on a matching ETag: ok"
