#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into the running stack.
# Usage: scripts/restore.sh <dump> [--force]
# Refuses (exit 3) when the dump's Alembic revision differs from the running schema
# unless --force is given; after a forced restore the api container migrates on start.
# Whatever happens after timescaledb_pre_restore(), the script runs timescaledb_post_restore()
# and starts api/collector again, so a failed restore never leaves the database stranded.
set -euo pipefail
cd "$(dirname "$0")/.."
DUMP="${1:?usage: restore.sh <dump> [--force]}"; FORCE="${2:-}"
CURRENT="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc 'SELECT version_num FROM alembic_version' || true)"
WANTED="$(cat "$DUMP.version" 2>/dev/null || echo unknown)"
if [[ "$CURRENT" != "$WANTED" && "$FORCE" != "--force" ]]; then
  echo "refusing: dump schema '$WANTED' differs from running schema '$CURRENT' (use --force to restore then migrate)" >&2
  exit 3
fi
LOG="${TMPDIR:-/tmp}/dcdash-restore-$(date +%Y%m%d-%H%M%S).log"
PRE_RESTORE_DONE=0
recover() {
  local rc=$?
  if [[ "$PRE_RESTORE_DONE" == 1 ]]; then
    docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()" >/dev/null || true
    docker compose start api collector >/dev/null || true   # api runs `alembic upgrade head`, a no-op unless --force restored an older schema
    [[ "$rc" == 0 ]] || echo "restore failed (exit $rc): ran timescaledb_post_restore() and started api/collector; log: $LOG" >&2
  fi
  exit "$rc"
}
trap recover EXIT
docker compose stop api collector
docker compose exec -T db psql -U dcdash -d postgres -c "DROP DATABASE IF EXISTS dcdash WITH (FORCE)" -c "CREATE DATABASE dcdash OWNER dcdash"
docker compose exec -T db psql -U dcdash -d dcdash -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
PRE_RESTORE_DONE=1
set +e
docker compose exec -T db pg_restore -U dcdash -d dcdash --no-owner < "$DUMP" 2> "$LOG"
RC=$?
set -e
# pg_restore exits 1 for ignorable warnings (e.g. ownership with --no-owner) as well as real errors.
if [[ "$RC" -gt 1 ]] || { [[ "$RC" == 1 ]] && grep -qi "error" "$LOG"; }; then
  echo "pg_restore failed (exit $RC); see $LOG" >&2
  exit 1
fi
[[ -s "$LOG" ]] && echo "pg_restore warnings in $LOG"
echo "restored $DUMP"
