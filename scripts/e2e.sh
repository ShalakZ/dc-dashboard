#!/usr/bin/env bash
# Runs the Playwright end-to-end journey against a FRESH dev-profile stack, in its own Compose project.
#
# The project is dcdash_e2e, so its database volume is dcdash_e2e_dbdata and the `down -v` below can only delete that
# one. It can never reach dcdash_dbdata, the volume of the normal project (every reading, user, source, tariff and
# dashboard you have). Every compose command here names the project with -p, and the script refuses a project name that
# does not start with dcdash_e2e (E2E_COMPOSE_PROJECT can pick another throwaway name, nothing else).
#
# The normal stack must be stopped first: both publish ports 80 and 443. Stop it with
# `docker compose --profile dev stop`, never with -v. Both also build the images dcdash-backend:local and
# dcdash-web:local, so this run re-tags them (see the README, section End-to-end test).
#
# On Windows, run it from WSL (`wsl bash scripts/e2e.sh`) or run the commands by hand in PowerShell.
set -euo pipefail
cd "$(dirname "$0")/.."

project="${E2E_COMPOSE_PROJECT-dcdash_e2e}"
case "$project" in
  dcdash_e2e*) ;;
  *)
    echo "Refusing to run in the Compose project '$project'. The end-to-end run deletes its database volume, so it only" >&2
    echo "runs in a project whose name starts with dcdash_e2e (its volume is then dcdash_e2e_dbdata). The normal" >&2
    echo "project's volume, dcdash_dbdata, holds your real data and is never touched." >&2
    exit 1
    ;;
esac

if [ -n "$(docker compose -p dcdash --profile dev ps -q)" ]; then
  echo "The normal stack (Compose project dcdash) is running and holds ports 80 and 443. Stop it first, without -v:" >&2
  echo "  docker compose --profile dev stop" >&2
  exit 1
fi

compose() { docker compose -p "$project" --profile dev "$@"; }

compose down -v --remove-orphans
compose up -d --build
status=0
(cd frontend && npm run e2e) || status=$?
compose down
exit $status
