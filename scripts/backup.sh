#!/usr/bin/env bash
# Dump the running database to <out_dir>/dcdash-<stamp>.dump (pg_dump custom format) and record the Alembic schema revision next to it
# in <dump>.version.
# Usage: scripts/backup.sh [out_dir=./backups] [--keep N] [--copy-to DIR]
#   --keep N       (1 to 99999) after a verified new dump, delete the older dcdash-YYYYmmdd-HHMMSS.dump files (and their .version)
#                  beyond the newest N, in out_dir and in the --copy-to folder. Files with any other name, and dumps without a
#                  .version, are never touched. Without --keep nothing is ever deleted. A folder that holds a dump named LATER than
#                  this backup (the clock went back, or a file was misnamed) is not rotated at all, with a message on stderr: oldest
#                  first would otherwise eat the previous nights' backups while the clock is wrong. A removal that fails is reported
#                  on stderr only; the exit code stays 0 because the new backup is fine.
#   --copy-to DIR  also copy the dump and its .version to DIR. DIR must exist, must not be out_dir, and must contain a file
#                  .dcdash-backup-target whose first line is the Compose project name (create it once on the drive:
#                  echo dcdash > DIR/.dcdash-backup-target). That keeps a mount point with nothing mounted (an empty folder on the root
#                  disk), and a drive that was set up for another Compose project, from being used by mistake. The marker holds only
#                  the project name, so installations that share one drive need different Compose project names.
# Only one backup runs at a time per out_dir (a lock on the folder; skipped with a warning when flock is not installed).
# Exit 1: the dump failed, was empty or cannot be read back, another backup is running, or a backup with this timestamp exists
# (nothing was created, nothing deleted). Exit 2: bad usage. Exit 5: the local backup was made but NOT copied (the copy folder is
# missing, not the right drive, or the copy failed); nothing is rotated then, so an absent drive cannot rotate away the last copied
# backups.
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
  elif [[ "$OUT" -ef "$COPY_TO" ]]; then
    COPY_PROBLEM="'$COPY_TO' is the output folder itself (the copy folder is the output folder; --copy-to must be another folder, on the backup drive)"
  elif [[ -z "$PROJECT" ]]; then
    COPY_PROBLEM="cannot tell which Compose project this is (docker compose config failed), so the marker in '$COPY_TO' cannot be checked"
  elif [[ ! -f "$MARKER" ]]; then
    COPY_PROBLEM="'$COPY_TO' has no .dcdash-backup-target file (not the backup drive, or not set up yet; create it once on the drive: echo $PROJECT > '$MARKER')"
  else
    # first line only; a Windows editor may have added a carriage return or a UTF-8 byte order mark
    MARKER_NAME="$(head -n 1 "$MARKER" 2>/dev/null | tr -d '\r' || true)"; MARKER_NAME="${MARKER_NAME#$'\xef\xbb\xbf'}"
    [[ "$MARKER_NAME" == "$PROJECT" ]] \
      || COPY_PROBLEM="'$COPY_TO' belongs to another installation (its .dcdash-backup-target names '$MARKER_NAME', this is '$PROJECT')"
  fi
  [[ -z "$COPY_PROBLEM" ]] || echo "--copy-to: $COPY_PROBLEM. The local backup will still be attempted; it will NOT be copied." >&2
fi

mkdir -p "$OUT"
# One backup at a time: two runs started in the same second would share one .partial and the first would rotate on the strength of
# a verification of bytes the second run is still writing. The lock is on the folder itself (no file appears in it), taken before
# the same-second check and before the clean-up trap below, so a refused run cannot delete the other run's partial.
if [[ -r "$OUT" ]] && command -v flock >/dev/null 2>&1; then
  exec 9<"$OUT"
  LOCK_RC=0; flock -n -E 200 9 || LOCK_RC=$?
  if (( LOCK_RC == 200 )); then
    echo "another backup is running in $OUT; nothing was changed" >&2
    exit 1
  elif (( LOCK_RC != 0 )); then
    echo "warning: could not lock $OUT (flock exit $LOCK_RC); two backups started at the same moment could damage each other" >&2
  fi
else
  echo "warning: no lock on $OUT (flock is not installed or the folder is not readable); two backups started at the same moment could damage each other" >&2
fi
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
    # cmp read the copy back from the page cache: push it to the drive before anything is deleted (best effort; older coreutils
    # only take no operand)
    sync "$COPY_TO/$NAME" "$COPY_TO/$NAME.version" "$COPY_TO" 2>/dev/null || sync 2>/dev/null || true
    echo "copied to $COPY_TO"
  else
    rm -f "$COPY_TO/.$NAME.partial" "$COPY_TO/.$NAME.version.partial"
    COPY_PROBLEM="the copy to '$COPY_TO' failed"
    echo "$COPY_PROBLEM" >&2
  fi
fi

# Oldest first by name (the stamp sorts like time; the glob sorts ascending). The dump written by this run is never deleted. When
# a dump sorts after it the folder is left alone (see --keep above).
rotate() {
  local dir="$1" f i last; local -a all=()
  for f in "$dir"/dcdash-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].dump; do
    [[ -f "$f" && -f "$f.version" ]] && all+=("$f")
  done
  if (( ${#all[@]} > 0 )); then
    last="$(basename "${all[${#all[@]}-1]}")"
    if [[ "$last" != "$NAME" ]]; then
      echo "not rotating $dir: $last is named later than this backup (is the clock right?)" >&2
      return 0
    fi
  fi
  local excess=$(( ${#all[@]} - KEEP ))
  for (( i = 0; i < excess; i++ )); do
    [[ "$(basename "${all[$i]}")" == "$NAME" ]] && continue
    # the dump first, its .version after: a failed removal leaves a complete pair, never a dump without its .version
    if rm -f -- "${all[$i]}"; then
      rm -f -- "${all[$i]}.version" || echo "could not remove ${all[$i]}.version; the new backup is fine" >&2
      echo "removed old backup ${all[$i]}" >&2
    else
      echo "could not remove ${all[$i]}; the new backup is fine" >&2
    fi
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
