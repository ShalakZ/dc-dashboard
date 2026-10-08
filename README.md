# DC Dashboard

Collects electrical data from data center systems, organizes it under a
hierarchy you define, and serves live values, history and energy use.

Design: `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md`

Status: Phase 3 (dashboards and billing). The web UI is served at `http://localhost/`; the API is
proxied at `http://localhost/api` (interactive docs at `/api/docs`). Sources
can be the simulator, OPC UA servers or Modbus TCP devices; readings are kept
in raw, 1-minute and 1-hour tiers (see "Storage tiers"). An admin can scan a
network for sources and map what is found to assets by drag and drop (see
"Discovery"). Everyone can read shared dashboards and a cost report per asset; operators build
dashboards and admins set tariffs (see "Dashboards and billing").

## Run it

Requires Docker (Docker Desktop on Windows).

Linux / WSL:

```bash
scripts/setup.sh
```

Windows PowerShell:

```powershell
scripts\setup.ps1
```

The first run creates `.env` with a database password and an encryption key,
then builds and starts the stack. Keep `.env`: without its key, stored source
credentials cannot be decrypted. Set `DCDASH_TIMEZONE` in `.env` (for example
`Asia/Qatar`) so that "today" starts at local midnight. The zone must have a whole-hour UTC offset in
both January and July (`Asia/Qatar` and `Europe/London` do, `Asia/Kolkata` does not); see
"Dashboards and billing".

Later starts need only `docker compose up -d`. The exception is a start after you pulled a new
version: starting `api` migrates the database, so read "Upgrading an existing database to Phase 3"
before the first start on a database that already holds data.

### Optional HTTPS

Put your certificate chain and private key in `./certs/` (the folder is mounted read-only into the
`web` container at `/certs`) and add to `.env`:

    DCDASH_TLS_CERT=/certs/fullchain.pem
    DCDASH_TLS_KEY=/certs/privkey.pem

Then `docker compose up -d`. Port 443 serves HTTPS and port 80 redirects to it; the session cookie
gets the `Secure` flag automatically. The `web` container runs as uid/gid 10002, so give it the key
without making the file world-readable: `sudo chown 10002:10002 certs/privkey.pem && chmod 640
certs/privkey.pem`. If either file is missing or unreadable the `web` container exits with
`TLS file not readable inside the container: ...` in `docker compose logs web`. Leave both variables
unset for plain HTTP. `scripts/check_tls.sh` exercises both paths with a throwaway self-signed cert.

Open `http://localhost/`. The first visit asks you to create the admin
account. Then: Sources → Add source → Test → Points → Browse points → Map;
Assets → open the asset to see live and historical values.

To include the SCADA simulator (10 LV panels), add the dev profile:

```bash
scripts/setup.sh --profile dev
uv run --project backend python scripts/smoke.py          # drives http://localhost through Caddy
scripts/check_web.sh                                     # SPA, proxy and SSE route checks
```

## Services

| Service | Role |
|---|---|
| `db` | PostgreSQL + TimescaleDB |
| `api` | HTTP API; never contacts a source |
| `collector` | Polls sources and runs connection tests and browses; read-only toward sources |
| `simulator` | Stand-in SCADA, dev profile only: HTTP `:9000`, OPC UA `opc.tcp://simulator:4840/dcdash/` (user `sim`), Modbus TCP `simulator:5020` (unit 1); all three bound to `127.0.0.1` on the host |
| `web` | Caddy: serves the UI, proxies `/api` to `api` |

UI screens, besides Assets, Sources and Points:

- **Users** (admin): create users, change roles, deactivate / reactivate, reset a password.
  Deactivating signs that user out everywhere. You cannot deactivate or demote yourself.
- **Settings** (admin): site timezone (IANA name). It decides where a day and a month start for energy
  totals, Billing and dashboard ranges, and it must have a whole-hour UTC offset in both January and
  July (Settings refuses any other zone). `DCDASH_TIMEZONE` in `.env` only seeds this on first start.
