# Spike D12: does the TimescaleDB Windows build support what the app uses?

Run on 2026-10-10 on the dev machine (Windows, Docker Desktop, WSL2), as W2 Task 7. Question from the offline-deployment plan (backlog section D,
route A: native PostgreSQL + TimescaleDB on a Windows workstation without Docker): does the Windows zip of the pinned TimescaleDB version offer
compression, continuous aggregates and policies, and does the app's own backup restore into it?

## Verdict

**Route A is viable on the TimescaleDB side: yes.** The Windows build of TimescaleDB 2.30.2 for PostgreSQL 16 restored a real dev backup of the app with the
repository's own restore sequence and ran everything the app uses (compression, the 1-minute continuous aggregate, and the background policy jobs),
under the license `timescale` (the Timescale License, the one that carries compression and continuous aggregates; not the Apache-only build; the license of the Docker image was not compared). What this spike did not test is
listed under "Not proved" below.

## What was used

| Item | Value |
|---|---|
| TimescaleDB | `timescaledb-postgresql-16-windows-amd64.zip`, GitHub release 2.30.2, 8,630,280 bytes, SHA-256 `9b0d72134c98a92e1ed1ce0cd06cf7611bb48fe9ce6979516cbf889b5decdc05` (verified) |
| PostgreSQL | `postgresql-16.15-1-windows-x64-binaries.zip` from `get.enterprisedb.com`, 332,441,502 bytes (only `bin`, `lib` and `share` were unpacked) |
| Data | the dev backup taken at the start of W2 Task 4: schema `0005`, 7 assets, 157,250 readings, 18,893 one-minute rows, 1 raw chunk |
| Where | `%USERPROFILE%\dcdash-w2-spike\` (deleted afterwards), PostgreSQL started by hand with `pg_ctl` on `127.0.0.1:15432` (loopback only, no firewall prompt), `initdb -U dcdash -A trust -E UTF8 --locale=C` |

## How it was installed (no installer)

1. Unzip both archives (the archive listing was read first: the TimescaleDB zip holds `setup.exe`, `timescaledb-tune.exe`, three DLLs, `timescaledb.control` and the `timescaledb--*.sql` scripts; the PostgreSQL zip has no installer).
2. Copy by hand: `timescaledb.dll`, `timescaledb-2.30.2.dll`, `timescaledb-tsl-2.30.2.dll` into `pgsql\lib`; `timescaledb.control` and the `timescaledb--*.sql` files into `pgsql\share\extension`. **`setup.exe` and `timescaledb-tune.exe` were never run.**
3. `postgresql.conf`: `shared_preload_libraries = 'timescaledb'`, `port = 15432`, `listen_addresses = '127.0.0.1'`, `timescaledb.telemetry_level = off`.
4. `postgres.exe` started without installing the Visual C++ Redistributable (the machine may already have it: not checked; the zip does not bundle one).

## Results

| Check | Result |
|---|---|
| `SHOW timescaledb.license;` | `timescale` |
| extension version / server | `2.30.2` / PostgreSQL `16.15` |
| restore, the repo's sequence: `CREATE EXTENSION timescaledb; SELECT timescaledb_pre_restore();` `pg_restore --no-owner` `SELECT timescaledb_post_restore();` | `pg_restore` exit 0, no stderr output; all counts above came back, `alembic_version` = `0005` |
| `compress_chunk` on the `readings` chunk | worked (`compression_enabled` was `t` after the restore); the 157,250 rows stayed readable |
| `CALL refresh_continuous_aggregate('readings_1m', NULL, NULL)` | exit 0, 18,893 rows |
| policy job run: `alter_job(job_id, next_start => now())` on `policy_compression`, 25 s later | `last_run_status=Success`, 2 runs, 2 successes; the refresh and retention jobs also show `Success` |
| `SHOW timescaledb.max_background_workers` | `16` (with PostgreSQL's default `max_worker_processes = 8`); no worker-shortage warning in the log of this run |
| server log | only two `terminating background worker ... due to administrator command` lines, which `timescaledb_pre_restore()` causes on purpose |

## Not proved (needs the workstation or a later task)

- Running PostgreSQL as a Windows service and the NSSM services for the app (only a hand-started server was tried).
- The Visual C++ runtime on a clean workstation, and the sizing of `max_worker_processes` against `max_background_workers` (what `timescaledb-tune` would set; it was not run).
- The app's Python side on Windows (wheelhouse, `psycopg`, the collector) and `caddy.exe`: not part of this spike.
- Restoring a dump made by the Windows `pg_dump.exe` into the Docker image (only the direction Docker dump to Windows server was tried). Locale `C` was used; a workstation locale with a different collation was not tried.

## Side facts

- `pg_ctl start` inside a PowerShell pipeline (`| Select-Object`) never returns, because the server process inherits the pipe; start it without a pipe or with `Start-Process`.
- This Windows machine already runs PostgreSQL 17 as the service `postgresql-x64-17` (automatic start); the spike used port 15432 and its own data folder and left that service alone. Anyone doing route A on a machine like that needs a free port and a separate service name.
- Cleanup was checked: the server stopped, port 15432 free, the spike folder deleted, no new service, scheduled task, firewall rule or PATH entry, execution policy unchanged (`CurrentUser` = `RemoteSigned`).
