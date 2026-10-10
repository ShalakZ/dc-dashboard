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

(If PowerShell refuses the script, for example because the folder came over a share or a download, run
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1`; see "Backup and restore" for what that does.)

The first run creates `.env` with a database password and an encryption key,
then builds and starts the stack. Keep `.env`: without its key, stored source
credentials cannot be decrypted. Keep a copy of `.env` with every backup (see "What the backup does not contain"). Set `DCDASH_TIMEZONE` in `.env` (for example
`Asia/Qatar`) so that "today" starts at local midnight. The zone must have a whole-hour UTC offset in
both January and July (`Asia/Qatar` and `Europe/London` do, `Asia/Kolkata` does not); see
"Dashboards and billing".

Later starts need only `docker compose up -d`. The exception is a start after you pulled a new
version: starting `api` migrates the database, so read "Upgrading and going back" (and the release
notes it points to) before the first start on a database that already holds data.

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
unset for plain HTTP. `scripts/check_tls.sh` exercises both paths in a throwaway Compose project of its own
(a self-signed certificate in a temporary folder, its own images, `web` published only on `127.0.0.1:18080`
and `127.0.0.1:18443`): it leaves `./certs`, your `.env`, the normal stack and ports 80 and 443 alone. See
"Practise a restore" for the project-name guard it shares with `scripts/backup_smoke.sh`.

Open `http://localhost/`. The first visit asks you to create the admin
account. Then: Sources → Add source → Test → Points → Browse points → Map;
Assets → open the asset to see live and historical values.

To include the SCADA simulator (10 LV panels), add the dev profile:

```bash
scripts/setup.sh --profile dev
uv run --project backend python scripts/smoke.py          # drives http://localhost through Caddy
scripts/check_web.sh                                     # SPA, proxy and SSE route checks
```

The simulator's three protocols are added as sources in the app like any other. Its HTTP source
(type `simulator`, URL `http://simulator:9000`) needs the Secret `sim-key` (the simulator's API key,
`SIM_API_KEY` in `compose.yaml`). Without it, Test shows `auth_failed - credentials rejected` and
marks the source `offline` with that Last error, and Browse fails, so there is nothing to map. The
OPC UA simulator accepts any login (or none) unless `SIM_OPCUA_PASSWORD` is set in `.env`; then it takes
the user `sim` with that password. Modbus needs none.

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
- **Audit** (admin): the read-only audit log, newest first, 50 entries per page. Changes to configuration
  and access are recorded with who did it (the name stays even after the account is deleted), when, and for
  updates the values before and after; sign-in successes, failures and lockouts are recorded too.
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

**Defaults and resets.** Next to Save the Storage page has three buttons. *Set as default* remembers the values in the form as this
site's own default and changes nothing else. *Reset to default* fills the form with that default, or with the factory values (raw 30
days, compress after 7, 1-minute rollups 730, capacity 100 GB, warn at 80 %) when no default was set. *Reset to factory settings*
fills it with the factory values. The two Resets only fill in the form; nothing is saved until you press Save.

**Saving can delete data, so it asks first.** Retention deletes whole chunks (7 days wide for raw readings, 70 days for the 1-minute
rollup), and a save re-applies the policies, which TimescaleDB then runs within about a minute. So `PUT /api/settings/storage` answers
**409** unless the request carries `confirm=true` when the save shortens the raw or the 1-minute retention, or when chunks older than
the new limits exist that no scheduled retention would delete anyway (the state after a restore that paused retention: pressing Save
then deletes them, also with unchanged values). The 409 says how many chunks, which days and how much space they take; the page shows it in a
dialog. The audit row `storage.changed` records the `origin` of the values (`factory`, `site_default` or `manual`, judged by the
saved values) and, for a confirmed save, `confirmed_loss`.

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
8. **Audit log** (Audit, admin). Every change is recorded with the user (name and id, kept on the row,
   so the name stays after the account is deleted) and the time, and an update records the values
   before and after (only the fields that changed; a save that changes nothing writes no row, except a
   storage save, which re-applies the compression and retention policies and is always recorded).
   Audited: users (create, role, active, password reset), your own password changes, first-run
   setup, sign-ins (success, failure, lockout; a wrong current password on a password change counts as
   a failure), the site timezone, the currency, the storage settings (every save, `storage.changed`, whose
   subject carries `origin`, and, for a save that needed confirmation, `confirmed_loss`; remembering a site
   default is `storage.default_set`), assets, mappings,
   sources (create, edit, delete, test, test all, browse), tariffs, dashboards, scopes, scans (start and
   finish) and accepted discoveries. Never recorded: passwords and password hashes, source secrets and
   credentials inside a URL (a marker shows that one was set or changed: `secret: set -> changed`, or
   `config_credentials: unchanged -> changed` when the credentials inside a source's URL changed, also when
   other fields changed in the same edit),
   a sign-in with an unknown username (only that one happened, and from which address), logging out and
   the node positions on the Discovery graph. Failed sign-ins are capped at 30 rows per 5 minutes, then
   counted on the next row (lockouts have their own cap of 30).

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
cost (a dash when no rate applies), titled "no data", is a day with no data: its zero is not a
measurement. The CSV button exports one row per asset per day
(`asset,date,kwh,cost,currency,estimated,partial,no_data`). The asset page shows today's cost next to
today's energy.

**Tariffs** (admin) hold the site currency (one three-letter code for the whole site; when it is unset,
costs show without a unit) and the rates, in that currency per kWh. Changing or clearing the currency
asks for confirmation: it relabels every past figure and converts nothing. A rate is a number of zero or
more with up to six decimals and an effective date (a date in the site timezone). For an asset on a
given day the rate is the latest one effective on or before that day, taken from the nearest asset up
the tree that has its own rates, otherwise from the site default; an override therefore takes over from
its own date. Editing a past rate recalculates history: cost is for visibility, not invoicing. Tariff,
currency and dashboard changes appear in the Audit log; an update shows the values before and after.

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

**Asset names and scales.** Within one parent (the top level counts as one) two assets cannot have the same name; case and spacing do
not make a different name ("Panel A" and " panel  a " are the same). Creating, renaming, moving and Discovery's "new asset" are refused
with a 409 that names the clash. Twins created before the rule stay as they are and can still be edited while their name and parent
stay. A mapping's scale must be above 0 and at most 1e12; a reading that is NaN or infinite is stored with bad quality and never
reaches Billing.

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

