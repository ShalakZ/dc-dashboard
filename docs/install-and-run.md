# Install and run

This page is for whoever installs DC Dashboard on a machine and starts it: the first run and its timezone choice, optional
HTTPS, the first sign-in, the development simulator, and the services and ports of the stack. Updating an existing install is
on [Upgrading and going back](upgrading.md).

## Install

You need Docker (Docker Desktop on Windows). Run the setup script from the repository folder.

Linux / WSL:

```bash
scripts/setup.sh
```

Windows PowerShell:

```powershell
scripts\setup.ps1
```

If PowerShell refuses the script, for example because the folder came over a share or a download, run it like this
(`-ExecutionPolicy Bypass` applies to that one process and changes nothing on the machine; see [Backup and restore](backup-and-restore.md)):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
```

The first run creates `.env` with a database password and an encryption key, then builds and starts the stack. Keep `.env`:
without its key, stored source credentials cannot be decrypted. Keep a copy of `.env` with every backup (see
[What the backup does not contain](backup-and-restore.md#what-the-backup-does-not-contain)). If `.env` is missing but the
database volume already exists, the script refuses to create a new one (a new password would never open the old volume) and
tells you to put the original back.

Every argument the script does not know goes on to `docker compose` (for example `--profile dev`, see
[The simulator](#the-simulator)). The script prints the Compose project it starts (`starting Compose project: <name>`) and
builds the images with the commit as the build id, which Settings shows.

**Do not install inside OneDrive** (or another synced folder; on a managed laptop `Desktop` and `Documents` often are): `.env` and
the backups would be copied to the cloud, and bind mounts on synced paths can be slow or locked. Use a plain local folder such as
`C:\dcdash`. The setup scripts print a warning when the folder looks like OneDrive.

Later starts need only `docker compose up -d`. The exception is a start after you pulled a new version: starting `api` migrates
the database, so read [Upgrading and going back](upgrading.md) (and the release notes it points to) before the first start on a
database that already holds data.

## Choose the timezone

Choose the site timezone on the first run, so that "today" starts at local midnight from the first start:

```powershell
scripts\setup.ps1 -Timezone Africa/Cairo
```

```bash
scripts/setup.sh --timezone Africa/Cairo          # or: DCDASH_TIMEZONE=Africa/Cairo scripts/setup.sh
```

- `--timezone=Africa/Cairo` and `-Timezone:Africa/Cairo` work too. Both scripts also read `DCDASH_TIMEZONE` from the environment;
  the flag wins over the variable. Without a flag or variable the zone is `UTC`.
- The script checks the name against the list in `scripts/timezones.txt` before it writes `.env` or starts anything. It refuses a
  typo (`Africa/Ciro`; the spelling is exact, `africa/cairo` is refused) or a Windows name (`Egypt Standard Time`) with a message:
  a wrong name in `.env` would make the api and the collector restart forever.
- The zone must have a whole-hour UTC offset in both January and July (`Asia/Qatar`, `Africa/Cairo` and `Europe/London` do,
  `Asia/Kolkata` does not, and the script refuses it): energy and billing are built from hourly buckets, and local midnight must
  fall on a bucket edge all year; see
  [Dashboards and billing](dashboards-and-billing.md).
- The zone only seeds the database on the FIRST start: editing `DCDASH_TIMEZONE` in `.env` later does not change an existing
  database. Change the timezone of a running installation on the Settings page. If `.env` already exists, the flag changes nothing
  and the script says so (a name that is not on the list is still refused).

## Optional HTTPS

Put your certificate chain and private key in `./certs/` (the folder is mounted read-only into the `web` container at `/certs`)
and add to `.env`:

```
DCDASH_TLS_CERT=/certs/fullchain.pem
DCDASH_TLS_KEY=/certs/privkey.pem
```

Then `docker compose up -d`. Port 443 serves HTTPS and port 80 redirects to it; the session cookie gets the `Secure` flag
automatically. Set both variables or neither: with only one, the `web` container exits with
`web: both DCDASH_TLS_CERT and DCDASH_TLS_KEY must be set (or neither)`. Leave both unset for plain HTTP.

The `web` container runs as uid/gid 10002, so give it the key without making the file world-readable:

```bash
sudo chown 10002:10002 certs/privkey.pem && chmod 640 certs/privkey.pem
```

If either file is missing or unreadable the `web` container exits with `TLS file not readable inside the container: ...` in
`docker compose logs web`.

`scripts/check_tls.sh` exercises both paths in a throwaway Compose project of its own (a self-signed certificate in a temporary
folder, its own images, `web` published only on `127.0.0.1:18080` and `127.0.0.1:18443`): it leaves `./certs`, your `.env`, the
normal stack and ports 80 and 443 alone. It shares the project-name guard of `scripts/backup_smoke.sh`; see
[Practise a restore](backup-and-restore.md#practise-a-restore).

### Renewing the certificate

Write the new `fullchain.pem` and `privkey.pem` into `./certs` under the same names, keep `chown 10002:10002` and `chmod 640` on
the key, then run `docker compose restart web`. A new certificate is not picked up without that restart (checked).

The `collector` mounts `./certs` too and reads the certificate at the same path once an hour, so the Settings page shows the new
expiry within the hour; `docker compose restart collector` shows it at once. `fullchain.pem` must stay readable by everyone
(mode 644): the collector (uid 10001) reads the certificate to watch its expiry and never reads the key. If the file is made
unreadable, the Settings page and the notice both say "cannot be read" and name the file, and the notice adds that its expiry is
not being watched until that is fixed (checked with a mode 600 file).

While `DCDASH_TLS_CERT` is set, the Settings page has a read-only "Certificate" line with the expiry date, and administrators see
a notice at the top of every page when the certificate has less than 30 days left (the notice names the date and the days left),
when it has expired (browsers already warn your users then) or when the file cannot be read (the notice says why). Nothing is
shown when `DCDASH_TLS_CERT` is unset. If the collector is not running, the stored answer is not trusted after three hours and no
notice is shown.

### Security headers

Every answer of the `web` container (pages, the API, and the redirect from port 80), over HTTP and over HTTPS alike, carries
`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY` and a
`Content-Security-Policy-Report-Only`; Caddy's own `Server` header is removed (so is the API's). That includes the error answer
Caddy gives while the `api` restarts (a short text body, `502 Bad Gateway`). They come from one file,
`deploy/security-headers.caddy`, which both Caddyfiles import in every site block and again in each block's `handle_errors` (the
part that gives Caddy's own error answers the headers).

The content policy is **Report-Only on purpose**: a browser that finds a violation writes it to the console and blocks nothing,
so a policy that is too tight cannot break a page. It allows scripts, connections (the live stream included), fonts and forms
from the site's own origin only, images from the site, `data:` and `blob:`, inline styles (React and the charts write `style`
attributes), and no plug-ins. It names no report address, because that would be a new unauthenticated route. The policy has no
`frame-ancestors` because `X-Frame-Options: DENY` already forbids framing.

To read violations, open the browser's developer tools on any page: a violation is a console message that starts with
`[Report Only] Refused to ...` and names the directive. `frontend/e2e/headers.spec.ts` walks every page an administrator can open
and fails on any such message.

The redirect from port 80 is `https://<host><path>` and drops a non-standard port, so publish HTTPS on 443. Changes to the
headers need `docker compose up -d --build web`.

