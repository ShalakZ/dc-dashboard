#!/usr/bin/env bash
# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts/setup.sh --profile dev
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  db_password=$(openssl rand -hex 24)
  secret_key=$(openssl rand -base64 32 | tr '+/' '-_')
  printf 'DCDASH_DB_PASSWORD=%s\nDCDASH_SECRET_KEY=%s\nDCDASH_TIMEZONE=UTC\n' \
    "$db_password" "$secret_key" > .env
  echo "Created .env"
fi
docker compose "$@" up -d --build