- **Storage** (admin): database and per-tier sizes, compression ratio, rows per day, growth and a
  projected days-until-full figure. Free disk space is not visible from the API container, so disk
  capacity is a setting: set it to the size of the volume holding the database. The page also edits
  raw retention, compression delay, 1-minute rollup retention and the warning threshold.
- **Password** (everyone): change your own password; your other sessions are signed out.
- **Scans** and **Discovery** (operators and admins; only admins can change anything): see "Discovery".
- **Audit** (admin): the read-only audit log, newest first, 50 entries per page.
- **Dashboards** (everyone can read; operators and admins build): shared dashboards of widgets; see
  "Dashboards and billing".
- **Billing** (everyone): cost per asset per day and per month, with a CSV export.
- **Tariffs** (admin): the site currency and the rates that cost is calculated with.

### Protocols

Every connector is read-only toward the source; only `collector` opens connections. A source's
`last_error` reads `<status>: <message>` with status `ok`, `auth_failed`, `timeout`, `unreachable`,
`protocol_error` or `needs_profile`.

**OPC UA** (`opcua`): `endpoint` (`opc.tcp://...`), `security_policy` (`none` or `basic256sha256`),
optional `username` (the password is the source secret), `root_node` (default `i=85`, the Objects
folder; browsing descends from here) and `timeout_seconds`. With `basic256sha256` the collector
signs and encrypts with a client certificate read from `client_cert` / `client_key` (default
`/certs/opcua-client.pem` and `/certs/opcua-client-key.pem`; `./certs` is mounted read-only into
the collector). Without the files the source reports `protocol_error: client certificate not
found: <path>`. Generate a self-signed client certificate with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=dcdash" \
  -addext "subjectAltName=URI:urn:dcdash:collector" \
  -keyout certs/opcua-client-key.pem -out certs/opcua-client.pem
```

Trust `certs/opcua-client.pem` on the OPC UA server afterwards.

**Modbus TCP** (`modbus`): `host`, `port` (502), `unit_id` (1), `profile` (`auto` or the name of an
installed profile) and `timeout_seconds`. Only function codes 3, 4 and 43/14 (device identification)
are ever sent. Point addresses are `fc:register`, e.g. `4:0` is input register 0. A profile is a
YAML file in `backend/dcdash/profiles/` describing the register layout; `auto` matches the device's
vendor/product from FC 43 against the installed profiles and fails with `needs_profile` when nothing
matches (pick a profile on the source) or the chosen profile is not installed. Example
(`generic_float32.yaml`):

```yaml
name: generic_float32
vendor: null          # set vendor/product_code to let `auto` match the device
product_code: null
blocks:
  - function: 4       # 3 = holding registers, 4 = input registers
    start: 0
    count: 8
    word_order: little
    points:
      - {name: Active power, offset: 0, data_type: float32, unit: kW}
      - {name: Energy, offset: 2, data_type: float32, unit: kWh}
      - {name: Voltage, offset: 4, data_type: float32, unit: V}
      - {name: Current, offset: 6, data_type: float32, unit: A}
