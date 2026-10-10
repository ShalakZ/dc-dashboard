#!/usr/bin/env bash
# Sourced (never executed) by the scripts that build, break and delete a throwaway stack (check_tls.sh, backup_smoke.sh):
#   . scripts/lib/scratch.sh; scratch_init <default project name>
# The project is OPS_COMPOSE_PROJECT (else the default) and must start with dcdash_e2e, like scripts/e2e.sh. The stack then shares nothing
# with the normal project `dcdash`: own volume (Compose names it after the project), own image tags, own certs folder, ports on 127.0.0.1,
# and a database password and secret key made up for this run (the environment wins over the secrets in .env).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

resolved_project() { docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1; }
compose() { docker compose -p "$SCRATCH_PROJECT" "$@"; }

# $1 = variable name, $2 = default. The stack is published on 127.0.0.1 and never on the normal stack's 80/443, so only 1024 to 65535 is
# accepted. Set-but-empty stays empty and is refused, like the project name.
scratch_port() {
  local port="${!1-$2}"
  if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1024 || 10#$port > 65535 )); then
    echo "Refusing $1='$port'. A throwaway stack is published on 127.0.0.1 on a port from 1024 to 65535 (never the normal stack's 80" >&2
    echo "and 443); leave the variable unset for the default ($2)." >&2
    exit 1
  fi
  export "$1=$port"
}

scratch_init() {
  SCRATCH_PROJECT="${OPS_COMPOSE_PROJECT-$1}"
  if [[ ! "$SCRATCH_PROJECT" =~ ^dcdash_e2e[a-z0-9_-]*$ ]]; then
    echo "Refusing to run in the Compose project '$SCRATCH_PROJECT'. This script builds, stops and deletes its stack, so it only runs" >&2
    echo "in a project whose name starts with dcdash_e2e. The normal project dcdash and its volume dcdash_dbdata are never touched." >&2
    exit 1
  fi
  scratch_port SCRATCH_HTTP_PORT 18080; scratch_port SCRATCH_HTTPS_PORT 18443
  unset COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES COMPOSE_ENV_FILES
  # absolute, and removed by this trap on any early exit or signal until scratch_cleanup takes over below
  local work
  work="$(mktemp -d)" || { echo "mktemp failed; refusing." >&2; exit 1; }
  SCRATCH_WORK="$(cd "$work" && pwd)" || { rm -rf "$work"; echo "cannot enter $work; refusing." >&2; exit 1; }
  trap 'rm -rf "$SCRATCH_WORK"' EXIT
  export TMPDIR="$SCRATCH_WORK"   # restore.sh keeps its log under TMPDIR: inside this folder, it goes away with it
  SCRATCH_CERTS_DIR="$SCRATCH_WORK/certs"; mkdir -m 755 "$SCRATCH_CERTS_DIR"
  chmod 755 "$SCRATCH_WORK"   # the web container (uid 10002) must be able to enter the folder it mounts
  export SCRATCH_PROJECT SCRATCH_WORK SCRATCH_CERTS_DIR COMPOSE_PROJECT_NAME="$SCRATCH_PROJECT"
  export COMPOSE_FILE="$REPO/compose.yaml:$REPO/scripts/scratch.override.yaml"
  # assigned first, exported after: `export X="$(failing command)"` hides the failure and would start the stack with an empty secret
  local pw key
  pw="$(openssl rand -hex 12)" || { echo "openssl failed; refusing." >&2; exit 1; }
  key="$(openssl rand -base64 32 | tr '+/' '-_')" && [[ -n "$key" ]] || { echo "openssl failed; refusing." >&2; exit 1; }
  export DCDASH_DB_PASSWORD="scratch-$pw" DCDASH_SECRET_KEY="$key"
  if [[ "$(resolved_project)" != "$SCRATCH_PROJECT" ]]; then
    echo "Compose does not resolve to $SCRATCH_PROJECT (got '$(resolved_project)'); refusing." >&2
    exit 1
  fi
  trap scratch_cleanup EXIT
  compose down -v --remove-orphans >/dev/null 2>&1 || true   # a fresh stack; -p names the scratch project, so only its volume can go
}

scratch_cleanup() {
  local rc=$?
  trap - EXIT
  docker compose -p "$SCRATCH_PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_WORK"
  exit "$rc"
}

# Run one of the repository's own scripts (backup.sh, restore.sh) against the scratch project. Those call a plain `docker compose`, which
# follows COMPOSE_PROJECT_NAME and COMPOSE_FILE from this environment: refuse unless Compose really resolves to the scratch project.
# A refusal EXITS the whole script (exit 1): a `return 1` would look like the expected failure in `if scratch_script restore.sh ...; then fail; fi`
# and the version-mismatch and corrupt-dump checks would "pass" without testing anything.
# The second check is belt and braces: a plain `docker compose ps` only lists the project Compose resolved to (checked on the line
# above), so it can only fire if a container of that project does not carry the project's name.
scratch_script() {
  [[ "$(resolved_project)" == "$SCRATCH_PROJECT" ]] || { echo "scratch_script: Compose does not resolve to $SCRATCH_PROJECT, refusing" >&2; exit 1; }
  [[ -z "$(docker compose ps --format '{{.Name}}' | grep -v "^${SCRATCH_PROJECT}-" || true)" ]] \
    || { echo "scratch_script: a container outside the scratch project is in scope, refusing" >&2; exit 1; }
  bash "$@"
}
