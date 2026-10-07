#!/usr/bin/env bash
# Runs the Playwright end-to-end journey against a FRESH dev-profile stack.
#
# WARNING: this runs `docker compose --profile dev down -v`, which DELETES the database volume
# (dbdata) and every reading, user and source in it. Never run it against a production box.
#
# On Windows, run it from WSL (`wsl bash scripts/e2e.sh`) or run the three commands by hand
# in PowerShell.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${E2E_I_UNDERSTAND_DATA_LOSS:-}" != "yes" ]; then
  echo "This deletes the local database volume. Re-run with E2E_I_UNDERSTAND_DATA_LOSS=yes." >&2
  exit 1
fi
docker compose --profile dev down -v --remove-orphans
docker compose --profile dev up -d --build
status=0
(cd frontend && npm run e2e) || status=$?
docker compose --profile dev down
exit $status
