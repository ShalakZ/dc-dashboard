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
