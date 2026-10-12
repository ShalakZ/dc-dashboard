#!/usr/bin/env bash
# Host facts for field debugging when the web app itself is down: one text file to copy and paste to whoever helps.
# Usage: bash scripts/collect-diagnostics.sh [host:port ...] [--project-dir DIR] [--out-dir DIR]
#        bash scripts/collect-diagnostics.sh --scrub-self-test FILE      check the scrubber against the shared fixture, collect nothing
#        bash scripts/collect-diagnostics.sh --scrub-stdin [--env-file FILE]   filter stdin to stdout through the scrubber
# Prints the report and saves dcdash-diag-<yyyyMMdd-HHmmss>.txt in --out-dir (default: the current folder). Each host:port gets a DNS
# lookup and a TCP connect (3 s timeout). Sections: HOST DISKS NETWORK CLOCK TARGETS "LOCAL PORTS" "TOOLS ON PATH" SERVICES DATABASE API
# LOGS. When docker and a compose.yaml exist, SERVICES/DATABASE/LOGS ask `docker compose` (ps -a, config --services, logs, exec: nothing
# else, never inspect) and the LAST 300 LINES PER SERVICE go to a second file, dcdash-diag-<stamp>-logs.txt (header DCDASH-DIAG-LOGS v1,
# same footer rule), which is saved but never printed; the report names its path. Read-only, needs no internet and none of the
# application; POSIX tools only (awk, sed, df, date, getent), no Python, no jq. The files are UTF-8 with LF line breaks, saved for their
# owner only (umask 077). The last line of each is `END OF DIAGNOSTICS <12 hex>`: the first 12 hex characters of the SHA-256 of every
# line before it, joined by LF (no trailing LF), so a paste can be verified.
# Every output line passes through `emit`: cut at 64 KB, then scrubbed (known secrets from the project's .env, then user:password in
# URLs), then clipped. The .env is only parsed by awk, never sourced, and its values are never printed (only their count).
# Every external command runs under `timeout` (10 s, `compose logs` 30 s); after the first docker command that does not answer the rest of
# the docker calls are skipped. Without `timeout` commands run unbounded (TOOLS ON PATH says so). DCDASH_DIAG_DOCKER_SECONDS shortens the
# docker limit and exists only so the tests can prove that skip without waiting 10 s.
# Exit codes: 0 report written, 1 a file could not be saved (the report was still printed) or the self-test failed, 2 bad usage,
# 3 awk is missing (nothing is collected: the scrubber needs it).
# Tests source this file and set WORK, AWK, ENV_FILE (and ICONV_BIN, TIMEOUT_BIN) themselves, so main only runs when it is executed.
set -u

VERSION=1
CAP_BYTES=65536   # a raw line is cut here BEFORE scrubbing (far above any clip, so nothing near the cut is shown)