```

Each point takes `data_type` (`int16`, `uint16`, `int32`, `uint32`, `float32`, ...), an optional
`unit` and an optional `scale` (default `1.0`) that the decoded register value is multiplied by, so
an `int16` register holding `1234` with `scale: 0.1` reads as `123.4`. A device that accepts the
TCP connection but never answers is reported as `timeout` after about twice `timeout_seconds`.

### Storage tiers

| Tier | Table | Contents | Kept for (default) |
|---|---|---|---|
| raw | `readings` | every sample, compressed after `compress_after_days` (7) | `raw_retention_days` (30) |
| 1m | `readings_1m` | per-minute avg/min/max of good samples (`quality = 0`) | `rollup_1m_retention_days` (730) |
| 1h | `readings_1h` | per-hour avg/min/max of good samples | forever |

A chart reads whichever tier matches its bucket width: raw under one minute per bucket, `1m` under
one hour, `1h` beyond; the `series` response carries the chosen `tier` and the chart shows it as
"raw samples", "1-minute rollup" or "1-hour rollup". Rollups and retention are TimescaleDB
continuous aggregates and policies configured from the Storage settings; no application code ever
deletes readings.

## Discovery

Discovery finds sources on the network and lets an admin map their points to assets without typing
addresses. Everything it does toward the network is read-only: a TCP connect, then the same
data-retrieval requests the connectors already use, nothing else.

1. **Scan scopes** (Scans, admin): a named list of targets (CIDR ranges, host names or addresses,
   URLs) and TCP ports (at most 20). A new scope is pre-filled from the collector's own network
   interfaces, clamped to the /24 around its address, and from the ports the connectors know.
2. **Confirmation.** Pressing Scan shows "N hosts × M ports (P probes)" and asks for confirmation on
   every run. The API enforces it: the start request must carry the host count the API computed
   itself, or nothing runs. It must also carry the digest the preview returned (a hash of the scope's
   targets and ports), so a scope edited after it was previewed cannot be started unconfirmed: the
   page asks you to confirm again.
3. **What a scan does.** The collector tries a TCP connect to every host and port, then offers each
   open endpoint to every connector's read-only probe (first claim wins; an endpoint nobody claims is
   listed as an unidentified service), then browses the claimed sources to find their points. The page
   shows progress and, when done, one finding per open endpoint.
4. **Discovered sources are disabled.** A discovered source is created disabled and is not polled,
   tested or listed under Sources until at least one of its points is mapped; mapping enables it. A
   source you added by hand at the same address is reused, never duplicated. A re-scan reuses existing
   source rows untouched (name, config, secret, enabled, origin) and only refreshes their points and
   findings. A source that answers "authentication failed" is marked as needing credentials and the scan
   carries on.
5. **The graph** (Discovery). Discovered sources, clusters and points are on the left with dashed
   borders; your assets are on the right with solid ones; mapped points are joined to their asset by a
   solid edge. Sources and clusters start collapsed: use the + / − button on a node to expand or
   collapse it. Points are grouped into suggested clusters (for example one per panel). Dragging nodes
   saves their positions for everyone (admin); an operator's arrangement lasts for the session.
6. **Mapping by drag and drop** (admin). Drop a cluster or a point on an asset to open the **Review
   mappings** dialog: one row per unmapped point with a guessed metric, scale and interval, all
   editable; rows whose metric the asset already has start unchecked, and a conflicting selection
   cannot be committed. "Create mappings" commits every checked row in one transaction. Drop a cluster
   on empty canvas and a bar offers "Create asset from this cluster", which opens the same dialog with
   a new asset named after the cluster and a parent of your choice; the bar stays until you use or
   dismiss it. The same dialog opens from keyboard-reachable buttons, for admins only: **Map…** on
   unmapped clusters and unmapped points, **New asset…** on clusters only. The Ungrouped bag and fully
   mapped clusters get neither.
7. **Credentials.** Click a source that shows "needs credentials" (or press its **Details** button) to open its side panel, enter the
   secret (and the user name for OPC UA) and save: the source is browsed again. Secrets are stored
   encrypted and never returned by the API.
8. **Audit log** (Audit, admin). Scope changes, scan start and finish and every accepted mapping are
   recorded with the user and time. Phase 1 actions (user management, source edits and so on) are not
   audited.

Environment variables (set them in `.env`; both are optional):

| Variable | Default | Meaning |
|---|---|---|
| `DCDASH_SCAN_MAX_HOSTS` | `1024` | Most hosts a single scan may cover; a larger scope is rejected |
| `DCDASH_SCAN_EXTRA_PORTS` | empty | Comma-separated ports offered, besides the connectors' own, when a new scope is pre-filled. For the dev simulator set it to `5020` (its Modbus port), or type `5020` into the scope form |

Scan limits: at most 64 TCP connects at a time and 200 attempts per second, a 1 second connect
timeout, a 3 second timeout per connector probe, 4 sources browsed at a time. Targets are IPv4 only.
In the dev stack, a scope with targets `simulator` and ports `9000, 4840, 5020` finds all three
simulator protocols.

## Dashboards and billing

Roles are enforced by the API; the screens only hide what you cannot use.

| | Viewer | Operator | Admin |
|---|---|---|---|
| Open dashboards and Billing, export CSV | yes | yes | yes |
| Create, edit and delete dashboards | no | yes | yes |
| Read tariffs (through the API; operators have no Tariffs screen) | no | yes | yes |
| Set tariffs and the currency (Tariffs screen) | no | no | yes |

**Dashboards** are shared by everyone. A dashboard holds up to 24 widgets (the site up to 50
dashboards) of five types: time series, bar, stat, gauge and table. A dashboard name is 1 to 100
characters (spaces at the ends are trimmed) and unique: a name already in use is refused with a 409. A
widget title is at most 100 characters. A widget shows a metric, energy or
cost for up to 20 assets (a stat or a gauge shows one). A dashboard has one time range and a widget may
override it. The ranges are the rolling `1h`, `6h`, `24h`, `7d`, `30d` and the calendar `today`,
`yesterday`, `this_month`, `last_month` (in the site timezone); there are no custom date ranges, and
changing the range on the page affects that visit only. Stat and gauge widgets that show the latest value
follow the live stream while their range ends now (the rolling ranges, `today` and `this_month`; not
`yesterday` or `last_month`); every widget also refreshes every 30 seconds. **Edit** (operators and admins)
opens the grid editor: drag a widget by its title bar, resize it from the corner or the edges, **Add
widget**, then **Save**, which stores the whole dashboard in one step. If someone else saved first you are
told, nothing is overwritten, and you can reload their version. Leaving the editor from inside the app,
or closing the page, asks first when something is unsaved; a session that expires while you edit does
not: the app signs you out and the unsaved edits are dropped without a prompt. A widget whose asset
was deleted shows "N assets removed" and draws the rest. A metric with no reading in the range says "no
data" (the dash is only for a missing rate), and a cost chart with unpriced buckets says "— no rate" under
its title. Every widget has a CSV button (UTF-8 with a byte-order mark,
times in the site timezone with their offset, columns `asset,source,unit,timestamp,value,estimated,partial,no_data`;
text starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe so that
spreadsheets do not run it as a formula). Custom metrics are not available in widgets; they stay on the
asset page. A metric widget offers only assets that have a mapping for that metric.

**Billing** shows one month at a time (previous and next month; the current month by default) as the
asset tree by day: kWh above, cost below, then the month total and the rate in effect. `~` marks a
figure estimated from power and `*` a partial cost (some energy in the period had no rate). A dash means
one thing: there is no rate for that cost, and a missing rate is never shown as zero. An empty cell is an
asset without a meter, or a day that has not been reached yet. A shaded cell with `0.0` kWh and a `0.00`
cost, titled "no data", is a day with no data: its zero is not a measurement. The CSV button exports one
row per asset per day (`asset,date,kwh,cost,currency,estimated,partial,no_data`). The asset page shows today's cost next to
today's energy.

**Tariffs** (admin) hold the site currency (one three-letter code for the whole site; when it is unset,
costs show without a unit) and the rates, in that currency per kWh. Changing or clearing the currency
asks for confirmation: it relabels every past figure and converts nothing. A rate is a number of zero or
more with up to six decimals and an effective date (a date in the site timezone). For an asset on a
given day the rate is the latest one effective on or before that day, taken from the nearest asset up
the tree that has its own rates, otherwise from the site default; an override therefore takes over from
its own date. Editing a past rate recalculates history: cost is for visibility, not invoicing. Tariff,
currency and dashboard changes appear in the Audit log.

**The energy engine.** One engine produces every energy figure (asset page, Billing, dashboards), so
they agree. It reads the hourly rollup (`readings_1h`) and works in whole hours; a day or a month is the
sum of its hours in the site timezone. For an asset with an `energy_kwh` counter an hour's energy is the
hour's last counter value minus the previous hour's, the first hour of a period starts from the last
value before it, and a counter reset or rollover is recovered instead of counted as negative or inflated
energy. An asset with only `active_power_kw` gets average power times the time its samples cover, so an
outage adds nothing; such figures are marked `~` (estimated) wherever they appear. A parent asset uses
its own meter if it has one, otherwise the sum of its children; a meter with no readings at all counts
as 0, and an asset with no energy or power mapping anywhere beneath it has no figure.

**How history is calculated.** Billing and dashboards follow the current configuration: past months
are recomputed from today's mappings, scale factors, asset tree, tariffs and site timezone. Re-pointing
a panel to another source, changing a scale or the timezone, moving an asset or deleting one therefore
changes past figures. Deleting an asset that has children, mappings or tariffs, or a source with mapped
points, asks for confirmation and is audited. A parent's own meter counts from its first reading (the
hours before it are the sum of its children, so adding a meter later does not zero the past), and the
estimate for an asset with only a power reading covers the minutes in which it has samples. A day with
no data shows its energy as zero (`0.0` kWh in Billing cells, `0.00` in a widget), muted and titled
"no data" (a rate in effect makes its cost `0.00`, otherwise the cost is a dash). The hourly rollup is
the only permanent copy of this data, so back it up (see "Backup and restore").

Limits: the site timezone must have a whole-hour UTC offset in both January and July (so that day and
month edges fall on hourly buckets); Settings refuses other zones, and Billing and widget data answer 409
if a stored zone breaks the rule. The rollups refresh over the last 7 days, so readings that arrive later
than that are not included in energy figures. One counter reset per hour is recovered exactly; a second
one inside the same hour may understate that hour. Energy estimated from power is an estimate, not a
measurement. The currency is one per site, there are no time-of-use tariffs, and custom metrics cannot be
used in widgets.

## Develop

```bash
cd backend
uv sync
uv run pytest
```

Tests start their own TimescaleDB container, so Docker must be running.

Frontend (needs the stack running for the API):

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, /api proxied to localhost:8000
npm test
npm run typecheck
npm run build      # typecheck + production bundle; the grid and the chart widgets are separate, lazily loaded chunks
npm run e2e        # Playwright; needs a fresh stack and an isolated Compose project, see "End-to-end test"
```

