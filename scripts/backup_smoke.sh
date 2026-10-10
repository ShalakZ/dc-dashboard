#!/usr/bin/env bash
# Exercise backup.sh and restore.sh against a stack of their own: back up, delete an asset, check that a mismatched .version is
# refused, restore, and verify the asset is back; then a corrupted dump must be refused and leave the database as it was.
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
# Failure path: restore.sh reads the whole dump before it stops or drops anything, so a corrupted dump is refused (exit 1) with
# nothing changed: the data is still there and api never stopped. (The recover() path of restore.sh, which runs once the database
# is being replaced, is covered by the fake-docker tests only: a real dump that reads fine but fails to restore is hard to make.)
head -c 100 "$DUMP" > "$DUMP.corrupt"; cp "$DUMP.version" "$DUMP.corrupt.version"
rc=0; scratch_script scripts/restore.sh "$DUMP.corrupt" || rc=$?
[[ "$rc" == 1 ]] || { echo "restore must refuse a corrupted dump with exit 1 (got $rc)"; exit 1; }
rm -f "$DUMP.corrupt" "$DUMP.corrupt.version"
[[ "$(psql "SELECT count(*) FROM assets")" == "$BEFORE" ]] || { echo "assets lost: a refused restore must change nothing"; exit 1; }
compose ps --status running --format '{{.Service}}' | grep -qx api || { echo "api not running after a refused restore"; exit 1; }
echo "restore failure-path OK"
