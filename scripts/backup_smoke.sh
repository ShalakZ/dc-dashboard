#!/usr/bin/env bash
# Exercise backup.sh and restore.sh against a stack of their own: back up, delete an asset, check that a mismatched .version is
# refused, restore, and verify the asset is back; then a corrupted dump must fail the restore and leave the database usable.
# It builds and removes its own throwaway project (OPS_COMPOSE_PROJECT, default dcdash_e2e_smoke); never touches the normal stack.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/scratch.sh
scratch_init dcdash_e2e_smoke
compose build api && compose up -d --wait --wait-timeout 180 db api collector
psql() { compose exec -T db psql -U dcdash -d dcdash -tAc "$1"; }
OUT="$SCRATCH_WORK/backups"
psql "INSERT INTO assets (name, parent_id) VALUES ('smoke-asset', NULL) ON CONFLICT DO NOTHING"
BEFORE="$(psql "SELECT count(*) FROM assets")"
scratch_script scripts/backup.sh "$OUT"
DUMP="$(ls -t "$OUT"/*.dump | head -1)"
psql "DELETE FROM assets WHERE name = 'smoke-asset'"
echo "bogus" > "$DUMP.version.bak"; cp "$DUMP.version" "$DUMP.version.real"; cp "$DUMP.version.bak" "$DUMP.version"
rc=0; scratch_script scripts/restore.sh "$DUMP" || rc=$?   # test_restore_refuses_version_mismatch
[[ "$rc" == 3 ]] || { echo "restore must refuse a version mismatch with exit 3 (got $rc)"; exit 1; }
cp "$DUMP.version.real" "$DUMP.version"
scratch_script scripts/restore.sh "$DUMP"
sleep 5
AFTER="$(psql "SELECT count(*) FROM assets")"
[[ "$BEFORE" == "$AFTER" ]] && echo "backup smoke OK ($AFTER assets)" || { echo "mismatch $BEFORE != $AFTER"; exit 1; }
# Failure path: a corrupted dump must fail the restore (exit 1) yet leave the database
# usable and api back up, because restore.sh recovers with timescaledb_post_restore() on exit.
head -c 100 "$DUMP" > "$DUMP.corrupt"; cp "$DUMP.version" "$DUMP.corrupt.version"
rc=0; scratch_script scripts/restore.sh "$DUMP.corrupt" || rc=$?
[[ "$rc" == 1 ]] || { echo "restore must fail on a corrupted dump with exit 1 (got $rc)"; exit 1; }
rm -f "$DUMP.corrupt" "$DUMP.corrupt.version"
[[ "$(psql "SELECT 1")" == "1" ]] || { echo "database unusable after failed restore"; exit 1; }
for _ in $(seq 1 30); do
  compose ps --status running --format '{{.Service}}' | grep -qx api && break; sleep 1
done
compose ps --status running --format '{{.Service}}' | grep -qx api || { echo "api not running after failed restore"; exit 1; }
scratch_script scripts/restore.sh "$DUMP"     # put the real data back
sleep 5
[[ "$(psql "SELECT count(*) FROM assets")" == "$BEFORE" ]] && echo "restore failure-path OK" || { echo "assets lost after recovery"; exit 1; }