For `npm run dev` to reach the API without Caddy, temporarily publish it:
`docker compose run --rm -p 8000:8000 api` or add `ports: ["8000:8000"]` to a
`compose.override.yaml` (ignored by git).

### End-to-end test

> **Data safety.** `scripts/e2e.sh` and `docker compose down -v` on the normal project delete the
> `dcdash_dbdata` volume: every reading, user, source, tariff and dashboard you have. Never run them
> where that data matters. Run the end-to-end tests only in the isolated Compose project described
> below, which has its own volume.

Three specs run in one `playwright test` run against the dev-profile stack on `http://localhost/`
(`frontend/e2e/playwright.config.ts` runs them in this order; each project depends on the one before):

- `journey.spec.ts` drives a real browser through first-run setup, adding the simulator, mapping two
  points and watching live values.
- `discovery.spec.ts` (after it, at 1600×1000) scans the simulator's network, expands the OPC UA
  source into its ten panel clusters, maps `LVP01` onto an existing asset and `LVP02` onto a new one
  by real mouse drags, creates `LVP03`...`LVP10` through the buttons, then checks through the API that
  all 60 points are mapped (six distinct metrics per asset), that a live value arrives, and that the
  Audit page shows the scope, the scan and ten accepted mappings.
- `phase3.spec.ts` (after it, at 1600×1000) reuses that state. An admin sets the currency, sees a dash
  (not zero) on Billing while no rate exists, adds a site default rate, and checks the current month on
  Billing (a priced panel row, its month total and today's cell, the month CSV with its header and
  byte-order mark) and the cost tile on an asset page. The admin creates an operator and a viewer; the
  operator builds a dashboard with a stat and a bar widget, saves it, reloads and finds both widgets and
  their layout, changes the dashboard range and downloads a widget's CSV; the viewer sees the dashboard
  with no edit controls, no Tariffs link and `403` from the write API; the admin finds the tariff,
  currency and dashboard entries in the Audit log.

