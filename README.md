# DC Dashboard

Collects electrical data from data center systems, organizes it under a
hierarchy you define, and serves live values, history and energy use.

Design: `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md`

Status: Phase 1C. The web UI is served at `http://localhost/`; the API is
proxied at `http://localhost/api` (interactive docs at `/api/docs`). Sources
can be the simulator, OPC UA servers or Modbus TCP devices; readings are kept
in raw, 1-minute and 1-hour tiers (see "Storage tiers").

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
`Asia/Qatar`) so that "today" starts at local midnight.

Later starts need only `docker compose up -d`.

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
- **Settings** (admin): site timezone (IANA name). It decides where "today" starts for energy totals.
  `DCDASH_TIMEZONE` in `.env` only seeds this on first start.
- **Storage** (admin): database and per-tier sizes, compression ratio, rows per day, growth and a
  projected days-until-full figure. Free disk space is not visible from the API container, so disk
  capacity is a setting: set it to the size of the volume holding the database. The page also edits
  raw retention, compression delay, 1-minute rollup retention and the warning threshold.
- **Password** (everyone): change your own password; your other sessions are signed out.

### Protocols

Every connector is read-only toward the source; only `collector` opens connections. A source's
`last_error` reads `<status>: <message>` with status `ok`, `auth_failed`, `timeout`, `unreachable`,
`protocol_error` or `needs_profile`.

**OPC UA** (`opcua`): `endpoint` (`opc.tcp://...`), `security_policy` (`none` or `basic256sha256`),
optional `username` (the password is the source secret), `root_node` (default `i=85`, the Objects
folder; browsing descends from here) and `timeout_seconds`. With `basic256sha256` the collector
signs and encrypts with a client certificate it expects as `dcdash_client_cert.pem` and
`dcdash_client_key.pem` in its working directory.

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
```

For `npm run dev` to reach the API without Caddy, temporarily publish it:
`docker compose run --rm -p 8000:8000 api` or add `ports: ["8000:8000"]` to a
`compose.override.yaml` (ignored by git).

### End-to-end test

`frontend/e2e/journey.spec.ts` drives a real browser through first-run setup, adding the simulator,
mapping two points and watching live values, against the dev-profile stack on `http://localhost/`.
It needs a fresh database (setup must still be pending).

    E2E_I_UNDERSTAND_DATA_LOSS=yes scripts/e2e.sh     # deletes the local dbdata volume, then runs it

or, with a fresh stack already running: `cd frontend && npx playwright test -c e2e/playwright.config.ts`.
First time only: `npx playwright install chromium`. Reports: `npx playwright show-report`.

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

## Add a connector

Create `backend/dcdash/connectors/<name>.py` with a `Connector` subclass
decorated with `@register`, and import it in
`backend/dcdash/connectors/__init__.py`. See `simulator.py` for a complete
example. Nothing else changes.
