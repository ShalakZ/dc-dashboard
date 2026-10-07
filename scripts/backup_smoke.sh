#!/usr/bin/env bash
# Exercise backup.sh and restore.sh against the running stack: back up, delete an
# asset, check that a mismatched .version is refused, restore, and verify the asset is back.
set -euo pipefail
cd "$(dirname "$0")/.."
psql() { docker compose exec -T db psql -U dcdash -d dcdash -tAc "$1"; }
psql "INSERT INTO assets (name, parent_id) VALUES ('smoke-asset', NULL) ON CONFLICT DO NOTHING"
BEFORE="$(psql "SELECT count(*) FROM assets")"
scripts/backup.sh ./backups
DUMP="$(ls -t ./backups/*.dump | head -1)"
psql "DELETE FROM assets WHERE name = 'smoke-asset'"
echo "bogus" > "$DUMP.version.bak"; cp "$DUMP.version" "$DUMP.version.real"; cp "$DUMP.version.bak" "$DUMP.version"
if scripts/restore.sh "$DUMP"; then echo "restore must refuse a version mismatch"; exit 1; fi   # test_restore_refuses_version_mismatch
cp "$DUMP.version.real" "$DUMP.version"
scripts/restore.sh "$DUMP"
sleep 5
AFTER="$(psql "SELECT count(*) FROM assets")"
[[ "$BEFORE" == "$AFTER" ]] && echo "backup smoke OK ($AFTER assets)" || { echo "mismatch $BEFORE != $AFTER"; exit 1; }
# Failure path: a corrupted dump must fail the restore (non-zero exit) yet leave the database
# usable and api back up, because restore.sh recovers with timescaledb_post_restore() on exit.
head -c 100 "$DUMP" > "$DUMP.corrupt"; cp "$DUMP.version" "$DUMP.corrupt.version"
if scripts/restore.sh "$DUMP.corrupt"; then echo "restore must fail on a corrupted dump"; exit 1; fi
rm -f "$DUMP.corrupt" "$DUMP.corrupt.version"
[[ "$(psql "SELECT 1")" == "1" ]] || { echo "database unusable after failed restore"; exit 1; }
for _ in $(seq 1 30); do
  docker compose ps --status running --format '{{.Service}}' | grep -qx api && break; sleep 1
done
docker compose ps --status running --format '{{.Service}}' | grep -qx api || { echo "api not running after failed restore"; exit 1; }
scripts/restore.sh "$DUMP"     # put the real data back
sleep 5
[[ "$(psql "SELECT count(*) FROM assets")" == "$BEFORE" ]] && echo "restore failure-path OK" || { echo "assets lost after recovery"; exit 1; }