# The scrubber, in awk, mawk-safe: no gensub, no 4-argument split, no IGNORECASE, no length(array), no delete. Run it under LC_ALL=C: every
# length and position is then a BYTE count; "characters" are counted as bytes that are not UTF-8 continuation bytes (\200-\277).
# Modes: selftest (the fixture, from a file operand), stream (stdin to stdout), envcount (how many .env values are read).
IFS= read -r -d '' AWK_PROGRAM <<'AWK_END' || true
function cont(s, k) { return substr(s, k, 1) ~ /[\200-\277]/ }
function nchars(s,    t) { t = s; gsub(/[\200-\277]/, "", t); return length(t) }
function cut(s, max,    k) {                   # at most max bytes, never inside a UTF-8 character
  if (length(s) <= max) return s
  k = max
  while (k > 0 && cont(s, k + 1)) k--
  return substr(s, 1, k)
}
function shorten(s, max) {                     # at most max bytes in all, a cut marked with an ellipsis
  if (max <= 0 || length(s) <= max) return s
  return cut(s, max - 3) ELLIPSIS
}
function add_known(v,    p, c, i) {            # v and the part after its first ":" (each of 4+ characters) become known values
  for (p = 0; p < 2; p++) {
    c = v
    if (p == 1) { i = index(v, ":"); if (i == 0) continue; c = substr(v, i + 1) }
    c = c ""
    if (nchars(c) >= 4 && !(c in seen)) { seen[c] = 1; nk++; kn[nk] = c; kl[nk] = nchars(c) }
  }
}
function sort_known(    i, j, tv, tl) {        # longest first, equal lengths in character order (byte order = code point order)
  for (i = 2; i <= nk; i++) {
    tv = kn[i]; tl = kl[i]
    for (j = i - 1; j >= 1 && (kl[j] < tl || (kl[j] == tl && (kn[j] "") > (tv ""))); j--) { kn[j + 1] = kn[j]; kl[j + 1] = kl[j] }
    kn[j + 1] = tv; kl[j + 1] = tl
  }
}
function join(a, lo, hi,    mid) {         # a[lo..hi] joined by halving, so no byte is copied more than log2(n) times (mawk does not optimise appends)
  if (lo > hi) return ""
  if (lo == hi) return a[lo]
  mid = int((lo + hi) / 2)
  return join(a, lo, mid) join(a, mid + 1, hi)
}
function hide_known(s,    i, v, n, len, pos, chunk, p, adv, np, pc) {
  # literal and case-sensitive, one value after the other, never a pattern. index() has no start offset, so the text is searched in
  # windows of about 4 KB that overlap by n - 1 bytes: no copy of the whole remainder per match.
  for (i = 1; i <= nk; i++) {
    v = kn[i]
    if (index(s, v) == 0) continue
    n = length(v); len = length(s); pos = 1; np = 0; split("", pc)
    while (pos <= len) {
      chunk = substr(s, pos, 4096 + n)
      p = index(chunk, v)
      if (p > 0) { pc[++np] = substr(chunk, 1, p - 1) "[hidden]"; pos += p - 1 + n }
      else if (pos + length(chunk) > len) { pc[++np] = chunk; break }
      else { adv = length(chunk) - n + 1; pc[++np] = substr(chunk, 1, adv); pos += adv }
    }
    s = join(pc, 1, np)
  }
  return s
}
function hide_urls(s,    n, parts, k, p, q, run, st, m, a, last, np, pc, copied) {
  # in every run of non-space text, from the first "://" to the last "@" becomes "://[hidden]@" (only if that "@" follows the "://")
  if (index(s, "://") == 0 || index(s, "@") == 0) return s
  n = split(s, parts, WS)                      # one part per single space-like byte, so a run starts at p and the next one at p + q + 1
  np = 0; copied = 1; p = 1
  for (k = 1; k <= n; k++) {
    run = parts[k]; q = length(run)
    st = index(run, "://")
    if (st > 0 && index(run, "@") > 0) {
      m = split(run, a, "[@]")
      last = q - length(a[m])                  # position of the last "@"
      if (last >= st + 3) {
        pc[++np] = substr(s, copied, p - copied)   # the unchanged stretch before this run, in one piece
        pc[++np] = substr(run, 1, st - 1) "://[hidden]@" substr(run, last + 1)
        copied = p + q
      }
    }
    p += q + 1
  }
  pc[++np] = substr(s, copied)
  return join(pc, 1, np)
}
function scrub(s) { return hide_urls(hide_known(s)) }
function unesc(f,    out, n, i, c, d) {        # the fixture's escapes, decoded in ONE left-to-right pass
  if (f == "(empty)") return ""
  out = ""; n = length(f)
  for (i = 1; i <= n; i++) {
    c = substr(f, i, 1)
    if (c != "\\") { out = out c; continue }
    d = substr(f, ++i, 1)
    if (d == "t") out = out "\t"
    else if (d == "r") out = out "\r"
    else if (d == "\\") out = out "\\"
    else bad_escape = 1
  }
  return out
}
function esc(s,    out, n, i, c) {
  if (s == "") return "(empty)"
  out = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    out = out (c == "\\" ? "\\\\" : c == "\t" ? "\\t" : c == "\r" ? "\\r" : c)
  }
  return out
}
function unescape_dq(v,    out, n, i, c, d) {  # a double-quoted .env value: \" and \\ stand for one character
  out = ""; n = length(v)
  for (i = 1; i <= n; i++) {
    c = substr(v, i, 1); d = substr(v, i + 1, 1)
    if (c == "\\" && (d == "\"" || d == "\\")) { out = out d; i++ } else out = out c
  }
  return out
}
function load_env(path,    line, eq, key, val, q, rest, i, n, c, raw) {
  # PASSWORD/SECRET/TOKEN/KEY values of 4+ characters: strip a trailing CR, skip blank and # lines, an optional "export ", split at the
  # FIRST "=", one pair of matching quotes, an unquoted " #" tail cut off. Parsed here, never sourced; the values stay inside awk. Values
  # are taken as written: a $VAR in one is NOT expanded the way compose would (tests/fixtures/env_cases.tsv pins this reader and the ps1 twin).
  if (path == "") return
  while ((getline line < path) > 0) {
    if (++nline == 1) sub(/^\357\273\277/, "", line)
    sub(/\r$/, "", line); sub(/^[ \t]+/, "", line)
    if (line == "" || substr(line, 1, 1) == "#") continue
    sub(/^export[ \t]+/, "", line)
    eq = index(line, "=")
    if (eq < 2) continue
    key = substr(line, 1, eq - 1); val = substr(line, eq + 1); sub(/^[ \t]+/, "", val)
    if (toupper(key) !~ /(PASSWORD|SECRET|TOKEN|KEY)/) continue
    q = substr(val, 1, 1)
    if (q == "'") { rest = substr(val, 2); i = index(rest, "'"); val = i ? substr(rest, 1, i - 1) : rest }
    else if (q == "\"") {
      rest = substr(val, 2); n = length(rest); raw = ""
      for (i = 1; i <= n; i++) {
        c = substr(rest, i, 1)
        if (c == "\\" && i < n) { raw = raw c substr(rest, i + 1, 1); i++; continue }
        if (c == "\"") break
        raw = raw c
      }
      val = raw
    } else {
      if (match(val, /[ \t]#/)) val = substr(val, 1, RSTART - 1)
      sub(/[ \t]+$/, "", val)
    }
    if (nchars(val) < 4) continue
    env_count++
    add_known(val)
    if (q == "\"" && unescape_dq(val) != val) add_known(unescape_dq(val))
  }
  close(path)
}
BEGIN {
  ELLIPSIS = "\342\200\246"; WS = "[ \t\r\v\f]"; sep = lead ? "\n" : ""
  if (mode == "envcount") { load_env(ENVIRON["DCDASH_ENV_FILE"]); print env_count + 0; exit }
  if (mode == "stream") { load_env(ENVIRON["DCDASH_ENV_FILE"]); sort_known() }
}
mode == "selftest" {
  if ($0 == "" || substr($0, 1, 1) == "#") next
  total++
  cols = split($0, col, "[\t]")
  bad_escape = 0; nk = 0; split("", seen); split("", kn); split("", kl)
  if (cols != 4) { failed++; print "case line-" NR " FAIL expected 4 tab-separated columns, got " cols; next }
  if (col[2] != "-") { m = split(col[2], kv, "[|]"); for (i = 1; i <= m; i++) add_known(kv[i]) }
  sort_known()
  text = unesc(col[3]); want = unesc(col[4]); got = scrub(text)
  if (bad_escape) { failed++; print "case " col[1] " FAIL bad escape in the fixture line"; next }
  if ((got "") == (want "")) { passed++; print "case " col[1] " OK" }
  else { failed++; print "case " col[1] " FAIL expected=" esc(want) " got=" esc(got) }
}
mode == "stream" {
  s = shorten($0, cap_to)
  if (strip_cr && index(s, "\r")) gsub(/\r/, "", s)
  s = shorten(scrub(s), clip_to)
  if (style == "file") { printf "%s%s", sep, s; sep = "\n" } else print s
}
END {
  if (mode == "selftest") {
    if (total == 0) print "no cases found in the fixture"
    print "SCRUB SELF-TEST " (passed + 0) " OK " (failed + 0) " FAILED"
    exit (failed > 0 || total == 0)
  }
}
AWK_END

usage() {
  cat <<'USAGE'
Usage: collect-diagnostics.sh [host:port ...] [--project-dir DIR] [--out-dir DIR]
       collect-diagnostics.sh --scrub-self-test FILE
       collect-diagnostics.sh --scrub-stdin [--env-file FILE] [--project-dir DIR]
USAGE
}
usage_error() { echo "collect-diagnostics.sh: $1" >&2; usage >&2; exit 2; }

set_option() {
  case $1 in
    --project-dir) PROJECT_ARG=$2 ;;
    --out-dir) OUT_DIR=$2 ;;
    --scrub-self-test) SELF_TEST_FILE=$2 ;;
    --env-file) ENV_FILE_ARG=$2 ;;
  esac
}

