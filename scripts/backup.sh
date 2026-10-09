#!/usr/bin/env bash
# Dump the running database to <out_dir>/dcdash-<stamp>.dump (pg_dump custom format)
# and record the Alembic schema revision next to it in <dump>.version.
# Usage: scripts/backup.sh [out_dir=./backups]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-./backups}"; mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/dcdash-$STAMP.dump"
docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > "$FILE"
docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version" > "$FILE.version"
echo "wrote $FILE (schema $(cat "$FILE.version"))"
echo "note: .env and certs/ are NOT in this dump. .env holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of both with the dump, or the secrets cannot be decrypted after a restore." >&2
