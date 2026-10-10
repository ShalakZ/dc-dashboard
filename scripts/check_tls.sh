#!/usr/bin/env bash
# Builds a throwaway stack in its own Compose project (OPS_COMPOSE_PROJECT, default dcdash_e2e_tls; the name must start with dcdash_e2e),
# turns TLS on with a self-signed certificate kept in a temporary folder, and checks that HTTPS answers, HTTP redirects and a missing key
# gives the clear error. Exit 1 when a check fails. Nothing of the normal project is changed: not ./certs, not the images
# dcdash-*:local, not ports 80/443 (the stack is published on 127.0.0.1:18080/18443); the secrets in .env are overridden by the environment.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/scratch.sh
scratch_init dcdash_e2e_tls
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout "$SCRATCH_CERTS_DIR/privkey.pem" -out "$SCRATCH_CERTS_DIR/fullchain.pem" 2>/dev/null
chmod 644 "$SCRATCH_CERTS_DIR/fullchain.pem"
export DCDASH_TLS_CERT=/certs/fullchain.pem DCDASH_TLS_KEY=/certs/privkey.pem
compose build api web   # api and web have different tags; building everything in parallel collides on the shared backend tag
# The web container runs as uid/gid 10002: give it the key the way the README says, through a throwaway container (no sudo, no prompt).
docker run --rm --user 0 --entrypoint sh -v "$SCRATCH_CERTS_DIR:/c" "${SCRATCH_PROJECT}-web:scratch" \
  -c 'chown 10002:10002 /c/privkey.pem && chmod 640 /c/privkey.pem'
compose up -d web
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1: $2"; else echo "FAIL $1: got '$2', expected '$3'"; fail=1; fi; }
# by name with --resolve, as the old script did (https://localhost): a client that connects to an IP address sends no SNI
https() { curl -sk --resolve "localhost:$SCRATCH_HTTPS_PORT:127.0.0.1" -o /dev/null -w '%{http_code}' "https://localhost:$SCRATCH_HTTPS_PORT/api/setup" || true; }
for _ in $(seq 1 60); do [ "$(https)" = 200 ] && break; sleep 2; done
check "https" "$(https)" 200
check "http redirects" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SCRATCH_HTTP_PORT/api/setup" || true)" 308
compose stop web
# `run` (not `up`) so the restart policy does not apply and the container's exit code is ours.
out="$(compose run --rm --no-deps -e DCDASH_TLS_KEY=/certs/missing.pem web 2>&1 || true)"
case "$out" in *"TLS file not readable"*) echo "ok   missing key: clear error" ;; *) echo "FAIL missing key: no clear error"; fail=1 ;; esac
exit "$fail"