parse_args() {
  TARGET_ARGS=(); PROJECT_ARG=""; OUT_DIR=$PWD; SELF_TEST_FILE=""; ENV_FILE_ARG=""; STDIN_MODE=0
  while [ $# -gt 0 ]; do
    case $1 in
      --project-dir|--out-dir|--scrub-self-test|--env-file)
        [ $# -ge 2 ] || usage_error "$1 needs a value"
        set_option "$1" "$2"; shift 2 ;;
      --project-dir=*|--out-dir=*|--scrub-self-test=*|--env-file=*) set_option "${1%%=*}" "${1#*=}"; shift ;;
      --scrub-stdin) STDIN_MODE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      --) shift; TARGET_ARGS+=("$@"); break ;;
      -*) usage_error "unknown option: $1" ;;
      *) TARGET_ARGS+=("$1"); shift ;;
    esac
  done
}

# ---- runtime: awk, the scratch folder, the time limit, the project folder and its .env -----------------------------------------
init_awk() {
  export LC_ALL=C   # bytes for awk, English tool messages, one date format
  AWK=$(type -P awk)
  if [ -z "$AWK" ]; then echo "awk not found: the scrubber needs it, nothing was collected" >&2; exit 3; fi
}

init_work() {
  WORK=$(mktemp -d 2>/dev/null) || {
    # no mktemp: a plain mkdir (no -p) on a name with the PID in it, refused when it exists (someone else's folder is not private)
    WORK=${TMPDIR:-/tmp}/dcdash-diag.$$
    (umask 077; mkdir "$WORK" 2> /dev/null) || { echo "collect-diagnostics.sh: cannot create the scratch folder $WORK (it exists already, or its parent is not writable)" >&2; exit 1; }
  }
  TIMEOUT_BIN=$(type -P timeout)
  ICONV_BIN=$(type -P iconv)
  DOCKER_BIN=$(type -P docker)
  DOCKER_SECS=${DCDASH_DIAG_DOCKER_SECONDS:-10}
  case $DOCKER_SECS in ''|*[!0-9]*|0|0[0-9]*) DOCKER_SECS=10 ;; esac
  : > "$WORK/main.txt"
}