It needs a fresh database (setup must still be pending), so the run starts the stack from scratch in a
separate Compose project (its own `dcdash_e2e_dbdata` volume; stop your normal stack first with
`docker compose --profile dev stop`, never with `-v`, because both use ports 80 and 443):

    docker compose -p dcdash_e2e --profile dev down -v --remove-orphans
    docker compose -p dcdash_e2e --profile dev up -d --build
    (cd frontend && npm run e2e)
    docker compose -p dcdash_e2e --profile dev down -v

or, with a fresh stack already running: `cd frontend && npx playwright test -c e2e/playwright.config.ts`.
First time only: `npx playwright install chromium`. Reports: `npx playwright show-report`.

`scripts/e2e.sh` is for a throwaway machine only; it deletes `dcdash_dbdata`.

The isolated `-p dcdash_e2e` run builds the same `dcdash-backend:local` and `dcdash-web:local` images
as the normal stack, so it re-tags them. If your database is still at an older schema, read "Upgrading
an existing database to Phase 3" before you start the normal stack again: because the image tag was
replaced, any later `docker compose up -d` on the normal project (with or without `--build`) creates or
recreates `api`, which then runs the database migrations. Otherwise rebuild your normal stack afterwards
(`docker compose --profile dev up -d --build`) to be sure it runs your own code. Either way, check with
`docker volume ls` that `dcdash_dbdata` is still listed.

