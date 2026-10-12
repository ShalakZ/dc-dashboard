#!/usr/bin/env bash
# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts/setup.sh --profile dev
# --timezone <zone> (or the DCDASH_TIMEZONE environment variable) sets the site timezone of the NEW .env, e.g.
# scripts/setup.sh --timezone Africa/Cairo; the flag wins. It only seeds the first start; Settings changes it later.
set -euo pipefail
zones_file="$(cd "$(dirname "$0")" && pwd)/timezones.txt"
cd "$(dirname "$0")/.."

case "$PWD" in
  *[Oo]ne[Dd]rive*)
    echo "warning: this folder is inside OneDrive ($PWD). .env (the database password and the key that decrypts stored source credentials) and the backups would be synced to the cloud, and bind mounts on synced paths can be slow or locked. Install outside any synced folder, for example ~/dcdash." >&2 ;;
esac

# --timezone is ours; every other argument goes to docker compose (the positional parameters from here on).
compose_args=()
flag_given=0
flag_zone=""
while [ $# -gt 0 ]; do
  case "$1" in
    --timezone)
      [ $# -ge 2 ] || { echo "--timezone needs a value (a zone name like Africa/Cairo)" >&2; exit 1; }
      flag_given=1; flag_zone="$2"; shift 2 ;;
    --timezone=*)
      flag_given=1; flag_zone="${1#--timezone=}"; shift ;;
    *)
      compose_args+=("$1"); shift ;;
  esac
done
set -- ${compose_args[@]+"${compose_args[@]}"}  # the +form keeps an empty list working under set -u on bash < 4.4

# The zone has to be on the allowlist (scripts/timezones.txt: the names Settings accepts) BEFORE anything is started: the api and
# the collector read DCDASH_TIMEZONE at import, and a name they refuse crash-loops both on the first start.
check_zone() {  # $1 = the zone, $2 = where it came from
  local zone="$1" origin="$2" listed=0
  if [ -z "$zone" ]; then
    echo "$origin is empty: give a zone name like Africa/Cairo, or leave it out to start with UTC" >&2; exit 1
  fi
  [ -f "$zones_file" ] || { echo "cannot read $zones_file (the list of accepted timezones)" >&2; exit 1; }
  # A name has no space, newline or '#'; grep -x would read a newline in the value as a second pattern, so those never get to it.
  case "$zone" in
    *[!A-Za-z0-9_+/-]*) ;;
    *) if grep -Fxq -- "$zone" "$zones_file"; then listed=1; fi ;;
  esac
  [ "$listed" = 1 ] && return 0
  zone="$(printf '%s' "$zone" | tr '\n\r' '  ')"
  case "$zone" in
    *" "*)
      echo "$origin: '$zone' is not an IANA zone name (use a name like Africa/Cairo, not a Windows name like \"Egypt Standard Time\"). Leave it out to start with UTC and change it on the Settings page after the first start." >&2 ;;
    *)
      echo "$origin: timezone '$zone' is unknown to this release or refused by Settings (the UTC offset must be a whole number of hours in January and July, and the name must be spelled exactly as in the IANA list, for example Africa/Cairo). Leave it out to start with UTC and change it on the Settings page after the first start." >&2 ;;
  esac
  exit 1
}
requested=""
if [ "$flag_given" = 1 ]; then
  check_zone "$flag_zone" "--timezone"; requested="$flag_zone"
elif [ -n "${DCDASH_TIMEZONE:-}" ]; then
  check_zone "$DCDASH_TIMEZONE" "DCDASH_TIMEZONE"; requested="$DCDASH_TIMEZONE"
fi

# The Compose project name that the given `docker compose ...` command line acts on (nothing if it cannot say).
project_name() {
  local config
  config="$("$@" config --no-interpolate)" || return 1
  printf '%s\n' "$config" | sed -n 's/^name: *//p' | head -n 1
}

if [ -f .env ]; then
  # An .env without a database password can start nothing and cannot open an existing volume: leave it as it is and stop.
  grep -q '^DCDASH_DB_PASSWORD=.' .env || { echo ".env exists but has no DCDASH_DB_PASSWORD; it was not changed. Restore or fix it, then run this script again." >&2; exit 1; }
  if [ "$flag_given" = 1 ]; then
    echo "note: .env already exists, so --timezone changes nothing: the zone only seeds the first start. Change it on the Settings page." >&2
  fi
  # Compose reads a shell variable before .env, so a stale one wins for this start.
  env_zone="$(sed -n 's/^DCDASH_TIMEZONE=//p' .env | head -n 1 | tr -d '\r')"
  if [ -n "${DCDASH_TIMEZONE:-}" ] && [ "$DCDASH_TIMEZONE" != "${env_zone:-UTC}" ]; then
    echo "warning: the DCDASH_TIMEZONE variable in this shell ($DCDASH_TIMEZONE) overrides .env (${env_zone:-UTC}) for this start." >&2
  fi
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
  zone="${requested:-UTC}"
  printf 'DCDASH_DB_PASSWORD=%s\nDCDASH_SECRET_KEY=%s\nDCDASH_TIMEZONE=%s\n' \
    "$db_password" "$secret_key" "$zone" > .env
  echo "Created .env"
  # A shell variable beats .env in Compose, so the chosen zone wins over a stale one for this first start.
  export DCDASH_TIMEZONE="$zone"
  echo "timezone: $zone (it seeds Settings on the first start only; change it there later)" >&2
fi
PROJECT="$(project_name docker compose "$@" 2>/dev/null || true)"
echo "starting Compose project: ${PROJECT:-unknown}" >&2
# The build id the backend images carry (Settings, GET /api/version and every diagnostics report show it): the commit and that commit's
# time, never the clock of this run, so an unchanged tree builds the same image and nothing is recreated. Without git, or outside a
# repository, it stays dev / unknown.
DCDASH_BUILD_ID="$(git describe --always --dirty 2>/dev/null || true)"
DCDASH_BUILD_TIME="$(git log -1 --format=%cI 2>/dev/null || true)"
export DCDASH_BUILD_ID="${DCDASH_BUILD_ID:-dev}" DCDASH_BUILD_TIME="${DCDASH_BUILD_TIME:-unknown}"
# Without this, re-running on an unchanged tree recreates api, collector, web and simulator: default attestations change the image id on every build.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
docker compose "$@" up -d --build