> **Data safety.** `docker compose down -v` on the normal project deletes the `dcdash_dbdata` volume:
> every reading, user, source, tariff and dashboard you have. Never run it where that data matters. Run
> the end-to-end tests only in the isolated Compose project described below, which has its own volume;
> `scripts/e2e.sh` does exactly that (it always names the project `dcdash_e2e`, refuses any other name
> and cannot reach `dcdash_dbdata`).

Three specs run in one `playwright test` run against the dev-profile stack on `http://localhost/`
(`frontend/e2e/playwright.config.ts` runs them in this order; each project depends on the one before):

- `journey.spec.ts` drives a real browser through first-run setup, adding the simulator, mapping two
  points and watching live values.
- `discovery.spec.ts` (after it, at 1600×1000) scans the simulator's network, expands the OPC UA
  source into its ten panel clusters, maps `LVP01` onto an existing asset and `LVP02` onto a new one
  by real mouse drags, creates `LVP03`...`LVP10` through the buttons, then checks through the API that
  all 60 points are mapped (six distinct metrics per asset), that a live value arrives, and that the
  audit log holds the scope, the scan and ten accepted mappings (counted through the API, because the
  Audit page shows only the newest 50 rows and every sign-in adds one).
- `phase3.spec.ts` (after it, at 1600×1000) reuses that state. An admin sets the currency, sees a dash
  (not zero) on Billing while no rate exists, adds a site default rate, and checks the current month on
  Billing (a priced panel row, its month total and today's cell, the month CSV with its header and
  byte-order mark) and the cost tile on an asset page. The admin creates an operator and a viewer; the
  operator builds a dashboard with a stat and a bar widget, saves it, reloads and finds both widgets and
  their layout, changes the dashboard range and downloads a widget's CSV; the viewer sees the dashboard
  with no edit controls, no Tariffs link and `403` from the write API; the admin finds the tariff,
  currency and dashboard entries in the audit log (counted through the API as well).

It needs a fresh database (setup must still be pending), so the run starts the stack from scratch in a
separate Compose project (its own `dcdash_e2e_dbdata` volume; stop your normal stack first with
`docker compose --profile dev stop`, never with `-v`, because both use ports 80 and 443):

    docker compose -p dcdash_e2e --profile dev down -v --remove-orphans
    docker compose -p dcdash_e2e --profile dev up -d --build
    (cd frontend && npm run e2e)
    docker compose -p dcdash_e2e --profile dev down -v

or, with a fresh stack already running: `cd frontend && npx playwright test -c e2e/playwright.config.ts`.
First time only: `npx playwright install chromium`. Reports: `npx playwright show-report`.

`scripts/e2e.sh` runs the same steps in one go, always in the project `dcdash_e2e` (so its `down -v`
removes only `dcdash_e2e_dbdata`); only its final `down` has no `-v`. It refuses to start while the
normal stack is running, because both hold ports 80 and 443, and it refuses a project name that does
not start with `dcdash_e2e` (`E2E_COMPOSE_PROJECT` can pick another throwaway name). When it ends it removes the containers but
keeps the volume until the next run, which starts with `down -v`;
`docker compose -p dcdash_e2e --profile dev down -v` removes it right away.

The isolated `-p dcdash_e2e` run builds the same `dcdash-backend:local` and `dcdash-web:local` images
as the normal stack, so it re-tags them. If your database is still at an older schema, read "Upgrading
and going back" before you start the normal stack again: because the image tag was
replaced, any later `docker compose up -d` on the normal project (with or without `--build`) creates or
recreates `api`, which then runs the database migrations. Otherwise rebuild your normal stack afterwards
(`docker compose --profile dev up -d --build`) to be sure it runs your own code. Either way, check with
`docker volume ls` that `dcdash_dbdata` is still listed.

`scripts/check_tls.sh` and `scripts/backup_smoke.sh` are different: each builds images of its own
(`<project>-backend:scratch` and `<project>-web:scratch`, so `dcdash-backend:local` and `dcdash-web:local`
are not re-tagged) and publishes only on `127.0.0.1` (ports 18080 and 18443 by default), so neither takes
ports 80 and 443. They run in a Compose project whose name must start with `dcdash_e2e`, and they delete only
that project's own volume; see "Practise a restore".

### Logs

Every container keeps at most 5 log files of 10 MB (50 MB per service, set in `compose.yaml`). The collector logs
`asyncua`, `pymodbus` and `httpx` at WARNING and above only. Read it with `docker compose logs --since 10m collector`.

### Stopping

The api and the collector stop on SIGTERM instead of waiting out their grace period: usually within a second, and within
about 11 s each when the database does not answer. `web` is the exception while a browser has a page open: Caddy waits
for the page's live stream until Docker kills it at its stop timeout (10 s on a standard Docker engine). With a page
open, the api waits up to 5 s for it (a live dashboard keeps its stream open) before it closes it. The collector writes
its last readings before it exits. If the database is unreachable at that moment, the readings still in memory
(everything collected since the database stopped answering, at most 100,000) are lost, and the collector logs how many.

### Health

`GET /api/health` is a readiness check that needs no login: it answers `{"status":"ok"}` while the database answers a
query, and 503 `{"status":"unavailable","detail":"database unavailable"}` when it does not answer within 2 s (stopped or
frozen). `docker compose ps` shows `healthy` or `unhealthy` for `api`, `web` and `db`; the `web` check confirms that the
UI is baked into the image and that Caddy is running, in HTTP and in HTTPS mode. The collector serves nothing to probe and
has no Docker health status. Compose never restarts an unhealthy container: an `api` that lost its database shows as
`unhealthy` and keeps running until the database is back. The `api` gets 120 s before failed checks count, so a long
database migration does not make `scripts/setup.sh` fail; a migration that takes longer than about 220 s needs
`docker compose up -d` run again, which is safe.

