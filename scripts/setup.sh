#!/usr/bin/env bash
# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts/setup.sh --profile dev
set -euo pipefail
cd "$(dirname "$0")/.."

# The Compose project name that the given `docker compose ...` command line acts on (nothing if it cannot say).
project_name() {
  local config
  config="$("$@" config --no-interpolate)" || return 1
  printf '%s\n' "$config" | sed -n 's/^name: *//p' | head -n 1
}

if [ -f .env ]; then
  # An .env without a database password can start nothing and cannot open an existing volume: leave it as it is and stop.
  grep -q '^DCDASH_DB_PASSWORD=.' .env || { echo ".env exists but has no DCDASH_DB_PASSWORD; it was not changed. Restore or fix it, then run this script again." >&2; exit 1; }
else
  # No .env but the database volume already exists: the volume was created with the password of the .env that is gone, so a
  # new random password would never open it (the api would crash-loop) and the new key could not decrypt the stored source
  # secrets. Stop before anything is written. .env belongs to the directory, not to one Compose project, so two projects are
  # checked: the one this command line selects (looked up with the same arguments, so -p and COMPOSE_PROJECT_NAME count) and
  # the one compose.yaml names (looked up without the arguments and with COMPOSE_PROJECT_NAME unset). Fail closed: `compose
  # config` never contacts the daemon, `docker volume ls` does, and when it cannot answer the check cannot be made.
  effective="$(project_name docker compose "$@")" || { echo "cannot read the Compose configuration; .env was not created" >&2; exit 1; }
  own="$(project_name env -u COMPOSE_PROJECT_NAME docker compose)" || { echo "cannot read the Compose configuration; .env was not created" >&2; exit 1; }
  [ -n "$effective" ] && [ -n "$own" ] || { echo "cannot tell the Compose project name; .env was not created" >&2; exit 1; }
  projects="$effective"
  if [ "$own" != "$effective" ]; then projects="$effective $own"; fi
  for project in $projects; do
    volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.volume=dbdata)" || { echo "cannot list Docker volumes (is Docker running?); .env was not created" >&2; exit 1; }
    if [ -n "$volumes" ]; then
      echo "refusing to create .env: the database volume of Compose project '$project' already exists, and it belongs to the .env that is missing." >&2
      echo "Put the original .env back (keep a copy with every backup), then run this script again." >&2
      echo "No copy of it? The data is still in the volume: back it up first (README, Backup and restore, \"What the backup does not contain\"). Never use down -v." >&2
      exit 1
    fi
  done
  db_password=$(openssl rand -hex 24)
  secret_key=$(openssl rand -base64 32 | tr '+/' '-_')
  printf 'DCDASH_DB_PASSWORD=%s\nDCDASH_SECRET_KEY=%s\nDCDASH_TIMEZONE=UTC\n' \
    "$db_password" "$secret_key" > .env
  echo "Created .env"
fi
PROJECT="$(project_name docker compose "$@" 2>/dev/null || true)"
echo "starting Compose project: ${PROJECT:-unknown}" >&2
# Without this, re-running on an unchanged tree recreates api, collector, web and simulator: default attestations change the image id on every build.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
docker compose "$@" up -d --build
