#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into the running stack.
# Usage: scripts/restore.sh <dump> [--force]
# Refuses (exit 3) when the dump's Alembic revision differs from the running schema
# unless --force is given; after a forced restore the api container migrates on start.
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:?usage: restore.sh <dump> [--force]}"; FORCE="${2:-}"
CURRENT="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc 'SELECT version_num FROM alembic_version' || true)"
WANTED="$(cat "$DUMP.version" 2>/dev/null || echo unknown)"
if [[ "$CURRENT" != "$WANTED" && "$FORCE" != "--force" ]]; then
  echo "refusing: dump schema '$WANTED' differs from running schema '$CURRENT' (use --force to restore then migrate)" >&2
  exit 3
fi
docker compose stop api collector
docker compose exec -T db psql -U dcdash -d postgres -c "DROP DATABASE IF EXISTS dcdash WITH (FORCE)" -c "CREATE DATABASE dcdash OWNER dcdash"
docker compose exec -T db psql -U dcdash -d dcdash -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
docker compose exec -T db pg_restore -U dcdash -d dcdash --no-owner < "$DUMP"
docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()"
docker compose start api collector      # api runs `alembic upgrade head`, which is a no-op unless --force restored an older schema
echo "restored $DUMP"
