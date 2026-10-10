#!/usr/bin/env bash
# Pins every external container image by digest: <ref> becomes <ref>@sha256:<64 hex> in backend/Dockerfile, frontend/Dockerfile and
# compose.yaml, so a rebuild cannot change the base layers by surprise, and security fixes only arrive when you re-pin.
# Usage: scripts/pin_images.sh --check | --update
# --check   needs no network and no docker. Exit 1, naming the file, when an external reference is unpinned or its digest is malformed,
#           when a reference in a file is not in the table below, or when a table reference is missing from its file.
# --update  asks the registry for the digest of each tag (docker buildx imagetools inspect <ref>, the digest is the first `Digest:`
#           line), rewrites the files in place, one after the other, and prints a before/after table. Nothing is written unless
#           all five answers are valid digests. If the check of the rewritten files then fails, the files stay rewritten and the
#           script says so (exit 1): `git diff` shows the change, `git checkout` on the three files undoes it. Idempotent. Run it
#           before a release or monthly, rebuild, run the tests, commit.
# Exit 2: bad usage.
set -euo pipefail
export LC_ALL=C   # [0-9a-f] must not match capitals
cd "$(dirname "$0")/.."

# One "file reference" pair per line: the external images the project builds on or runs. The locally built tags (dcdash-*:local) and
# build stages are not external. A new external image goes here AND into EXPECTED in backend/tests/test_images_pinned.py.
PINS=(
  "backend/Dockerfile python:3.12-slim"
  "backend/Dockerfile ghcr.io/astral-sh/uv:0.13.0"
  "frontend/Dockerfile node:22-alpine"
  "frontend/Dockerfile caddy:2-alpine"
  "compose.yaml timescale/timescaledb:2.30.2-pg16"
)
DIGEST_RE='^sha256:[0-9a-f]{64}$'

usage() { echo "usage: scripts/pin_images.sh --check | --update" >&2; exit 2; }
[[ $# -eq 1 ]] || usage
case "$1" in --check | --update) MODE="$1" ;; *) usage ;; esac

fail=0
err() { echo "pin_images: $1" >&2; fail=1; }

