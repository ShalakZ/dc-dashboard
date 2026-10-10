#!/usr/bin/env bash
# Sourced (never executed) by the scripts that build, break and delete a throwaway stack (check_tls.sh, backup_smoke.sh):
#   . scripts/lib/scratch.sh; scratch_init <default project name>
# The project is OPS_COMPOSE_PROJECT (else the default) and must start with dcdash_e2e, like scripts/e2e.sh. The stack then shares nothing
# with the normal project `dcdash`: own volume (Compose names it after the project), own image tags, own certs folder, ports on 127.0.0.1,
# and a database password and secret key made up for this run (the real .env is never read: the environment wins over .env).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

resolved_project() { docker compose config --no-interpolate 2>/dev/null | sed -n 's/^name: *//p' | head -n 1; }
compose() { docker compose -p "$SCRATCH_PROJECT" "$@"; }

scratch_init() {
  SCRATCH_PROJECT="${OPS_COMPOSE_PROJECT-$1}"
  if [[ ! "$SCRATCH_PROJECT" =~ ^dcdash_e2e[a-z0-9_-]*$ ]]; then
    echo "Refusing to run in the Compose project '$SCRATCH_PROJECT'. This script builds, stops and deletes its stack, so it only runs" >&2
    echo "in a project whose name starts with dcdash_e2e. The normal project dcdash and its volume dcdash_dbdata are never touched." >&2
    exit 1
  fi
  unset COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES COMPOSE_ENV_FILES
  SCRATCH_WORK="$(mktemp -d)"; SCRATCH_CERTS_DIR="$SCRATCH_WORK/certs"; mkdir -m 755 "$SCRATCH_CERTS_DIR"
  chmod 755 "$SCRATCH_WORK"   # the web container (uid 10002) must be able to enter the folder it mounts
  export SCRATCH_PROJECT SCRATCH_WORK SCRATCH_CERTS_DIR COMPOSE_PROJECT_NAME="$SCRATCH_PROJECT"
  export SCRATCH_HTTP_PORT="${SCRATCH_HTTP_PORT:-18080}" SCRATCH_HTTPS_PORT="${SCRATCH_HTTPS_PORT:-18443}"
  export COMPOSE_FILE="$REPO/compose.yaml:$REPO/scripts/scratch.override.yaml"
  # assigned first, exported after: `export X="$(failing command)"` hides the failure and would start the stack with an empty secret
  local pw key
  pw="$(openssl rand -hex 12)" || { echo "openssl failed; refusing." >&2; rm -rf "$SCRATCH_WORK"; exit 1; }
  key="$(openssl rand -base64 32 | tr '+/' '-_')" && [[ -n "$key" ]] || { echo "openssl failed; refusing." >&2; rm -rf "$SCRATCH_WORK"; exit 1; }
  export DCDASH_DB_PASSWORD="scratch-$pw" DCDASH_SECRET_KEY="$key"
  if [[ "$(resolved_project)" != "$SCRATCH_PROJECT" ]]; then
    echo "Compose does not resolve to $SCRATCH_PROJECT (got '$(resolved_project)'); refusing." >&2
    rm -rf "$SCRATCH_WORK"; exit 1
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
scratch_script() {
  [[ "$(resolved_project)" == "$SCRATCH_PROJECT" ]] || { echo "scratch_script: Compose does not resolve to $SCRATCH_PROJECT, refusing" >&2; exit 1; }
  [[ -z "$(docker compose ps --format '{{.Name}}' | grep -v "^${SCRATCH_PROJECT}-" || true)" ]] \
    || { echo "scratch_script: a container outside the scratch project is in scope, refusing" >&2; exit 1; }
  bash "$@"
}
