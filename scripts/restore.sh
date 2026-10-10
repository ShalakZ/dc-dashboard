#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into the running stack.
# Usage: scripts/restore.sh <dump> [--force] [--apply-retention]
# Refuses (exit 3) when the dump's Alembic revision differs from the running schema
# unless --force is given; after a forced restore the api container migrates on start.
# The dump is read completely before anything is changed: when it cannot be read (missing, cut off, damaged) the script exits 1
# with nothing touched, so the running database is never dropped for a dump that could not have been restored.
# Retention: the restored retention jobs run the moment the database starts its background jobs again and delete every chunk
# older than the restored limits, so restoring an old dump would lose its old data within seconds. Between pg_restore and
# timescaledb_post_restore() the script runs scripts/restore_retention.sql: it prints what the policies would delete and,
# when that is more than nothing, pauses the retention jobs (saving the Storage page starts them again). --apply-retention
# leaves them scheduled, so the data beyond the limits is deleted as the policies say.
# Exit 4: the restore worked but the retention check failed (every retention job was paused to be safe unless --apply-retention
# was given; read the messages).
# Whatever happens after timescaledb_pre_restore(), the script runs timescaledb_post_restore()
# and starts api/collector again, so a failed restore never leaves the database stranded. A failure between the stop of api/collector
# and pre_restore (exit 1, "before the dump was loaded") starts them again too; the database may then be missing or empty: run the
# restore again with the same dump.
# Exit 2: bad usage (no dump argument, unknown flag). Exit 1 also when the dump file does not exist or cannot be read.
set -euo pipefail
cd "$(dirname "$0")/.."
USAGE="usage: restore.sh <dump> [--force] [--apply-retention]"
[[ $# -ge 1 ]] || { echo "$USAGE" >&2; exit 2; }
DUMP="$1"; shift
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
# A mistyped path is named as such: it has no .version either, which would otherwise end in the schema refusal (exit 3) and its advice
# to use --force. A damaged file is caught by the read check below.
if [[ ! -f "$DUMP" || ! -r "$DUMP" ]]; then
  echo "refusing: no such dump file '$DUMP'; nothing was changed" >&2
  exit 1
fi
CURRENT="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc 'SELECT version_num FROM alembic_version' || true)"
WANTED="$(cat "$DUMP.version" 2>/dev/null || echo unknown)"
if [[ "$CURRENT" != "$WANTED" && "$FORCE" != "--force" ]]; then
  echo "refusing: dump schema '$WANTED' differs from running schema '$CURRENT' (use --force to restore then migrate)" >&2
  exit 3
fi
# Read the whole dump (a read-only call; /dev/null is the path inside the container) before anything is stopped or dropped.
# The trap below is not installed yet, so a plain exit is right.
if ! docker compose exec -T db pg_restore -f /dev/null < "$DUMP"; then
  echo "refusing: cannot read the dump '$DUMP' (missing, cut off or damaged); nothing was changed" >&2
  exit 1
fi
LOG="${TMPDIR:-/tmp}/dcdash-restore-$(date +%Y%m%d-%H%M%S).log"
PRE_RESTORE_DONE=0
STOPPED=0   # api and collector are being stopped (set just before the stop call, which may fail half-way)
recover() {
  local rc=$?
  if [[ "$PRE_RESTORE_DONE" == 0 && "$STOPPED" == 1 ]]; then
    # Failed after the stop and before the dump was loaded (stop, DROP/CREATE DATABASE, CREATE EXTENSION, pre_restore): there is nothing
    # to post_restore, but api and collector must not stay down. The exit code is 1, never the raw code of the failing psql (2 = usage).
    docker compose start api collector >/dev/null || true
    echo "restore failed (exit $rc) before the dump was loaded: api and collector were started again; the database may be missing or empty. Run the restore again with the same dump." >&2
    rc=1
  elif [[ "$PRE_RESTORE_DONE" == 1 ]]; then
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
STOPPED=1
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
