#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into the running stack.
# Usage: scripts/restore.sh <dump> [--force] [--apply-retention]
# Refuses (exit 3) when the dump's Alembic revision differs from the running schema
# unless --force is given; after a forced restore the api container migrates on start.
# Retention: the restored retention jobs run the moment the database starts its background jobs again and delete every chunk
# older than the restored limits, so restoring an old dump would lose its old data within seconds. Between pg_restore and
# timescaledb_post_restore() the script runs scripts/restore_retention.sql: it prints what the policies would delete and,
# when that is more than nothing, pauses the retention jobs (saving the Storage page starts them again). --apply-retention
# leaves them scheduled, so the data beyond the limits is deleted as the policies say.
# Exit 4: the restore worked but the retention check failed (every retention job was paused to be safe unless --apply-retention
# was given; read the messages).
# Whatever happens after timescaledb_pre_restore(), the script runs timescaledb_post_restore()
# and starts api/collector again, so a failed restore never leaves the database stranded.
set -euo pipefail
cd "$(dirname "$0")/.."
USAGE="usage: restore.sh <dump> [--force] [--apply-retention]"
DUMP="${1:?$USAGE}"; shift
FORCE=""; APPLY_RETENTION=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    --apply-retention) APPLY_RETENTION=1 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
PROJECT="$(docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1 || true)"
echo "restoring into Compose project: ${PROJECT:-unknown}" >&2
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
    # Before the background workers come back: print what retention would delete and pause it if that is data.
    if ! docker compose exec -T db psql -U dcdash -d dcdash -q -v ON_ERROR_STOP=1 -v apply_retention="$APPLY_RETENTION" < scripts/restore_retention.sql; then
      # Fail safe: pausing loses nothing (the Storage page shows a banner and a Save starts retention again); not pausing
      # lets the restored policies delete the old data the moment post_restore runs.
      if [[ "$APPLY_RETENTION" == 0 ]] && docker compose exec -T db psql -U dcdash -d dcdash -qtAc \
          "SELECT count(*) FROM (SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention') paused" >/dev/null; then
        echo "could not check retention (see scripts/restore_retention.sql): paused every retention job to be safe" >&2
      else
        echo "could not check or pause retention: data older than the restored limits may be deleted now" >&2
      fi
      [[ "$rc" != 0 ]] || rc=4
    fi
    docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()" >/dev/null || true
    docker compose start api collector >/dev/null || true   # api runs `alembic upgrade head`, a no-op unless --force restored an older schema
    if [[ "$rc" == 4 ]]; then
      echo "restore done, but the retention check failed (exit 4): read the lines above; post_restore ran and api/collector were started" >&2
    elif [[ "$rc" != 0 ]]; then
      echo "restore failed (exit $rc): ran timescaledb_post_restore() and started api/collector; log: $LOG" >&2
    fi
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