resolve_project() {
  local here dir
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)
  PROJECT_DIR=""; PROJECT_NOTE=""; HAS_COMPOSE=0
  if [ -n "$PROJECT_ARG" ]; then
    if dir=$(cd "$PROJECT_ARG" 2>/dev/null && pwd); then PROJECT_DIR=$dir; else PROJECT_NOTE="--project-dir is not a folder"; fi
  elif [ -f ./compose.yaml ]; then PROJECT_DIR=$PWD
  elif [ -n "$here" ] && [ -f "$here/compose.yaml" ]; then PROJECT_DIR=$here
  fi
  [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/compose.yaml" ] && HAS_COMPOSE=1
  ENV_FILE=$ENV_FILE_ARG
  [ -z "$ENV_FILE" ] && [ -n "$PROJECT_DIR" ] && ENV_FILE=$PROJECT_DIR/.env
  KNOWN_COUNT=0
  if [ -n "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then
    KNOWN_COUNT=$(DCDASH_ENV_FILE=$ENV_FILE "$AWK" -v mode=envcount "$AWK_PROGRAM" 2>/dev/null)
    KNOWN_COUNT=${KNOWN_COUNT:-0}
  fi
}

# ---- output: every line goes through emit_lines -------------------------------------------------------------------------------
# awk_scrub <style: file|plain> <cap bytes> <clip bytes> <strip CR: 0|1> <lead LF: 0|1>; stdin to stdout. 0 means no cap/clip.
awk_scrub() {
  DCDASH_ENV_FILE=${ENV_FILE:-} "$AWK" -v mode=stream -v style="$1" -v cap_to="$2" -v clip_to="$3" -v strip_cr="$4" -v lead="$5" "$AWK_PROGRAM"
}

# emit_lines [CLIP [SINK]]: lines on stdin -> cut at 64 KB, scrubbed, clipped to CLIP bytes (0 = no clip), appended to the sink file
# (main, or logs for B1b's second file). Lines are joined by LF with no trailing LF, so the file is exactly what the footer hashes.
# Invalid UTF-8 is dropped with iconv when iconv exists, BEFORE the scrubber: a secret with a stray byte inside would escape the scrubber, and
# dropping the byte afterwards would put the secret back together.
emit_lines() {
  local file=$WORK/${2:-main}.txt lead=0
  [ -s "$file" ] && lead=1
  if [ -n "${ICONV_BIN:-}" ]; then
    "$ICONV_BIN" -c -f UTF-8 -t UTF-8 2>/dev/null | awk_scrub file "$CAP_BYTES" "${1:-0}" 1 "$lead" >> "$file"
  else
    awk_scrub file "$CAP_BYTES" "${1:-0}" 1 "$lead" >> "$file"
  fi
  return 0   # older iconv versions exit 1 when -c drops a byte: that is not a failure of the section that wrote the line
}
emit() { printf '%s\n' "$1" | emit_lines "${2:-0}" "${3:-main}"; }   # emit TEXT [CLIP [SINK]]; a TEXT with newlines is several lines

run_section() {   # run_section NAME FUNCTION: a section that dies is reported, the others still run
  local rc
  emit ""; emit "== $1 =="
  ( "$2" ) 2> "$WORK/section.err"
  rc=$?
  [ $rc -eq 0 ] || emit "section failed: exit code $rc: $(head -n 3 "$WORK/section.err" | tr '\n' ' ')"
}

# ---- helpers ------------------------------------------------------------------------------------------------------------------
run_limited() {   # run_limited SECONDS COMMAND...: under timeout when it exists (exit code 124 = timed out), else without a limit
  local secs=$1; shift
  if [ -n "${TIMEOUT_BIN:-}" ]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi
}

now_ms() {   # sets NOW_MS
  local t
  if [ -n "${EPOCHREALTIME:-}" ]; then t=${EPOCHREALTIME//[.,]/}; NOW_MS=$(( t / 1000 )); return; fi
  t=$(date +%s%N 2>/dev/null)
  case $t in *[!0-9]*|"") NOW_MS=$(( $(date +%s) * 1000 )) ;; *) NOW_MS=$(( t / 1000000 )) ;; esac
}