The collector writes a heartbeat to the database every 10 s. `GET /api/collector/status` (operators and admins) says
whether a beat arrived within the last 30 s, measured by the database's clock. The Sources page shows a notice when the
last beat is older than 30 s and, per source, the age of its newest stored reading in the Last reading column
(BAD-quality readings count; a source with no stored reading shows a dash; the age keeps counting after a point is
unmapped, as long as the source is still listed, because a discovered source leaves the list when its last mapped point
is unmapped). No notice is shown when the status cannot be read, for example while the database is down; once the page
has had no answer for 30 s it says "Collector status cannot be read" instead, and the Last reading ages keep counting
from the last answer. After a restore the old heartbeat reads as "silent" until the collector starts.

### Housekeeping

The collector deletes expired sessions and finished jobs older than 7 days every hour
(`backend/dcdash/collector/housekeeping.py`). "Test all" runs at most 4 connector tests at once.

## Backup and restore

Both scripts talk to the `db` container of the running stack (`.ps1` twins exist for Windows).

    scripts/backup.sh [out_dir] [--keep N] [--copy-to DIR]   # ./backups/dcdash-YYYYmmdd-HHMMSS.dump + .dump.version (Alembic revision)
    scripts/restore.sh <dump> [--force] [--apply-retention]  # reads the dump, stops api+collector, recreates the database, restores, restarts

A self-test that runs both in a throwaway Compose project of its own, never in your stack, is
`OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh` (see "Practise a restore").

Windows PowerShell (run them like this):

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1 [Out] [-Keep N] [-CopyTo DIR]
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore.ps1 <dump> [--force] [--apply-retention]

`-ExecutionPolicy Bypass` applies to that one process and changes nothing on the machine. It is there because the default
policy, `RemoteSigned`, refuses a script that came over a share or a download. `-File` (not `-Command`) matters for
`backup.ps1`: Task Scheduler gets exit code 5 only when the script is started with `-File`. `-Keep` also accepts the bash spelling
`--keep 3`; `--copy-to DIR` is refused with exit 2 (the PowerShell parameter is `-CopyTo`).

`restore.sh` prints `restoring into Compose project: <name>` as the first line on stderr; `backup.sh` prints
`backing up Compose project: <name>` and `setup.sh` `starting Compose project: <name>` (the `.ps1` twins print the same lines). The scripts
print the name and then go on without asking, so check it BEFORE you run one: `docker compose config --no-interpolate | grep '^name:'`
(Windows: `| Select-String '^name:'`). A script acts on the project that `COMPOSE_PROJECT_NAME`, `-p` or the `name:` of `compose.yaml`
selects, and the one with your data is `dcdash` unless you changed it.