### Enforcing the policy later

To enforce the policy later: rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in
`deploy/security-headers.caddy`, run the Playwright `headers` project first (it must stay at zero violations), then
`docker compose up -d --build web`. `test_the_policy_is_report_only_on_purpose` in `backend/tests/test_caddy_headers.py` pins
Report-Only and has to be changed in the same commit, and so does the header name that `frontend/e2e/headers.spec.ts` reads.

## Optional: a token for the data health URL

`GET /api/health/data` tells a monitoring tool whether the billing meters still report; it is open like `GET /api/health` and names
nothing. To make it answer only to a caller that knows a secret, add `DCDASH_HEALTH_TOKEN=<a long random string>` to `.env` and run
`docker compose up -d`; the caller then sends `Authorization: Bearer <token>` (a missing or wrong one is a 401; leave the line out, or
blank, for an open URL). What the URL answers, how to poll it and why it must never be a container healthcheck are in [Watching the
data from outside](operating.md#watching-the-data-from-outside).

## First sign-in

Open `http://localhost/` (or `https://` with your host name once HTTPS is set up). The first visit asks you to create the admin
account. Then:

1. **Sources**, **Add source**, then **Test** in the source's row menu.
2. **Points** in the same menu, then **Browse points** and **Map** a point to an asset.
3. **Assets Tree**: open the asset to see its live and historical values.

The API is served under `/api`, with interactive API docs at `/api/docs`. What each screen does and who can open it is on
[Screens](screens.md); the protocols and their settings are on [Sources and discovery](sources-and-discovery.md).

## The simulator

To try the platform without real equipment, include the SCADA simulator (10 LV panels, `LVP01` to `LVP10`) by adding the dev
profile:

```bash
scripts/setup.sh --profile dev
uv run --project backend python scripts/smoke.py          # drives http://localhost through Caddy
scripts/check_web.sh                                     # SPA, proxy, SSE route and static-file header checks
```

```powershell
scripts\setup.ps1 --profile dev
```

`scripts/smoke.py` drives the stack from the first-run setup to live data: it signs in as `admin` with the password
`smoke-test-password` (and creates that account on a fresh stack), then adds the source `smoke-sim`, the asset `Smoke Panel` and two
mappings. Use it on a test stack, not on one that holds real data.

The simulator's three protocols are added as sources in the app like any other:

- **HTTP** (type `simulator`, URL `http://simulator:9000`) needs the Secret `sim-key` (the simulator's API key, `SIM_API_KEY` in
  `compose.yaml`). Without it, Test shows `auth_failed - credentials rejected` and marks the source `offline` with that Last
  error, and Browse fails, so there is nothing to map.
- **OPC UA** (`opc.tcp://simulator:4840/dcdash/`) accepts any login (or none) unless `SIM_OPCUA_PASSWORD` is set in `.env`; then
  it takes the user `sim` with that password.
- **Modbus TCP** (`simulator:5020`, unit 1) needs no login.

**Who this simulator is.** `SIM_INSTANCE_ID` (default `dev`; letters, digits, dot, underscore and dash, 1 to 40 characters, anything
else becomes `dev`) is announced by the HTTP simulator on `GET /` and by its OPC UA server as the application URI
`urn:dcdash:simulator:<id>`. The platform remembers it, so that when Docker gives the simulator a new address after an update it can
tell the same simulator from another one and offer to move the source ([Devices that move or disappear](devices-that-move.md)). Set it
in `.env` if you want another value. **Two stacks on one network need different values**: two simulators left at `dev` look like one
server that moved. The stand-in Historian announces `<id>:historian`, so it does not clash with the simulator beside it. One caveat: a
simulator started with `SIM_FAULT_POLICIES=basic256sha256` makes a new certificate at every start, so its certificate thumbprint
changes each time and the platform never offers it as the same server (the certificates differ); a source that remembers nothing yet
can still get a possible-match offer, and otherwise you edit the address of its sources by hand.

The simulator can also play faults (a slow server, dropped connections, refused logins and more) for rehearsing a field
problem: see [Field debugging](field-debugging.md).

## Services and ports

| Service | Role | Published ports | Docker health check |
|---|---|---|---|
| `db` | PostgreSQL 16 with TimescaleDB; data in the `dbdata` volume | none | `pg_isready` |
| `api` | HTTP API; runs `alembic upgrade head` on every start, then serves on port 8000 inside the stack; never contacts a source | none | `GET /api/health` |
| `collector` | Polls sources and runs connection tests and browses; read-only toward sources | none | none |
| `web` | Caddy: serves the UI, proxies `/api` to `api` | `80` (HTTP, or the redirect to HTTPS) and `443` (HTTPS, only when it is set up) | the UI is in the image and Caddy answers |
| `simulator` | Stand-in SCADA, dev profile only: HTTP `:9000`, OPC UA `opc.tcp://simulator:4840/dcdash/`, Modbus TCP `simulator:5020` (unit 1) | `127.0.0.1:9000`, `127.0.0.1:4840`, `127.0.0.1:5020` (this machine only) | none |

`api`, `collector` and `simulator` are built from one image (`dcdash-backend:local`), `web` from its own (`dcdash-web:local`).
Every service restarts unless stopped, and every container keeps at most 5 log files of 10 MB. What the health checks mean, and
how to read the logs, is on [Operating the stack](operating.md).

Related: [Operating the stack](operating.md), [Upgrading and going back](upgrading.md), [Backup and restore](backup-and-restore.md), [Screens](screens.md), [Sources and discovery](sources-and-discovery.md).