# Every external reference of a file, as written (with its @digest if it has one), one per line: FROM x [AS y], COPY --from=x (neither
# a build stage nor scratch nor a stage number), and in compose.yaml every `image:` that is not a local tag.
refs_in() {
  case "$1" in
    *.yaml) awk '{ sub(/\r$/, "") }
        $1 == "image:" { r = $2; gsub(/["\047]/, "", r); if (r !~ /:local$/) print r }' "$1" ;;
    *) awk '{ sub(/\r$/, "") }
        $1 == "FROM" {
          i = 2; while ($i ~ /^--/) i++
          r = $i
          if (!(tolower(r) in stage) && tolower(r) != "scratch") print r
          if (toupper($(i + 1)) == "AS") stage[tolower($(i + 2))] = 1
        }
        $1 == "COPY" {
          for (i = 2; i <= NF; i++) if ($i ~ /^--from=/) {
            r = substr($i, 8)
            if (!(tolower(r) in stage) && r !~ /^[0-9]+$/) print r
          }
        }' "$1" ;;
  esac
}

files() { local pin; for pin in "${PINS[@]}"; do echo "${pin%% *}"; done | sort -u; }
in_table() { local pin; for pin in "${PINS[@]}"; do [[ $pin == "$1 $2" ]] && return 0; done; return 1; }
has_line() { [[ $'\n'"$1"$'\n' == *$'\n'"$2"$'\n'* ]]; }

# The file and the table agree on which references exist.
check_structure() {
  local f ref pin bases
  for f in $(files); do
    [[ -f $f ]] || { err "$f: file not found"; continue; }
    bases="$(refs_in "$f" | sed 's/@.*//')"
    while IFS= read -r ref; do
      [[ -z $ref ]] || in_table "$f" "$ref" ||
        err "$f: $ref is not in the table of scripts/pin_images.sh (a new image? add it there and to EXPECTED in backend/tests/test_images_pinned.py)"
    done <<< "$bases"
  done
  for pin in "${PINS[@]}"; do
    f="${pin%% *}"; ref="${pin#* }"
    [[ ! -f $f ]] || has_line "$(refs_in "$f" | sed 's/@.*//')" "$ref" ||
      err "$f: $ref is in the table of scripts/pin_images.sh but not in the file"
  done
}

# Every table reference that is in its file carries a full digest.
check_digests() {
  local f ref base
  for f in $(files); do
    [[ -f $f ]] || continue
    while IFS= read -r ref; do
      [[ -n $ref ]] || continue
      base="${ref%%@*}"
      in_table "$f" "$base" || continue   # reported by check_structure
      if [[ $ref != *@* ]]; then
        err "$f: $base is not pinned (expected $base@sha256:<64 hex>; run scripts/pin_images.sh --update)"
      elif ! [[ ${ref#*@} =~ $DIGEST_RE ]]; then
        err "$f: $base has a malformed digest '${ref#*@}' (expected sha256: and 64 lowercase hex; run scripts/pin_images.sh --update)"
      fi
    done <<< "$(refs_in "$f")"
  done
}

short() { [[ $1 == sha256:* ]] && echo "${1#sha256:}" | cut -c1-12 || echo "$1"; }

if [[ $MODE == --check ]]; then
  check_structure
  check_digests
  [[ $fail -eq 0 ]] || exit 1
  echo "pin_images: all ${#PINS[@]} external image references are pinned by digest"
  exit 0
fi

# --update: look at the files first (a mismatch means the table or a file is wrong, no need to ask the registry), then ask for all
# digests, and only then write.
check_structure
[[ $fail -eq 0 ]] || exit 1
command -v docker > /dev/null || { echo "pin_images: docker not found; --update asks the registry through 'docker buildx imagetools inspect'" >&2; exit 1; }
NEW=()
for i in "${!PINS[@]}"; do
  f="${PINS[$i]%% *}"; ref="${PINS[$i]#* }"
  out="$(docker buildx imagetools inspect "$ref" 2>&1)" || {
    echo "pin_images: $f: could not read the digest of $ref: ${out:-no output}" >&2; exit 1; }
  digest="$(printf '%s\n' "$out" | awk '/^Digest:/ { print $2; exit }')"
  [[ $digest =~ $DIGEST_RE ]] || {
    echo "pin_images: $f: the registry's answer for $ref has no valid digest (wanted sha256: and 64 lowercase hex, got '${digest:-no Digest: line}'); no file was changed" >&2; exit 1; }
  NEW[i]="$digest"
done

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
printf '%-20s %-36s %-14s %-14s\n' file reference before after
for i in "${!PINS[@]}"; do
  f="${PINS[$i]%% *}"; ref="${PINS[$i]#* }"
  old="$(refs_in "$f" | awk -v r="$ref" '{ n = split($0, a, "@"); if (a[1] == r) { print (n > 1 ? a[2] : "none"); exit } }')"
  # only the FROM / COPY / image: lines, and only the whole reference (a following tag character would make it another image);
  # a single or double quote around the reference (image: "ref") stays where it is
  re="$(printf '%s' "$ref" | sed 's/[.]/\\./g')"
  q=$'["\']'
  sed -E "/^[[:space:]]*(FROM|COPY|image:)[[:space:]]/ s#(^|[[:space:]=])(${q}?)${re}(@[^[:space:]\"']*)?(${q}?)([[:space:]]|\$)#\1\2${ref}@${NEW[$i]}\4\5#g" "$f" > "$TMP"
  cat "$TMP" > "$f"   # not mv: the file keeps its mode
  printf '%-20s %-36s %-14s %-14s%s\n' "$f" "$ref" "$(short "$old")" "$(short "${NEW[$i]}")" "$([[ $old == "${NEW[$i]}" ]] && echo '  (unchanged)')"
done

check_structure
check_digests
[[ $fail -eq 0 ]] || { echo "pin_images: the files were rewritten but do not pass --check; see git diff (git checkout backend/Dockerfile frontend/Dockerfile compose.yaml undoes it)" >&2; exit 1; }
echo "pin_images: done; review git diff, rebuild, run the tests, commit"
