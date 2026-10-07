#!/usr/bin/env bash
# Generates a throwaway self-signed certificate, starts the stack with TLS on, and checks that
# HTTPS answers and HTTP redirects. Then shows the clear error for a missing key file.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
  -keyout certs/privkey.pem -out certs/fullchain.pem 2>/dev/null
# the web container runs as uid/gid 10002: owner+group read on the key, no world access
chmod 644 certs/fullchain.pem
sudo chown 10002:10002 certs/privkey.pem
sudo chmod 640 certs/privkey.pem
export DCDASH_TLS_CERT=/certs/fullchain.pem DCDASH_TLS_KEY=/certs/privkey.pem
docker compose up -d --build web
sleep 3
echo "https -> $(curl -sk -o /dev/null -w '%{http_code}' https://localhost/api/setup)   (expect 200)"
echo "http  -> $(curl -s  -o /dev/null -w '%{http_code}' http://localhost/api/setup)    (expect 308)"
docker compose stop web
# `run` (not `up`) so the restart policy does not apply and the container's exit code is ours.
{ DCDASH_TLS_KEY=/certs/missing.pem docker compose run --rm --no-deps web 2>&1 || true; } \
  | grep -m1 "TLS file not readable" || echo "FAIL: no clear error"
docker compose down
rm -f certs/privkey.pem certs/fullchain.pem