### Housekeeping

The collector deletes expired sessions and finished jobs older than 7 days every hour
(`backend/dcdash/collector/housekeeping.py`). "Test all" runs at most 4 connector tests at once.

## Backup and restore

Both scripts talk to the `db` container of the running stack (`.ps1` twins exist for Windows).

    scripts/backup.sh [out_dir]            # ./backups/dcdash-YYYYmmdd-HHMMSS.dump + .version (Alembic revision)
    scripts/restore.sh <dump> [--force]    # stops api+collector, recreates the database, restores, restarts
    scripts/backup_smoke.sh                # backs up, deletes an asset, restores, checks it is back

`restore.sh` refuses (exit 3) when the dump's `.version` differs from the running schema.
`--force` restores anyway; the `api` container then runs `alembic upgrade head` on start, which
brings an older dump up to the current schema. Never force-restore a dump from a *newer* version.

The dump is a full `pg_dump -Fc` wrapped in `timescaledb_pre_restore()` / `timescaledb_post_restore()`,
so hypertables, the 1-minute and 1-hour rollups and their compression and retention policies are
part of the backup and come back with it; nothing has to be re-created by hand. The `pg_dump`
warning about `continuous_agg` circular foreign keys is expected and harmless for a full dump.

## Upgrading an existing database to Phase 3

Phase 3 adds migration `0004` (tariffs, dashboards, widgets, the billing setting and a rebuilt hourly
rollup `readings_1h`). The `api` container runs `alembic upgrade head` every time it starts, so the
first start of an `api` container created from the Phase 3 image applies it to your data: treat
"start the stack on the new code" as "upgrade the database". The upgrade is safe on a normal install
and can be run again after an interruption, but it rebuilds `readings_1h` from `readings_1m`, which is
why the steps below start with a backup. Collection pauses while the migration runs, so readings for that
interval are not collected.

1. **Back up first.** `scripts/backup.sh` needs the `db` container running. If the stack is not running,
   start only the database: `docker compose up -d db` (`db` has no dependencies and uses the TimescaleDB
   image, so `api` is not created and nothing is migrated). Do not use a plain `docker compose up -d`
   yet. Then run `scripts/backup.sh`. Keep both files it writes, the `.dump` and the `.version` file
   (it says `0003`). Restoring with `scripts/restore.sh` is the only way back to the database as it was
   before the upgrade (see "Going back" at the end of this section).
