#!/usr/bin/env bash
# Dump the running database to <out_dir>/dcdash-<stamp>.dump (pg_dump custom format) and record the Alembic schema revision next to it
# in <dump>.version.
# Usage: scripts/backup.sh [out_dir=./backups] [--keep N] [--copy-to DIR]
#   --keep N       (1 to 99999) after a verified new dump, delete the older dcdash-YYYYmmdd-HHMMSS.dump files (and their .version)
#                  beyond the newest N, in out_dir and in the --copy-to folder. Files with any other name, and dumps without a
#                  .version, are never touched. Without --keep nothing is ever deleted.
#   --copy-to DIR  also copy the dump and its .version to DIR. DIR must exist and contain a file .dcdash-backup-target whose first line
#                  is the Compose project name (create it once on the drive: echo dcdash > DIR/.dcdash-backup-target). That keeps a
#                  mount point with nothing mounted (an empty folder on the root disk), and a drive shared with another installation,
#                  from being used by mistake.
# Exit 1: the dump failed, was empty or cannot be read back, or a backup with this timestamp exists (nothing was created, nothing
# deleted). Exit 2: bad usage. Exit 5: the local backup was made but NOT copied (the copy folder is missing, not the right drive, or
# the copy failed); nothing is rotated then, so an absent drive cannot rotate away the last copied backups.
# The dump is written under a temporary name and renamed only after pg_restore has read all of it back, so a failed, empty or cut-off
# dump never replaces or evicts a good backup.
set -euo pipefail
cd "$(dirname "$0")/.."
USAGE="usage: backup.sh [out_dir] [--keep N] [--copy-to DIR]"
OUT=./backups; KEEP=0; COPY_TO=""
if [[ $# -gt 0 && "$1" != --* ]]; then OUT="$1"; shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]{0,4}$ ]] || { echo "$USAGE (--keep takes a whole number from 1 to 99999)" >&2; exit 2; }
      KEEP="$2"; shift 2 ;;
    --copy-to)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { echo "$USAGE" >&2; exit 2; }
      COPY_TO="$2"; shift 2 ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
PROJECT="$(docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1 || true)"
echo "backing up Compose project: ${PROJECT:-unknown}" >&2

# A bad copy folder does not stop the local backup: it is remembered and ends in exit 5.
COPY_PROBLEM=""
MARKER="$COPY_TO/.dcdash-backup-target"
if [[ -n "$COPY_TO" ]]; then
  if [[ ! -d "$COPY_TO" ]]; then
    COPY_PROBLEM="'$COPY_TO' is not an existing folder (is the drive mounted?)"
  elif [[ ! -f "$MARKER" ]]; then
    COPY_PROBLEM="'$COPY_TO' has no .dcdash-backup-target file (not the backup drive, or not set up yet; create it once on the drive: echo ${PROJECT:-dcdash} > '$MARKER')"
  elif [[ -n "$PROJECT" && "$(head -n 1 "$MARKER" | tr -d '\r')" != "$PROJECT" ]]; then
    COPY_PROBLEM="'$COPY_TO' belongs to another installation (its .dcdash-backup-target names '$(head -n 1 "$MARKER" | tr -d '\r')', this is '$PROJECT')"
  fi
  [[ -z "$COPY_PROBLEM" ]] || echo "--copy-to: $COPY_PROBLEM. The local backup is still made; it will NOT be copied." >&2
fi

mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/dcdash-$STAMP.dump"
NAME="$(basename "$FILE")"
PARTIAL="$OUT/.dcdash-$STAMP.partial"
if [[ -e "$FILE" ]]; then
  echo "a backup named $NAME already exists (two backups in the same second); wait a second and run again. Nothing was changed." >&2
  exit 1
fi
cleanup() { rm -f "$PARTIAL" "$FILE.version.partial"; }
trap cleanup EXIT

docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > "$PARTIAL" \
  || { echo "pg_dump failed; no backup was made and no old backup was touched" >&2; exit 1; }
[[ -s "$PARTIAL" ]] || { echo "pg_dump wrote nothing; no backup was made and no old backup was touched" >&2; exit 1; }
# A full read, not --list: --list only reads the table of contents, so a dump cut off in its data section would pass.
docker compose exec -T db pg_restore -f /dev/null < "$PARTIAL" \
  || { echo "the new dump cannot be read back; no backup was made and no old backup was touched" >&2; exit 1; }
VERSION="$(docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version")" \
  || { echo "could not read the schema revision; no backup was made and no old backup was touched" >&2; exit 1; }
[[ -n "$VERSION" ]] || { echo "the schema revision is empty; no backup was made and no old backup was touched" >&2; exit 1; }
mv "$PARTIAL" "$FILE"
printf '%s\n' "$VERSION" > "$FILE.version.partial"
mv "$FILE.version.partial" "$FILE.version"
echo "wrote $FILE (schema $VERSION)"
echo "note: .env and certs/ are NOT in this dump. .env holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of both with the dump, or the secrets cannot be decrypted after a restore." >&2

copy_out() {
  local p="$COPY_TO/.$NAME.partial" v="$COPY_TO/.$NAME.version.partial"
  [[ ! -e "$COPY_TO/$NAME" ]] && cp "$FILE" "$p" && cp "$FILE.version" "$v" && cmp -s "$FILE" "$p" && cmp -s "$FILE.version" "$v" \
    && mv "$v" "$COPY_TO/$NAME.version" && mv "$p" "$COPY_TO/$NAME"
}
if [[ -n "$COPY_TO" && -z "$COPY_PROBLEM" ]]; then
  if copy_out; then
    echo "copied to $COPY_TO"
  else
    rm -f "$COPY_TO/.$NAME.partial" "$COPY_TO/.$NAME.version.partial"
    COPY_PROBLEM="the copy to '$COPY_TO' failed"
    echo "$COPY_PROBLEM" >&2
  fi
fi

# Oldest first by name (the stamp sorts like time; the glob sorts ascending). The dump written by this run is never deleted,
# whatever the clock said.
rotate() {
  local dir="$1" f i; local -a all=()
  for f in "$dir"/dcdash-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].dump; do
    [[ -f "$f" && -f "$f.version" ]] && all+=("$f")
  done
  local excess=$(( ${#all[@]} - KEEP ))
  for (( i = 0; i < excess; i++ )); do
    [[ "$(basename "${all[$i]}")" == "$NAME" ]] && continue
    rm -f -- "${all[$i]}" "${all[$i]}.version"
    echo "removed old backup ${all[$i]}" >&2
  done
}
if (( KEEP > 0 )) && [[ -z "$COPY_PROBLEM" ]]; then
  rotate "$OUT"
  [[ -z "$COPY_TO" ]] || rotate "$COPY_TO"
fi
if [[ -n "$COPY_PROBLEM" ]]; then
  echo "local backup made, NOT copied; nothing was rotated (exit 5)" >&2
  exit 5
fi