`backup.sh` writes the dump under a temporary name, reads the whole of it back (`pg_restore -f /dev/null`, because a dump cut off in
its data section still passes a table-of-contents check), reads the schema revision, and only then gives the dump its name and
writes the `.version` file next to it (the Alembic revision, for example `0005`; `backup.sh` ends it with a newline, `backup.ps1` does not, and both restore scripts trim it). A failed, empty or cut-off dump
therefore never replaces or evicts a good backup. After every backup it says that `.env` and `certs/` are not in the dump (see "What the
backup does not contain"). With Docker stopped it cannot reach the database: it prints `pg_dump failed; no backup was made and no old
backup was touched` and exits 1 (read from the script; not tried with Docker stopped).

| Exit | `backup.sh` / `backup.ps1` | `restore.sh` / `restore.ps1` |
|---|---|---|
| 0 | the backup was made (and copied, when `--copy-to` was given) | restored |
| 1 | failed: `pg_dump` failed, the dump was empty or cannot be read back, another backup is running in that folder (one at a time per output folder), or a backup with this timestamp exists. Nothing was created, nothing deleted | the dump file does not exist (`no such dump file`) or cannot be read (cut off, damaged): refused up front, "nothing was changed". Or something failed after `api` and `collector` were stopped but before the dump was loaded (the `DROP`/`CREATE DATABASE` step, say): they are started again, the database may be missing or empty, run the restore again with the same dump. Or the restore failed after the database was replaced: read the messages and the log path it prints (it still runs `timescaledb_post_restore()` and starts `api` and `collector`, so the database may be partly restored) |
| 2 | usage error (`--keep` outside 1 to 99999, an unknown argument, a `%` in the output folder on Windows; PowerShell's own parameter errors, such as a missing value or a duplicate parameter, exit 1 instead) | usage error |
| 3 | - | the dump's `.version` differs from the running schema (needs `--force`) |
| 4 | - | restored, but the retention check failed (see "Retention and a restore") |
| 5 | **the local backup was made but NOT copied**; nothing was rotated | - |

Exit 5 and the copy folder are explained under "Scheduled backups".

`restore.sh` refuses (exit 3) when the dump's `.version` differs from the running schema.
`--force` restores anyway; the `api` container then runs `alembic upgrade head` on start, which
brings an older dump up to the current schema. Never force-restore a dump from a *newer* version: the script does not stop you
(it replaces the database, and the `api` then fails on start with an unknown revision); recover by checking out the newer code, or by
restoring the backup you made first.

`restore.sh` reads the whole dump before it stops or drops anything. A dump that is missing, cut off or damaged is refused with exit 1
and the message `nothing was changed`: the database and the containers are untouched. (The first version of the script dropped the
database first, and the Windows drill showed that a cut-off dump then left the running database empty; this check is the fix, and it
was run for real afterwards, with a dump cut to half its size in bash and one cut to 1,500 bytes in PowerShell.) `restore.sh` keeps `pg_restore`'s messages in
`dcdash-restore-<stamp>.log` under `$TMPDIR` (default `/tmp`); every `restore.ps1` run that gets as far as loading the dump leaves the same kind of log in `%TEMP%`, empty
when nothing went wrong.

A restore takes no lock. Do not start two at once, and do not let a scheduled backup fire while one runs (pause the schedule first):
the second restore's `DROP DATABASE` kills the first one's load, and a backup of a half-restored database passes its checks and counts
toward `--keep`.

The dump is a full `pg_dump -Fc` wrapped in `timescaledb_pre_restore()` / `timescaledb_post_restore()`,
so hypertables, the 1-minute and 1-hour rollups and their compression and retention policies are
part of the backup and come back with it; nothing has to be re-created by hand. The `pg_dump`
warning about `continuous_agg` circular foreign keys is expected and harmless for a full dump.

**Retention and a restore.** The dump contains the retention policies, and a restored policy runs the moment the database starts its
background jobs again, so restoring an old dump used to delete everything older than its retention limits within seconds. Raising the
retention before the restore does not help: the restore brings the old limits back. `restore.sh` and `restore.ps1` now stop that.
After `pg_restore` and before `timescaledb_post_restore()` they print, per table, how many chunks the restored policies would delete
(and the oldest and newest day), and if that is more than none they pause the retention jobs and print `Retention is PAUSED`. While
retention is paused nothing is deleted and the disk is not trimmed either: the Storage page shows a banner, and pressing Save there
starts retention again (the save lists what it would delete and asks first). `--apply-retention` skips the pause, so the data beyond
the limits is deleted as the policies say. Read the printed table before you go back to normal use. If the restore worked but the
retention check itself fails, the scripts pause every retention job anyway (unless `--apply-retention` was given) and exit with code 4; if that pause fails as well they say so (`could not check or pause retention`) and still exit 4, and the restored policies may then delete data older than their limits.

### What the backup does not contain

The dump is the database only. `.env` is not in it, and `.env` holds `DCDASH_SECRET_KEY`, the key that encrypts the
passwords and keys stored for your sources. `certs/` (the HTTPS key and certificate, and an OPC UA client certificate if you
use one) is not in it either. Keep a copy of `.env` and `certs/` with every backup, off the machine. The scripts never copy them, not
even with `--copy-to`; `backup.sh` says so after every backup.

The api checks the key when it starts. It test-decrypts the stored source secrets and, once every one of them decrypts, stores a
fingerprint of `DCDASH_SECRET_KEY` in the database (`settings`, key `secret_key_check`; it cannot be turned back into the key). If some cannot be decrypted,
the api log names the sources, and the Sources page shows a banner to operators and admins until the original `.env` is back or the
secrets are typed in again.

- **Restoring on a new machine:** put that `.env` and `certs/` in place, run `scripts/setup.sh`, then `scripts/restore.sh <dump>`
  (the whole sequence, with the checks, is under "Practise a restore").
- **`.env` lost, dump kept:** the data restores, but every enabled source that has mapped points and a stored secret goes
  `offline` with `stored secret cannot be decrypted` until an admin types its secret in again (Discovery, the source's
  Details, Secret).
- **`.env` lost, database volume still there:** `scripts/setup.sh` refuses to create a new `.env`, because a new password
  cannot open the old volume. Put the original `.env` back. Do not "fix" it with `docker compose down -v`: that deletes the database.
- **`.env` lost, old containers still there:** containers keep the values they were created with.
  `docker ps -a --filter label=com.docker.compose.project=dcdash` lists them (use your
  `COMPOSE_PROJECT_NAME` if set). If `dcdash-api-1` is there,
  `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' dcdash-api-1` prints
  `DCDASH_SECRET_KEY`, `DCDASH_TIMEZONE` and `DCDASH_DATABASE_URL`; the database password is the part
  between `dcdash:` and `@db` (`dcdash-web-1` holds `DCDASH_TLS_*`). Write a new `.env` with
  `DCDASH_DB_PASSWORD=`, `DCDASH_SECRET_KEY=` and `DCDASH_TIMEZONE=`, then run `scripts/setup.sh`:
  everything comes back, source secrets included. The output contains secrets, so do not paste it
  anywhere. Do this before any `docker compose down` or `up`, which remove or recreate those containers.
- **`.env` lost, no copy of it anywhere, no old containers either, database volume still there:** the data
  is still in the volume. Start only the database (`docker compose up -d db`) and run
  `scripts/backup.sh`. Then remove the volume on purpose and start over from the dump:
  `docker compose down` (without `-v`), `docker volume rm` of the project's `dbdata` volume
  (`dcdash_dbdata` unless `COMPOSE_PROJECT_NAME` is set), `scripts/setup.sh`,
  `scripts/restore.sh <dump>`, then type each source's secret in again. Without `.env`, Compose warns
  many times that `DCDASH_DB_PASSWORD` and `DCDASH_SECRET_KEY` are not set and default to a blank
  string. That is expected here: the password is only used to create a new database, and the commands
  still work.

### After a restore

Every collector start, including the one at the end of a restore, rewrites the stored scan network (`collector_networks`)
with the /24 around the collector's own addresses, so the targets pre-filled in a new scope follow this installation, not
the restored data. Check them before the first scan.

### Practise a restore

A backup you have never restored is a guess. Practise the restore before you need it, and again after you change anything about how
backups are made. The sequence for a new machine (or a machine whose stack you have lost):

1. Install Docker (Docker Desktop on Windows) and get the code. Check out the commit the dump was made on, or a later one: the
   dump's `.version` file says which schema it has (see "Upgrading and going back" for what a different schema means).
2. Put the copies of `.env` and `certs/` that you kept with the dump in place (see "What the backup does not contain"; the HTTPS key
   needs the owner and mode from "Optional HTTPS").
3. `scripts/setup.sh` (Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1`). It leaves an existing
   `.env` alone, and refuses to create a new one when the database volume already exists. It prints
   `starting Compose project: <name>`; check the name.
4. `scripts/restore.sh <dump>` (Windows: `scripts\restore.ps1`, started the way "Backup and restore" shows). Check the first line,
   `restoring into Compose project: <name>`. A dump from an older schema needs `--force`; a dump from a newer one must not be restored.
   Read the retention table it prints: if it says `Retention is PAUSED`, decide on the Storage page before you press Save (see
   "Retention and a restore").
5. Check: `docker compose ps` shows `db`, `api` and `web` healthy; `docker compose exec api alembic current` prints the head revision;
   `scripts/check_web.sh` prints four `ok` lines; sign in with the account from the old system; on the Sources page no source says
   `stored secret cannot be decrypted` (it does when `.env` is not the original) and the Last reading ages shrink once the collector
   runs; check the scan targets in a new scope before the first scan (see "After a restore").

What the drills did and did not cover. Run for real, in throwaway Compose projects: on Windows `setup.ps1`, `backup.ps1` (with
`-Keep` and `-CopyTo`), `restore.ps1` and a Task Scheduler task; on Linux `backup.sh` (with `--keep` and `--copy-to`: rotation, the
marker file, every exit 5 case, the usage errors, a second backup at the same time, a dump dated in the future, and the database
stopped), `restore.sh` (with and without `--force`, with `--apply-retention`, with a cut-off dump and with a missing one), both
"going back" options of "Upgrading and going back", and the two self-test scripts below. Not run for real: `setup.sh` (its Windows
twin `setup.ps1` was), Docker Desktop stopped under `backup.ps1`, a cron or Task Scheduler trigger firing by itself, a copy drive
pulled out in the middle of a copy, and a restore on a second machine from a dump and an `.env` that were carried over.

**The self-test.** `OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh` builds a throwaway stack of its own, backs it up,
deletes an asset, checks that a dump with a wrong `.version` is refused (exit 3), restores, checks that the asset is back, and then
checks that a corrupted dump is refused with nothing changed (exit 1, `api` still running). It removes its project and its volume
when it ends (run for real: it ended with `backup smoke OK` and `restore failure-path OK`, and left no container or volume). `scripts/check_tls.sh` is the same kind
of script for HTTPS (see "Optional HTTPS"). Both:

- need a project name that starts with `dcdash_e2e` (`OPS_COMPOSE_PROJECT` picks it; without it `backup_smoke.sh` uses
  `dcdash_e2e_smoke` and `check_tls.sh` uses `dcdash_e2e_tls`) and refuse any other name, so they cannot be pointed at the project with
  your data (`dcdash`, volume `dcdash_dbdata`);
- build images of their own (`<project>-backend:scratch`, `<project>-web:scratch`) and make up a database password and a secret key
  for the run, so `dcdash-backend:local`, `dcdash-web:local` and your `.env` are not used or changed. They remove their containers,
  network and volume when they end but leave those images behind (the drill left three); remove them with
  `docker image rm <project>-backend:scratch <project>-web:scratch` when you do not need the build cache they hold;
- publish what they publish (`check_tls.sh`: the `web` service) only on `127.0.0.1:18080` and `127.0.0.1:18443`
  (`SCRATCH_HTTP_PORT` and `SCRATCH_HTTPS_PORT` change the numbers, from 1024 to 65535), never on ports 80 and 443.

They are bash scripts: on Windows run them from WSL.

## Scheduled backups

Nothing in the stack takes backups by itself. Run `scripts/backup.sh` (or `backup.ps1`) from the machine's scheduler, with a folder
for the local copies, `--keep N` so that the folder does not fill the disk, and `--copy-to` a folder on another drive or share, so
that a lost disk does not take the backups with it.

**Linux (cron).** This is an example: the cron entry itself was not run (the script it calls, with `--keep` and `--copy-to`, was; see
"Practise a restore" for what was proved how). The cron user must be
allowed to run `docker`. cron keeps no exit code, so send the output to a file and look at it (an exit 5 shows as the line
`local backup made, NOT copied; nothing was rotated (exit 5)`):

    0 2 * * * cd /path/to/DC_Dashboard && scripts/backup.sh /var/backups/dcdash --keep 14 --copy-to /mnt/offsite >> "$HOME/dcdash-backup.log" 2>&1

**Windows (Task Scheduler).** A task with this action and principal was registered and started by hand with `Start-ScheduledTask` for
real: it ended with `LastTaskResult` 0, and, with a copy folder that did not exist, with 5. The trigger line is the standard
PowerShell form and was not run:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\DC_Dashboard\scripts\backup.ps1" -Keep 14 -CopyTo D:\backups'
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive   # runs only while this user is logged on
Register-ScheduledTask -TaskName dcdash_backup -Action $action -Trigger $trigger -Principal $principal
(Get-ScheduledTaskInfo -TaskName dcdash_backup).LastTaskResult   # 0 ok, 1 failed, 5 made but not copied
```

- Docker Desktop must be running in that user's session, and the copy drive must be mounted, when the task fires. With Docker not
  running the script exits 1 and makes no backup (see "Backup and restore").
- With `-LogonType Interactive` the task runs only while that user is logged on. After a reboot without a logon, or with the machine
  asleep at the trigger time, it does not run, and `LastTaskResult` keeps the PREVIOUS result: a `0` there can be stale. Read
  `(Get-ScheduledTaskInfo -TaskName dcdash_backup).LastRunTime` as well (or the date of the newest file in the backup folder), and
  consider `New-ScheduledTaskSettingsSet -StartWhenAvailable` on the `Register-ScheduledTask` call so that a missed run starts as
  soon as the machine is back (not tried).
- `-File` (not `-Command`) is what hands exit code 5 to Task Scheduler. `-ExecutionPolicy Bypass` applies to that process only and
  changes nothing on the machine; without it the default policy, `RemoteSigned`, refuses a script that came over a share or a
  download.
- The task's environment has no `COMPOSE_PROJECT_NAME`, so it acts on the Compose project named in the `compose.yaml` next to the
  script it runs, unless a `.env` next to it sets `COMPOSE_PROJECT_NAME` (Compose reads that variable from `.env` too; the drill's
  `.env` did not set it).
- `backup.ps1` leaves a permanent, empty file `.dcdash-backup.lock` in the output folder (the one-backup-at-a-time lock; `backup.sh`
  locks the folder itself, leaves no file, and only warns when `flock` is not installed). Do not delete it while a backup runs. Folders with spaces, `&` and `()` in their
  names work; a `%` in the output folder is refused with exit 2.

**Read the result.** `0` is a backup. `1` is no backup (and nothing was deleted). **`5` means the local backup was made but NOT copied**
and nothing was rotated, anywhere. A task list that only shows that the task ran looks the same for `0` and `5`, so read
`LastTaskResult` (or the cron log) and treat anything but `0` as a failure to be looked at. Even `0` does not prove that old backups
were rotated: the line `not rotating` in the log says rotation was skipped (see `--keep` below). While the copy drive stays absent the
local folder is never rotated, so it grows without limit, and the database volume may be on the same disk: do not leave an exit 5
unanswered.

**`--keep N`** (1 to 99999; without it nothing is ever deleted):

- After a verified new dump it keeps the newest N dated pairs (`dcdash-YYYYmmdd-HHMMSS.dump` and `.dump.version`) in the output
  folder, and in the `--copy-to` folder when there is one, and deletes the older pairs. The new backup is never deleted.
- It never touches other names: a pair you named yourself (`before-upgrade.dump` and `before-upgrade.dump.version`) stays, and so
  does any dump without its `.version`.
- It refuses to rotate a folder that holds a dump dated later than the new one (the clock went back, or a file was misnamed), with a
  message on stderr: rotating oldest-first would otherwise delete the previous nights' backups while the clock is wrong. The exit
  code stays 0. If the clock once jumped FORWARD, the script itself wrote a future-dated dump, and from then on every run prints
  `not rotating` while the folders keep growing, with the clock right again. A monitor that reads only the exit code does not see it:
  look for the `not rotating` line in the log, and move or delete the future-dated file and its `.version` file so that rotation
  can resume.
- A removal that fails is reported on stderr and the exit code stays 0, because the new backup is fine.
- Nothing is rotated when the backup was not copied (exit 5).

**`--copy-to DIR`** copies the dump and its `.version` to `DIR`, under a temporary name first, compares the copy with the original and
only then renames it.

- `DIR` must exist (the script never creates it) and must not be the output folder.
- `DIR` must hold a file `.dcdash-backup-target` whose first line is the Compose project name (CRLF line ends and a byte order mark are
  fine). Create it once on the drive: `echo dcdash > /mnt/offsite/.dcdash-backup-target` in bash, and
  `Set-Content -Encoding ascii D:\backups\.dcdash-backup-target dcdash` in PowerShell (`dcdash` is the name in `compose.yaml`; the
  refusal message for a missing marker prints the exact command for your project). Why: on Linux a mount point with nothing mounted
  is an empty folder on the root disk, which a plain "folder exists" test would accept and then rotate; and a drive set up for
  another installation would be treated as one set.
- One folder per installation. Two installations on one drive need two folders, each with its own marker, and different Compose
  project names. The same goes for the OUTPUT folder: `--keep` counts every dated pair in it, whichever installation wrote it (the
  file names carry no project name), so two installations that back up into the same folder delete each other's backups. Give each
  its own output folder (the cron example below uses one path; change it per installation).
- If the folder is missing, has no marker, names another installation, or is the output folder itself, the local backup is still made
  and verified, nothing is rotated, and the script exits 5.

**What is decided and what is not** (the owner's decision D13). The off-host target is a folder you point `--copy-to` at, for example
a USB drive or a share. The scripts do no file encryption: encrypt the drive or share itself (BitLocker To Go on a Windows edition
that has it; otherwise a password-protected archive made by hand, for example with 7-Zip). That was decided, not drilled. The scripts
never copy `.env` or `certs/`, so you keep those yourself. `.env` holds the key for the stored source secrets, so whoever holds the
dump and `.env` together can read them: keep a copy of `.env` (and `certs/`) off the machine, in a place as well protected as the
backups, and again whenever they change.

After the first night, look at the folder and at `LastTaskResult` (or the cron log), and do one "Practise a restore" with the dump.

## Upgrading and going back

Starting an `api` container from a newer image runs `alembic upgrade head`, which applies the release's migrations to your data: treat
"start the stack on the new code" as "upgrade the database". Do these steps for every upgrade. **Never use `docker compose down -v`**:
it deletes the database volume.

1. **Back up first, and write down where you are.**
   - `scripts/backup.sh --copy-to <folder>` (Windows: `backup.ps1 -CopyTo <folder>`; the folder is explained under "Scheduled
     backups", and plain `scripts/backup.sh` does when you have none). The `db` container must be running.
     If the stack is not running, start only the database with `docker compose up -d db` (`db` has no dependencies and uses the
     TimescaleDB image, so `api` is not created and nothing is migrated). Do not use a plain `docker compose up -d` yet. Keep both
     files the script writes, the `.dump` and the `.version` file.
   - Note the commit you run now (`git rev-parse --short HEAD`) and the revision (`docker compose exec api alembic current`): going
     back needs both.
   - A scheduled `--keep N` deletes dated dumps after N more nights. If you may need this one longer, copy both files of the pair
     under another name (`before-upgrade.dump` and `before-upgrade.dump.version`); `--keep` never touches other names.
   - Keep a copy of `.env` and `certs/` as well (see "What the backup does not contain").
2. **Read the release notes** below, for every release between the one you run and the new one, oldest first: what each changes, which
   pre-checks it names, how to verify it, and whether its downgrade is lossless.
3. **Do the pre-checks the notes name**, and stop if one says to.
4. **Apply.** Get the new code (`git pull`, or check out the commit you want), then `docker compose up -d --build` (add
   `--profile dev` on a stack that has the simulator). Alembic prints nothing while it migrates, so watch
   `docker compose logs -f api` until Uvicorn's start-up lines appear (`Application startup complete`); a migration that fails prints
   an error instead. If Compose reports `api` unhealthy, or a dependency failed, while a long migration was running, wait for Uvicorn
   to start and run the same `up -d` again (it is safe); `web` and `collector` start once `api` is healthy. Collection pauses while
   the migration runs, so readings for that interval are not collected. If your Docker stops with an image tag that "already exists"
   (the drills did not see this: `up -d --build` and `build` ran clean although the backend services share one image tag), run
   `docker compose build api web` and then `docker compose up -d`.
5. **Verify.** `docker compose exec api alembic current` prints the revision the release notes name (for example `0005 (head)`);
   `scripts/check_web.sh` prints four `ok` lines (index, spa fallback, api proxy, stream route); the Sources page shows no collector
   notice and the Last reading ages stay small once the collector runs; then the extra checks of the release notes.
6. **Going back.** The release notes say which of the two ways is open. Two rules hold for both. First, go back to the commit you noted
   in step 1, the code that matches the revision you noted and the dump, and **not further**: the code must know the revision the database ends
   up at, and older code fails on start with an unknown revision. With a database at `0004` or `0005` the Phase 2 code (schema
   `0003`) is not a place to go back to. Second, a restart of the new
   `api` would run `alembic upgrade head` and apply the migration again, so the new `api` must not be running again once the schema is
   back; the orders below make sure of that. Afterwards `git checkout main` (or the branch you came from) returns to the new code;
   `.env` and `backups/` are not in git, so they stay. This README changes with the checkout, so copy these steps somewhere first.
   - **Option a, keep what was collected since the upgrade.** Only when the release notes say that the downgrade of this release is
     lossless. `<previous>` is the revision you noted in step 1, `<old commit>` the commit.
     1. `docker compose stop collector`.
     2. `docker compose exec api alembic downgrade <previous>`.
     3. `docker compose stop api` at once.
     4. `git checkout <old commit>`.
     5. `docker compose up -d --build` (add `--profile dev` on a stack that has the simulator). The new `api` runs
        `alembic upgrade head` on the old code, where `<previous>` is the head: nothing to do.
     6. `docker compose exec api alembic current` prints `<previous> (head)`.
   - **Option b, restore the dump from step 1.** It works for every release, and everything collected since that dump is lost. Do it
     with the old code and with no new container left to be restarted. Restoring the dump on the new image would not undo the
     upgrade: the last step of `restore.sh` starts the existing `api` and `collector` containers, and they run the migration again.
     1. `docker compose --profile dev rm --stop --force api collector web simulator` removes the new containers (containers only:
        never the `dbdata` volume, and `db` is left alone). Do not add `-v`.
     2. `git checkout <old commit>`.
     3. `docker compose build` builds the images of the old code (see step 4 for a tag that "already exists").
     4. `docker compose up -d db` (a no-op when `db` is already running).
     5. `scripts/restore.sh backups/<dump file> --force`. This is the script of the OLD commit you checked out in step 2, not the
        current one: depending on its age it may not print the project line, may not read the dump first and may not pause retention,
        so expect fewer messages than described under "Backup and restore" (the drill of option b ran the old script of `1ef27a2`).
        `--force` is needed when the volume holds a newer revision than the dump's
        `.version` says: without it the script refuses (exit 3). It is not needed when the migration never ran. The script drops and
        recreates the database from the dump (read the retention table it prints). Its last step, `docker compose start api
        collector`, finds no containers and prints `collector is missing dependency api`, which the script ignores by design.
     6. `docker compose --profile dev up -d` creates fresh containers of the old code; on the restored database Alembic has
        nothing to do. `docker compose exec api alembic current` prints the dump's revision.

Both options were run step by step as written, in a throwaway Compose project, on `1ef27a2` (schema `0004`) upgraded to `a6d11e1`
(schema `0005`). Option a was lossless: the asset made and the readings collected after the upgrade were still there, and
`alembic current` printed `0004 (head)`. Option b refused without `--force` (exit 3), restored with it (exit 0,
and the ignored message appeared as described), and lost what came after the dump.

## Release notes

One entry for each release that changes the database: the revision it leads to, what it changes, the pre-checks to run before it,
how to verify it, and whether its downgrade is lossless (which decides whether option a of "Upgrading and going back" is open). Read
the entries of every release you skip over, oldest first. Add the entry of the next release at the end.

### Upgrading an existing database to Phase 3

Schema `0003` to `0004`. Downgrade: **not lossless** (step 6), so go back with option b. (The error messages of migration 0004 call this
entry "Upgrading an existing database to Phase 3" and name its steps 4 and 6; the numbering is kept for that reason.)

Phase 3 adds migration `0004` (tariffs, dashboards, widgets, the billing setting and a rebuilt hourly
rollup `readings_1h`). The `api` container runs `alembic upgrade head` every time it starts, so the
first start of an `api` container created from the Phase 3 image applies it to your data: treat
"start the stack on the new code" as "upgrade the database". The upgrade is safe on a normal install
and can be run again after an interruption, but it rebuilds `readings_1h` from `readings_1m`, which is
why the steps below start with a backup. Collection pauses while the migration runs, so readings for that
interval are not collected.

1. **Back up first**, as in step 1 of "Upgrading and going back" (start only the database when the stack is not running, and note the
   commit you run now). Keep both files the script writes, the `.dump` and the `.version` file (it says `0003`). Restoring with
   `scripts/restore.sh` is the only way back to the database as it was before the upgrade (see step 6).
2. **Pre-check.** In `docker compose exec db psql -U dcdash -d dcdash` run:

   ```sql
   SELECT (SELECT min(bucket) FROM readings_1h) AS h,
          (SELECT time_bucket(INTERVAL '1 hour', min(bucket)) FROM readings_1m) AS m;
   ```

   If `h` is earlier than `m` (or `m` is empty while `h` is not), migration 0004 refuses to run (see
   step 4) rather than lose those hours (the 1-minute tier is kept for `rollup_1m_retention_days`, 730
   by default, while the hourly tier is kept forever). Stop and decide before going on. Also run
   `SELECT value FROM settings WHERE key = 'storage';`: a `raw_retention_days` below 8 is raised to 8
   by the migration, and the retention policy is applied again. **Always run the next query as well,
   whatever `raw_retention_days` says** (it is cheap). The hazard depends on the history, not on today's
   setting: an install that raised its retention within the last 8 days shows 8 or more and can still
   hold minutes whose raw data was already dropped.

   ```sql
   SELECT min(bucket) AS oldest, max(bucket) AS newest, (SELECT min(ts) FROM readings) AS oldest_raw
   FROM readings_1m
   WHERE bucket >= now() - INTERVAL '8 days'
     AND bucket < coalesce((SELECT time_bucket(INTERVAL '1 minute', min(ts)) FROM readings), 'infinity');
   ```

   If it returns rows (`oldest` is not empty), **stop**: the raw retention has already dropped raw data
   that the rollups still hold from the last 8 days. Phase 3 refreshes the rollups over their last 7
   days, which would delete those minutes and then the hours built from them (`readings_1h` is the only
   copy of those). Migration 0004 refuses to run in that state (see step 4). Raise the raw retention
   first (step 4 has the SQL), wait until `newest` + 8 days + 1 minute (the migration's message prints
   that time as well), run the query again (it must return an empty `oldest`), and only then go on with
   step 3.
3. **Apply.** Only when you mean to upgrade: `docker compose --profile dev up -d --build` (without
   `--profile dev` on a stack that has no simulator). Alembic prints nothing while it migrates, so watch
   `docker compose logs -f api` until Uvicorn's start-up lines appear (`Application startup complete`);
   a migration that fails prints an error instead. Then `docker compose exec api alembic current` must
   print the head revision (`0005 (head)` since W1a). If Compose reports the `api` unhealthy or a
   dependency failed while the rollup was rebuilding, wait for Uvicorn to start and run the same
   `up -d` again; `web` and `collector` start once `api` is healthy.
4. **If something goes wrong.**
   - `tuple concurrently deleted` in the log: a refresh job raced the drop of the view. The container
     restarts and the migration runs again by itself.
   - The log shows `migration 0004 was stopped before it changed anything, because rebuilding the
     hourly rollup (readings_1h) from the 1-minute rollup (readings_1m) would permanently lose hourly
     history`: this is the case from step 2 (`h` earlier than `m`, or `m` empty while `h` is not). Nothing
     was changed, but Compose restarts the `api` in a loop and it stops at the same place every time.
     Run `docker compose stop api`, take a backup (step 1) and report the message.
   - The log shows `migration 0004 was stopped before it changed anything, because it widens the refresh
     window of the rollups to 7 days`: this is the second query of step 2 returning a row. Nothing was
     changed (the database is still at `0003`), but Compose restarts the `api` in a loop and it stops at
     the same place every time. Run `docker compose stop api`, then raise the raw retention to at least 8
     days (or to `compress_after_days` + 1 when that is larger) so that no more raw data is dropped:

     ```sql
     UPDATE settings SET value = jsonb_set(value, '{raw_retention_days}', '8') WHERE key = 'storage';
     SELECT remove_retention_policy('readings', if_exists => true);
     SELECT add_retention_policy('readings', INTERVAL '8 days');
     ```

     (`docker compose exec db psql -U dcdash -d dcdash`; the Storage page of the Phase 2 app does the same
     when that app is running.) The rollup rows that lost their raw data stay as they are until the date and
     time that the message prints, when the newest of the affected minutes is more than 8 days old. Until
     then there is no collection and no UI on the Phase 3 images. The database is still at `0003`, so you
     can run Phase 2 meanwhile (the commit you noted in step 1, or the commit on `main` just before Phase 3 was merged): do option b of
     "Upgrading and going back" without its step 5, the restore (nothing was migrated, so there is nothing to restore), raise the retention on Phase 2's Storage page instead of with the SQL
     above, and check out the Phase 3 code again when the date has passed. Then start again
     at step 1 and take a fresh backup: the one from before the wait lacks everything collected since
     (Phase 2 may have run for days), and a restore of it would lose that data. Go on with steps 2 and 3
     after it.
   - Any other error that repeats: `docker compose stop api` and report the error.
   - Never use `docker compose down -v`: it deletes the database volume.
5. **Verify.**
   - `SELECT version_num FROM alembic_version;` returns the head revision of the code you run (`0004` on the Phase 3 release,
     `0005` since W1a).
   - `\d readings_1h` lists a `minutes` column.
   - `SELECT view_name FROM timescaledb_information.continuous_aggregates;` lists `readings_1m` and
     `readings_1h`.
   - `SELECT key, value FROM settings WHERE key IN ('billing', 'storage');` shows the currency (null
     until you set it) and the storage settings.
   - In the UI, set the currency and the rates on Tariffs. Check that Settings has a timezone with
     whole-hour UTC offsets, or Billing answers 409.
6. **Going back.** The `0004` downgrade is not lossless, so option a of "Upgrading and going back" is not open for this release. Do not
   run `alembic downgrade`: it rebuilds the hourly rollup from the minutes again and
   refuses (leaving the database as it is) when that would lose hourly history older than the 1-minute
   tier. Restoring the step 1 dump on the Phase 3 image does not undo the upgrade: its
   `.version` says `0003` while the running schema is `0004`, so `scripts/restore.sh` refuses without
   `--force`, and with `--force` the script restarts the existing `api` and `collector` containers,
   which run migration 0004 again. To really return to Phase 2, use option b of "Upgrading and going back": restore the step 1
   dump with the Phase 2 code and images and with no Phase 3 container left to be restarted. The Phase 2 code is the commit you noted
   in step 1; if you upgraded before this README asked for the note, it is the commit on `main` just before Phase 3 was merged.
   `--force` is needed when the database was already migrated to `0004`; it is not when the migration never ran. The script's last
   step, `docker compose start api collector`, finds no containers and prints `collector is missing dependency api`, which the script
   ignores by design. Afterwards check out the branch you came from to return to the Phase 3 code; `.env` and `backups/` are not in
   git, so they stay.

### Upgrading to W1a (migration 0005)

Schema `0004` to `0005`. Downgrade: **lossless** for every audit entry whose user still exists, so option a is open. The code to go
back to is `1ef27a2` (`main` before W1a).

W1a (the audit foundation) adds migration `0005`: two columns (`actor_id`, `actor_name`) on `audit_log`, a
backfill that copies the name of each existing entry's user into them, and a trigger that fills them on every
new entry, so an entry keeps who did it after the account is gone. It runs in a moment and needs no pre-check.
The `api` container applies it the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0004`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator).
3. **Verify.** `docker compose exec api alembic current` prints `0005 (head)`.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0004` and `<old commit>` = `1ef27a2`. Do
   not use step 6 of the Phase 3 entry above for this: it returns to Phase 2 (schema `0003`), which is not a place to go back to from
   a `0004` or `0005` database (Alembic fails with an unknown revision). In both options a restart of the W1a `api` would run
   `alembic upgrade head` and apply `0005` again, so the W1a `api` must not be running again once the schema is back at `0004`.
   - **Option a, keep what was collected since the upgrade.** The `0005` downgrade drops the trigger, its function and the two snapshot
     columns, and `upgrade` rebuilds them from the users. That loses nothing for an entry whose user still exists; the names of
     users deleted after `0005` was applied are lost.
   - **Option b, restore the backup from step 1.** Everything collected since that backup is lost. The restore script is the one of
     the old commit (see step 5 of option b in "Upgrading and going back"). `--force` is needed: the volume
     still holds the W1a database (`0005`) and the dump's `.version` says `0004`, so the script refuses without it.

## Add a connector

Create `backend/dcdash/connectors/<name>.py` with a `Connector` subclass
decorated with `@register`, and import it in
`backend/dcdash/connectors/__init__.py`. See `simulator.py` for a complete
example. Nothing else changes.