2. **Pre-check.** In `docker compose exec db psql -U dcdash -d dcdash` run:

   ```sql
   SELECT (SELECT min(bucket) FROM readings_1h) AS h,
          (SELECT time_bucket(INTERVAL '1 hour', min(bucket)) FROM readings_1m) AS m;
   ```

   If `h` is earlier than `m` (or `m` is empty while `h` is not), migration 0004 refuses to run (see
   step 4) rather than lose those hours (the 1-minute tier is kept for `rollup_1m_retention_days`, 730
   by default, while the hourly tier is kept forever). Stop and decide before going on. Also run
   `SELECT value FROM settings WHERE key = 'storage';`: a `raw_retention_days` below 8 is raised to 8
   by the migration, and the retention policy is applied again.
3. **Apply.** Only when you mean to upgrade: `docker compose --profile dev up -d --build` (without
   `--profile dev` on a stack that has no simulator). Alembic prints nothing while it migrates, so watch
   `docker compose logs -f api` until Uvicorn's start-up lines appear (`Application startup complete`);
   a migration that fails prints an error instead. Then `docker compose exec api alembic current` must
   print `0004 (head)`. If Compose reports the `api` unhealthy or a dependency failed while the rollup
   was rebuilding, wait for Uvicorn to start and run the same `up -d` again; `web` and `collector` start
   once `api` is healthy.
4. **If something goes wrong.**
   - `tuple concurrently deleted` in the log: a refresh job raced the drop of the view. The container
     restarts and the migration runs again by itself.
   - The log shows `migration 0004 was stopped before it changed anything, because rebuilding the
     hourly rollup (readings_1h) from the 1-minute rollup (readings_1m) would permanently lose hourly
     history`: this is the case from step 2 (`h` earlier than `m`, or `m` empty while `h` is not). Nothing
     was changed, but Compose restarts the `api` in a loop and it stops at the same place every time.
     Run `docker compose stop api`, take a backup (step 1) and report the message.
   - Any other error that repeats: `docker compose stop api` and report the error.
   - Never use `docker compose down -v`: it deletes the database volume.
5. **Verify.**
   - `SELECT version_num FROM alembic_version;` returns `0004`.
   - `\d readings_1h` lists a `minutes` column.
   - `SELECT view_name FROM timescaledb_information.continuous_aggregates;` lists `readings_1m` and
     `readings_1h`.
   - `SELECT key, value FROM settings WHERE key IN ('billing', 'storage');` shows the currency (null
     until you set it) and the storage settings.
   - In the UI, set the currency and the rates on Tariffs. Check that Settings has a timezone with
     whole-hour UTC offsets, or Billing answers 409.
6. **Going back.** Restoring the step 1 dump on the Phase 3 image does not undo the upgrade: its
   `.version` says `0003` while the running schema is `0004`, so `scripts/restore.sh` refuses without
   `--force`, and with `--force` the script restarts the existing `api` and `collector` containers,
   which run migration 0004 again. To really return to Phase 2, restore with the Phase 2 code and images
   and with no Phase 3 container left to be restarted:
   1. `git checkout 855cbf8` (`main` before Phase 3). Afterwards `git checkout phase-3-dashboards-billing`
      returns to the branch; `.env` and `backups/` are not in git, so they stay. This README changes with
      the checkout, so keep these steps at hand.
   2. `docker compose build` builds the Phase 2 images.
   3. `docker compose --profile dev rm --stop --force api collector web simulator` removes the Phase 3
      containers (containers only: never the `dbdata` volume, and `db` is left alone).
   4. `docker compose up -d db` (a no-op when `db` is already running).
   5. `scripts/restore.sh backups/<dump file> --force`. `--force` is needed when the database was
      already migrated to `0004`; it is not when the migration never ran. The script's last step,
      `docker compose start api collector`, finds no containers and prints `collector is missing
      dependency api`, which the script ignores by design.
   6. `docker compose --profile dev up -d` creates fresh Phase 2 containers; on the restored `0003`
      database Alembic has nothing to do.

## Add a connector

Create `backend/dcdash/connectors/<name>.py` with a `Connector` subclass
decorated with `@register`, and import it in
`backend/dcdash/connectors/__init__.py`. See `simulator.py` for a complete
example. Nothing else changes.