sha256_12() {   # first 12 hex of the SHA-256 of a file, nothing when no tool exists
  local out
  if type -P sha256sum > /dev/null; then out=$(sha256sum < "$1")
  elif type -P shasum > /dev/null; then out=$(shasum -a 256 < "$1")
  elif type -P openssl > /dev/null; then out=$(openssl dgst -sha256 < "$1"); out=${out##*= }
  else return 1
  fi
  [[ ${out:0:12} =~ ^[0-9a-f]{12}$ ]] && printf '%s' "${out:0:12}"
}

docker_run() {   # docker_run SECONDS ARGS...: docker in the project folder; output in $WORK/docker.out and docker.err, exit code in DOCKER_RC
  # Fails (so the caller skips its docker part) once docker is marked down; the first command that times out or cannot be run marks it
  # down in a FILE (sections run in subshells) and says so once. stdin is /dev/null: timeout runs the command in a background process
  # group, and a docker that touched the terminal would stop there and look like a hang.
  local secs=$1; shift
  [ -e "$WORK/docker.down" ] && return 1
  (cd "$PROJECT_DIR" 2> /dev/null && run_limited "$secs" "$DOCKER_BIN" "$@") < /dev/null > "$WORK/docker.out" 2> "$WORK/docker.err"
  DOCKER_RC=$?
  if [ "$DOCKER_RC" -eq 124 ] && [ -n "${TIMEOUT_BIN:-}" ]; then
    : > "$WORK/docker.down"; emit "docker did not answer within ${secs} s; container sections skipped"; return 1
  elif [ "$DOCKER_RC" -eq 126 ] || [ "$DOCKER_RC" -eq 127 ]; then
    : > "$WORK/docker.down"; emit "docker could not be run (exit code $DOCKER_RC); container sections skipped"; return 1
  fi
  return 0
}

docker_text() { { cat "$WORK/docker.out"; cat "$WORK/docker.err"; } | "$AWK" 'NF { print "  " $0 }'; }   # what the last docker call printed, indented, blank lines dropped

# A minimal HTTP/1.0 client for machines with neither curl nor wget. The URL parts arrive as arguments, never inside the script text; no
# line reads for more than 3 s and at most 64 KB are kept. Exit 7 = connect failed (bash prints why), 124 = the answer stopped coming.
HTTP_TCP_CLIENT='exec 3<>"/dev/tcp/$1/$2" || exit 7
printf "GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: dcdash-diag\r\nAccept: */*\r\nConnection: close\r\n\r\n" "$3" "$4" >&3
n=0
while [ $n -lt 16 ]; do
  IFS= read -r -t 3 -d "" -n 4096 chunk <&3; rc=$?
  printf "%s" "$chunk"
  [ $rc -eq 0 ] || break
  n=$((n + 1))
done
[ $rc -gt 128 ] && exit 124
exit 0'

http_get() {   # http_get URL -> HTTP_CODE ("" = no answer), HTTP_ERR, HTTP_MS, HTTP_VIA; the body (at most 64 KB) lands in $WORK/api.body
  local url=$1 t0 rc out rest hostport host port path
  HTTP_CODE=""; HTTP_ERR=""; HTTP_VIA=""
  : > "$WORK/api.body"; : > "$WORK/api.err"
  now_ms; t0=$NOW_MS
  if type -P curl > /dev/null; then
    HTTP_VIA=curl
    out=$(run_limited 4 curl -sS --noproxy '*' -m 3 -o "$WORK/api.body" -w '%{http_code}' "$url" 2> "$WORK/api.err" < /dev/null); rc=$?
    if [ $rc -eq 0 ]; then HTTP_CODE=$out
    elif [ $rc -eq 124 ] && [ -n "${TIMEOUT_BIN:-}" ]; then HTTP_ERR="no answer within 3000 ms"
    else HTTP_ERR=$(tail -n 1 "$WORK/api.err" | sed 's/^curl: ([0-9]*) //')
    fi
  elif type -P wget > /dev/null; then
    HTTP_VIA=wget
    run_limited 4 wget -nv -S --content-on-error --no-proxy -T 3 -t 1 --max-redirect=0 -O "$WORK/api.body" "$url" 2> "$WORK/api.err" > /dev/null < /dev/null
    rc=$?
    HTTP_CODE=$(sed -n 's/^ *HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*$/\1/p' "$WORK/api.err" | tail -n 1)
    if [ -n "$HTTP_CODE" ]; then :
    elif [ $rc -eq 124 ] && [ -n "${TIMEOUT_BIN:-}" ]; then HTTP_ERR="no answer within 3000 ms"
    elif "$AWK" '/nrecognized option|nvalid option|^Usage/ { f = 1 } END { exit !f }' "$WORK/api.err"; then HTTP_VIA=""   # a wget that lacks these options (busybox): use bash instead
    else HTTP_ERR=$(tail -n 1 "$WORK/api.err")
    fi
  fi
  if [ -z "$HTTP_VIA" ]; then
    HTTP_VIA="bash /dev/tcp"
    rest=${url#http://}
    if [ "$rest" = "$url" ]; then HTTP_ERR="only http:// addresses can be read without curl or wget"
    else
      hostport=${rest%%/*}; path=/; [[ $rest == */* ]] && path=/${rest#*/}
      host=${hostport%:*}; port=80; [[ $hostport == *:* ]] && port=${hostport##*:}
      run_limited 4 "$BASH" -c "$HTTP_TCP_CLIENT" _ "$host" "$port" "$path" "$hostport" < /dev/null > "$WORK/api.raw" 2> "$WORK/api.err"; rc=$?
      HTTP_CODE=$("$AWK" 'NR == 1 && /^HTTP\/[0-9.]+ [0-9][0-9][0-9]/ { print substr($2, 1, 3) }' "$WORK/api.raw")
      "$AWK" '{ sub(/\r$/, "") } inbody { print; next } $0 == "" { inbody = 1 }' "$WORK/api.raw" > "$WORK/api.body"
      if [ -n "$HTTP_CODE" ]; then :
      elif [ $rc -eq 124 ]; then HTTP_ERR="no answer within 3000 ms"
      elif [ $rc -eq 7 ]; then out=$(tail -n 1 "$WORK/api.err"); HTTP_ERR=${out##*: }
      else HTTP_ERR="the answer is not HTTP"
      fi
    fi
  fi
  [ -n "$HTTP_CODE" ] || [ -n "$HTTP_ERR" ] || HTTP_ERR="no answer"
  now_ms; HTTP_MS=$(( NOW_MS - t0 ))
}

api_probe() {   # api_probe URL [NOTE]: three lines, the body collapsed with ASCII whitespace only and shown after scrubbing (clip = "  body: " + 300 + the ellipsis)
  emit "GET ${1}${2:+ ($2)}"
  http_get "$1"
  if [ -n "$HTTP_CODE" ]; then
    emit "  HTTP $HTTP_CODE in $HTTP_MS ms (via $HTTP_VIA)"
    { printf '  body: '; head -c 65536 "$WORK/api.body" | tr -s '[:space:]' ' '; echo; } | emit_lines 311
  else
    emit "  FAILED in $HTTP_MS ms (via $HTTP_VIA): $HTTP_ERR" 300
  fi
}

# ---- sections ------------------------------------------------------------------------------------------------------------------
report_header() {
  local now z zone
  now=$(date '+%Y-%m-%d %H:%M:%S'); z=$(date +%z); zone=$(readlink /etc/localtime 2>/dev/null)
  zone=${zone#*zoneinfo/}; [ -n "$zone" ] || zone=$(date +%Z)
  emit "DCDASH-DIAG v$VERSION | collect-diagnostics.sh | bash ${BASH_VERSION%%(*}"
  emit "local time: $now ${z:0:3}:${z:3:2} ($zone)"
  emit "utc time:   $(date -u '+%Y-%m-%d %H:%M:%S')"
}

section_host() {
  local os up booted
  os=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d '"')
  emit "os: ${os:-unknown} ($(uname -srm 2>/dev/null))"
  emit "computer: $(hostname 2>/dev/null || uname -n)  user: $(id -un 2>/dev/null)  cpus: $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
  if read -r up _ 2> /dev/null < /proc/uptime; then
    up=${up%%.*}
    booted=$(date -d "@$(( $(date +%s) - up ))" '+%Y-%m-%d %H:%M' 2>/dev/null)
    emit "uptime: $(( up / 86400 ))d $(( up % 86400 / 3600 ))h $(( up % 3600 / 60 ))m (booted ${booted:-unknown})"
  else
    emit "uptime: unknown (/proc/uptime is not readable)"
  fi
  "$AWK" '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } /^MemFree:/ { f = $2 }
    END { if (!a) a = f; if (t) printf "memory: %d MB available of %d MB\n", a / 1024, t / 1024; else print "memory: unknown" }' /proc/meminfo 2> /dev/null | emit_lines
  if [ -n "$PROJECT_DIR" ]; then
    emit "project folder: $PROJECT_DIR ($([ "$HAS_COMPOSE" = 1 ] && echo "compose.yaml found" || echo "no compose.yaml"))"
  else
    emit "project folder: none${PROJECT_NOTE:+ ($PROJECT_NOTE)} (no compose.yaml in the current folder or the script's parent folder; use --project-dir)"
  fi
  emit "scrubber: $KNOWN_COUNT secret-like value(s) read from the .env file (the values are never printed)"
}

section_disks() {
  run_limited 10 df -Pk 2>&1 | "$AWK" '
    NR == 1 { next }
    $1 ~ /^(tmpfs|devtmpfs|udev|overlay|shm|none|squashfs|snapfuse|efivarfs|proc|sysfs|cgroup.*|\/dev\/loop.*)$/ || $2 + 0 <= 0 { next }
    ++seen > 12 { more++; next }
    { m = $6; for (i = 7; i <= NF; i++) m = m " " $i
      printf "%s %.1f GB free of %.1f GB (%s, %s used)\n", m, $4 / 1048576, $2 / 1048576, $1, $5 }
    END { if (!seen) print "no local disks listed (df gave nothing usable)"; if (more) print "... and " more " more"}' | emit_lines
}

section_network() {
  local ip
  ip=$(type -P ip)
  if [ -z "$ip" ]; then
    emit "ip command not found; addresses: $(hostname -I 2>/dev/null || echo unknown)"
  else
    run_limited 10 "$ip" -o -4 addr show > "$WORK/ip-addr.txt" 2>&1
    run_limited 10 "$ip" -4 route show default > "$WORK/ip-route.txt" 2>&1
    run_limited 10 "$ip" -o link show > "$WORK/ip-link.txt" 2>&1
    "$AWK" '
      FILENAME == ARGV[1] && $3 == "inet" && $2 != "lo" { if (!($2 in a)) names[++n] = $2; a[$2] = a[$2] (a[$2] == "" ? "" : ", ") $4 }
      FILENAME == ARGV[2] && $1 == "default" { d = ""; v = ""; for (i = 1; i < NF; i++) { if ($i == "dev") d = $(i + 1); if ($i == "via") v = $(i + 1) }
        gw[d] = gw[d] (gw[d] == "" ? "" : ", ") v }
      FILENAME == ARGV[3] && / state DOWN / { x = $2; sub(/[@:].*$/, "", x); if (x != "lo") down = down (down == "" ? "" : ", ") x }
      END { for (i = 1; i <= n; i++) printf "adapter %s: ipv4 %s; gateway %s\n", names[i], a[names[i]], (gw[names[i]] == "" ? "-" : gw[names[i]])
            if (!n) print "no adapter has an IPv4 address (or the ip command failed)"
            print "adapters not up: " (down == "" ? "none" : down) }' "$WORK/ip-addr.txt" "$WORK/ip-route.txt" "$WORK/ip-link.txt" | emit_lines
  fi
  emit "dns servers (/etc/resolv.conf): $("$AWK" '$1 == "nameserver" { s = s (s == "" ? "" : ", ") $2 } END { print (s == "" ? "-" : s) }' /etc/resolv.conf 2>/dev/null)"
}

section_clock() {
  local tool rc
  emit "system clock (utc): $(date -u '+%Y-%m-%d %H:%M:%S')"
  for tool in "timedatectl status" "chronyc tracking"; do
    type -P "${tool%% *}" > /dev/null || continue
    # shellcheck disable=SC2086
    run_limited 10 $tool 2>&1 | head -n 14 | sed 's/^[[:space:]]*/  /' > "$WORK/clock.txt"
    emit "$tool (exit code ${PIPESTATUS[0]}):"
    emit_lines < "$WORK/clock.txt"
    return
  done
  emit "no time sync tool found (timedatectl, chronyc)"
}

parse_target() {   # parse_target host:port | [v6]:port -> T_HOST T_PORT, or fails
  local t=$1
  if [[ $t == \[*\]:* ]]; then T_HOST=${t#\[}; T_HOST=${T_HOST%%\]:*}; T_PORT=${t##*\]:}
  else
    [[ $t == *:* ]] || return 1
    T_HOST=${t%:*}; T_PORT=${t##*:}
    [[ $T_HOST != *:* && $T_HOST != *\[* && $T_HOST != *\]* ]] || return 1
  fi
  [[ -n $T_HOST && $T_PORT =~ ^[0-9]{1,5}$ ]] || return 1
  (( 10#$T_PORT >= 1 && 10#$T_PORT <= 65535 ))
}

tcp_connect() {   # tcp_connect ADDRESS PORT -> TCP_MS, TCP_ERR ("" = connected). The target is passed as arguments, never in the script text.
  local t0 out rc
  now_ms; t0=$NOW_MS
  out=$(run_limited 3 "$BASH" -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>&1); rc=$?
  now_ms; TCP_MS=$(( NOW_MS - t0 ))
  if [ $rc -eq 0 ]; then TCP_ERR=""
  elif [ $rc -eq 124 ] && [ -n "${TIMEOUT_BIN:-}" ]; then TCP_ERR="timeout (no answer within 3000 ms)"
  else out=${out##*$'\n'}; TCP_ERR=${out##*: }; [ -n "$TCP_ERR" ] || TCP_ERR="exit code $rc"
  fi
}

section_targets() {
  local t ms a ep rc out
  local -a items addrs
  set -f; IFS=$',; \t\n'
  items=(${TARGET_ARGS[*]:-})
  IFS=$' \t\n'; set +f
  [ ${#items[@]} -gt 0 ] || emit "none given (pass host:port pairs, for example 10.0.0.5:4840)"
  for t in ${items[@]+"${items[@]}"}; do
    addrs=()
    emit "target $t"
    parse_target "$t" || { emit "  invalid (expected host:port)"; continue; }
    if [[ $T_HOST =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || $t == \[* ]]; then
      addrs=("$T_HOST"); emit "  dns OK in 0 ms: $T_HOST (an address: no lookup)"
    elif ! type -P getent > /dev/null; then
      addrs=("$T_HOST"); emit "  dns skipped (getent not found); the connect resolves the name itself"
    else
      now_ms; ms=$NOW_MS
      out=$(run_limited 5 getent hosts "$T_HOST" 2>&1); rc=$?
      now_ms; ms=$(( NOW_MS - ms ))
      if [ $rc -eq 124 ] && [ -n "${TIMEOUT_BIN:-}" ]; then emit "  dns FAILED in ${ms} ms: no answer within 5000 ms"
      elif [ $rc -ne 0 ] || [ -z "$out" ]; then emit "  dns FAILED in ${ms} ms: no such host (getent hosts exit code $rc)"
      else
        addrs=($(printf '%s\n' "$out" | "$AWK" '!($1 in s) && n < 3 { s[$1] = 1; n++; print $1 }'))
        emit "  dns OK in ${ms} ms: $(IFS=,; echo "${addrs[*]}" | sed 's/,/, /g')"
      fi
    fi
    if [ -z "${addrs[*]:-}" ]; then emit "  tcp skipped (no address)"; continue; fi
    for a in "${addrs[@]}"; do
      ep=$a; [[ $a == *:* ]] && ep="[$a]"
      tcp_connect "$a" "$((10#$T_PORT))"
      if [ -z "$TCP_ERR" ]; then emit "  tcp $ep:$((10#$T_PORT)) OK in ${TCP_MS} ms"
      else emit "  tcp $ep:$((10#$T_PORT)) FAILED in ${TCP_MS} ms: $TCP_ERR"
      fi
    done
  done
}

section_local_ports() {
  local tool listing="" port on found=0
  for tool in "ss -ltn" "netstat -ltn"; do
    type -P "${tool%% *}" > /dev/null || continue
    # shellcheck disable=SC2086
    if listing=$(run_limited 10 $tool 2>/dev/null); then found=1; break; fi
  done
  if [ $found = 0 ]; then emit "ss and netstat not found or failed; listening ports unknown"; return; fi
  for port in 80 443 8000; do
    on=$(printf '%s\n' "$listing" | "$AWK" -v want="$port" '($1 == "LISTEN" || $1 ~ /^tcp/) { a = $4; p = a; sub(/^.*:/, "", p); sub(/:[^:]*$/, "", a)
      if (p == want && !(a in s)) { s[a] = 1; out = out (out == "" ? "" : ", ") a } } END { print out }')
    emit "port ${port}: $([ -n "$on" ] && echo "something is listening on $on" || echo "nothing is listening")"
  done
}

section_tools() {
  local name path
  for name in docker python3 python curl wget systemctl ss netstat ip getent timeout iconv sha256sum; do
    path=$(type -P "$name")
    emit "${name}: ${path:-not found}"
  done
  [ -n "${TIMEOUT_BIN:-}" ] || emit "note: timeout is missing, so no command here has a time limit"
  emit "awk: $("$AWK" -W version 2>&1 | head -n 1)"
}

section_services() {
  local out rc rows where
  if [ -z "$DOCKER_BIN" ]; then emit "container sections skipped: docker not found"
  elif [ "$HAS_COMPOSE" != 1 ]; then
    where=${PROJECT_DIR:-"the current folder or the parent folder of this script; use --project-dir"}
    emit "container sections skipped: no compose.yaml in $where"
  elif docker_run "$DOCKER_SECS" compose ps -a; then
    emit "docker compose ps -a in $PROJECT_DIR (exit code $DOCKER_RC):"
    docker_text | emit_lines 302
    # a header and at least one row mean there is a compose project with containers to ask more about
    if [ "$DOCKER_RC" -eq 0 ] && "$AWK" 'NF { n++ } END { exit !(n > 1) }' "$WORK/docker.out"; then : > "$WORK/containers"; fi
  fi
  [ -e "$WORK/containers" ] && return
  if ! type -P systemctl > /dev/null; then emit "systemd units dcdash*, postgres*, docker: none found (systemctl not found)"; return; fi
  out=$(run_limited 10 systemctl list-units --no-legend --all --plain --no-pager < /dev/null 2>&1); rc=$?
  if [ $rc -eq 124 ] && [ -n "${TIMEOUT_BIN:-}" ]; then emit "systemctl list-units did not answer within 10 s"; return; fi
  if [ $rc -ne 0 ]; then emit "systemctl list-units failed (exit code $rc): $(printf '%s\n' "$out" | head -n 1)" 300; return; fi
  rows=$(printf '%s\n' "$out" | "$AWK" '$1 ~ /^(dcdash|postgres)/ || $1 ~ /^docker\.(service|socket)$/ { printf "  %s  %s %s %s\n", $1, $2, $3, $4 }')
  if [ -z "$rows" ]; then emit "systemd units dcdash*, postgres*, docker: none found"
  else emit "systemd units dcdash*, postgres*, docker:"; printf '%s\n' "$rows" | emit_lines 300
  fi
}

section_database() {
  if [ -e "$WORK/containers" ] && docker_run "$DOCKER_SECS" compose exec -T db pg_isready -U dcdash -d dcdash; then
    emit "docker compose exec -T db pg_isready -U dcdash -d dcdash (exit code $DOCKER_RC):"
    docker_text | emit_lines 302
    return
  fi
  tcp_connect 127.0.0.1 5432
  if [ -z "$TCP_ERR" ]; then emit "tcp 127.0.0.1:5432 OK in ${TCP_MS} ms"; else emit "tcp 127.0.0.1:5432 FAILED in ${TCP_MS} ms: $TCP_ERR"; fi
}

section_api() {
  api_probe http://127.0.0.1/api/health
  api_probe http://127.0.0.1:8000/api/health "native install only"
}

logs_header() {   # the first lines of the second file
  local z
  z=$(date +%z)
  emit "DCDASH-DIAG-LOGS v$VERSION | collect-diagnostics.sh | bash ${BASH_VERSION%%(*}" 0 logs
  emit "local time: $(date '+%Y-%m-%d %H:%M:%S') ${z:0:3}:${z:3:2}" 0 logs
  emit "scrubbing: URL credentials, and $KNOWN_COUNT secret value(s) read from the .env file; each line is cut at 1000 bytes" 0 logs
}

section_logs() {
  local svc list n shown
  if [ -z "$DOCKER_BIN" ] || [ "$HAS_COMPOSE" != 1 ]; then emit "container sections skipped (see SERVICES); no logs file"; return; fi
  if ! docker_run "$DOCKER_SECS" compose config --services; then emit "no logs read, no logs file"; return; fi
  if [ "$DOCKER_RC" -ne 0 ]; then
    emit "docker compose config --services failed (exit code $DOCKER_RC): $(head -n 1 "$WORK/docker.err")" 300
    emit "no logs read, no logs file"; return
  fi
  list=$("$AWK" '{ sub(/^[ \t]+/, ""); sub(/[ \t\r]+$/, "") } $0 ~ /^[A-Za-z0-9][A-Za-z0-9_.-]*$/ && ++n <= 30 { print }' "$WORK/docker.out")
  emit "services: $(printf '%s\n' "$list" | "$AWK" 'NF { s = s (s == "" ? "" : ", ") $0 } END { print (s == "" ? "none" : s) }')"
  for svc in $list; do
    docker_run $(( 10#$DOCKER_SECS * 3 )) compose logs --no-color --tail 300 "$svc" || break
    "$AWK" 'NF' "$WORK/docker.out" | tail -n 300 > "$WORK/svc.tail"
    n=$("$AWK" 'END { print NR }' "$WORK/svc.tail")
    if [ "$DOCKER_RC" -ne 0 ] && [ "$n" -eq 0 ]; then
      emit "-- ${svc}: docker compose logs failed (exit code $DOCKER_RC): $(head -n 1 "$WORK/docker.err")" 300
      continue
    fi
    shown=$(( n < 30 ? n : 30 ))
    emit "-- $svc (last $shown of $n lines read)"
    tail -n 30 "$WORK/svc.tail" | sed 's/^/  /' | emit_lines 242
    [ -s "$WORK/logs.txt" ] || logs_header
    emit "== $svc ==" 0 logs
    emit_lines 1000 logs < "$WORK/svc.tail"
  done
  if [ -s "$WORK/logs.txt" ]; then emit "logs file (the last 300 lines per service, saved next to this report): $LOGS_FILE"
  else emit "no logs read, no logs file"
  fi
}

seal() {   # seal NAME: $WORK/NAME.txt plus the footer line -> $WORK/NAME.final
  local sum footer
  sum=$(sha256_12 "$WORK/$1.txt")
  if [ -n "$sum" ]; then footer="END OF DIAGNOSTICS $sum"
  else footer="END OF DIAGNOSTICS unchecked (no sha256sum, shasum or openssl found)"; fi
  { cat "$WORK/$1.txt"; printf '\n%s\n' "$footer"; } > "$WORK/$1.final"
}

finish_report() {
  local rc=0
  seal main
  cat "$WORK/main.final"
  if [ -z "$OUT_ABS" ]; then echo "could not save the report in $OUT_DIR" >&2; return 1; fi
  if [ -s "$WORK/logs.txt" ]; then
    seal logs
    if cp "$WORK/logs.final" "$LOGS_FILE" 2> /dev/null; then echo "saved: $LOGS_FILE"; else echo "could not save the logs file $LOGS_FILE" >&2; rc=1; fi
  fi
  if cp "$WORK/main.final" "$OUT_ABS/dcdash-diag-$STAMP.txt" 2> /dev/null; then echo "saved: $OUT_ABS/dcdash-diag-$STAMP.txt"
  else echo "could not save the report in $OUT_DIR" >&2; rc=1
  fi
  return $rc
}

collect() {
  umask 077   # the report and the logs file hold scrubbed log text: saved for their owner only
  init_work
  trap 'rm -rf "$WORK"' EXIT
  trap 'exit 130' INT TERM HUP
  STAMP=$(date +%Y%m%d-%H%M%S)
  OUT_ABS=$(mkdir -p "$OUT_DIR" 2> /dev/null && cd "$OUT_DIR" 2> /dev/null && pwd)
  LOGS_FILE=${OUT_ABS:-$OUT_DIR}/dcdash-diag-$STAMP-logs.txt
  report_header
  run_section "HOST" section_host
  run_section "DISKS" section_disks
  run_section "NETWORK" section_network
  run_section "CLOCK" section_clock
  run_section "TARGETS (DNS lookup, then TCP connect with a 3 s timeout)" section_targets
  run_section "LOCAL PORTS" section_local_ports
  run_section "TOOLS ON PATH" section_tools
  # State shared between sections lives in files under $WORK (sections run in subshells): docker.down, containers, logs.txt.
  run_section "SERVICES" section_services
  run_section "DATABASE" section_database
  run_section "API" section_api
  run_section "LOGS" section_logs
  finish_report
}

main() {
  parse_args "$@"
  init_awk
  if [ -n "$SELF_TEST_FILE" ]; then
    [ -r "$SELF_TEST_FILE" ] || { echo "cannot read the fixture: $SELF_TEST_FILE" >&2; exit 2; }
    "$AWK" -v mode=selftest "$AWK_PROGRAM" "$SELF_TEST_FILE"
    exit $?
  fi
  resolve_project
  if [ "$STDIN_MODE" = 1 ]; then
    awk_scrub plain 0 0 0 0
    exit $?
  fi
  collect
  exit $?
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
