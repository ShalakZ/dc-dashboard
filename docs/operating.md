# Operating the stack

This page is for whoever keeps a running install healthy: where the logs are, what to do when a container restarts
forever, how the stack stops, what the health checks mean, what the collector cleans up by itself, and how to get back in when
an account is blocked after wrong passwords. Installing is on [Install and run](install-and-run.md), backups on
[Backup and restore](backup-and-restore.md).

## Debugging on the SCADA workstation

The protocol for connecting to the real SCADA and debugging it by copy-paste (the Diagnostics page, the connection check, the report format, the offline `scripts/collect-diagnostics.ps1` / `scripts/collect-diagnostics.sh`, the simulator fault switches `SIM_FAULT_*` for rehearsing a failure) is in [Field debugging](field-debugging.md). The offline scripts save their files in the git-ignored `logs/` folder of the project, leave routine lines out of the log tails (`-RawLogs` / `--raw-logs` keeps them), compare the Docker clock with the computer's, and the PowerShell script can hide host names, addresses and the user name with `-Mask`.

## Logs

Every container keeps at most 5 log files of 10 MB (50 MB per service, set in `compose.yaml`). The collector logs
`asyncua`, `pymodbus` and `httpx` at WARNING and above only. Read it with `docker compose logs --since 10m collector`.

## If the api or the collector restarts forever

`docker compose ps` shows `api` or `collector` restarting, and `docker compose logs api` ends in `unknown timezone: <name>`: the name in
`DCDASH_TIMEZONE` is not an IANA zone name (a typo, a different case such as `africa/cairo`, or a Windows name such as `Egypt Standard
Time`). Fix the value in `.env` (for example `DCDASH_TIMEZONE=Africa/Cairo`; a `DCDASH_TIMEZONE` variable set in your shell beats `.env`) and run `docker compose up -d`. `scripts/setup.ps1` and
`scripts/setup.sh` refuse such a name before they start anything, so this happens only when `.env` was edited by hand.

## Stopping

The api and the collector stop on SIGTERM instead of waiting out their grace period: usually within a second, and within
about 11 s each when the database does not answer. `web` is the exception while a browser has a page open: Caddy waits
for the page's live stream until Docker kills it at its stop timeout (10 s on a standard Docker engine). With a page
open, the api waits up to 5 s for it (a live dashboard keeps its stream open) before it closes it. The collector writes
its last readings before it exits. If the database is unreachable at that moment, the readings still in memory
(everything collected since the database stopped answering, at most 100,000) are lost, and the collector logs how many.

## Health

`GET /api/health` is a readiness check that needs no login: it answers `{"status":"ok"}` while the database answers a
query, and 503 `{"status":"unavailable","detail":"database unavailable"}` when it does not answer within 2 s (stopped or
frozen). `docker compose ps` shows `healthy` or `unhealthy` for `api`, `web` and `db`; the `web` check confirms that the
UI is baked into the image and that Caddy is running, in HTTP and in HTTPS mode. The collector serves nothing to probe and
has no Docker health status. Compose never restarts an unhealthy container: an `api` that lost its database shows as
`unhealthy` and keeps running until the database is back. The `api` gets 120 s before failed checks count, so a long
database migration does not make `scripts/setup.sh` fail; a migration that takes longer than about 220 s needs
`docker compose up -d` run again, which is safe.

The collector writes a heartbeat to the database every 10 s. `GET /api/collector/status` (needs `sources.view`: operators and admins) says
whether a beat arrived within the last 30 s, measured by the database's clock. The Sources page shows a notice when the
last beat is older than 30 s and, per source, the age of its newest stored reading in the Last reading column
(BAD-quality readings count; a source with no stored reading shows a dash; the age keeps counting after a point is
unmapped, as long as the source is still listed, because a discovered source leaves the list when its last mapped point
is unmapped). No notice is shown when the status cannot be read, for example while the database is down; once the page
has had no answer for 30 s it says "Collector status cannot be read" instead, and the Last reading ages keep counting
from the last answer. After a restore the old heartbeat reads as "silent" until the collector starts.

## Housekeeping

Every hour the collector deletes expired sessions, finished jobs older than 7 days, and diagnostic journal events older than
14 days or beyond the newest 20 000 (`backend/dcdash/collector/housekeeping.py`). The collector runs at most 4 jobs (connection
tests, browses, checks) at once, so "Test all" tests at most 4 sources at a time and queues the rest.

## The figures service

`figures` is a small background service beside `api` and `collector`. It keeps the figures of the current and the recent months ready in
the database table `figure_ledger`, so that Billing and the dashboards do not have to compute them again after an api restart
([The figure ledger](dashboards-and-billing.md#the-figure-ledger)). It writes that table and nothing else: never a reading, a tariff or
a setting.

- **What it does.** Every 30 seconds it looks at the current month (and the previous one during its first week), recomputes what changed
  and stores it. Older months it looks at every 10 minutes, or at once after a configuration change, and it deletes what is no longer
  needed. At 03:00 site time it checks every stored figure against a fresh calculation; a figure that differs is deleted and written to
  the diagnostic journal as `figures.mismatch`.
- **Stopping it is safe.** `docker compose stop figures` makes pages slower after an api restart, never wrong: the api uses a stored
  figure only when it has proof that it is current. `docker compose start figures` brings it back and it refills the table within a minute.
- **Settings.** Put them in `.env` (Compose passes them to the api and the service; run `docker compose up -d` after a change).
  `DCDASH_FIGURE_LEDGER`: `0`, `false`, `off` or `no` (any case) switches the ledger off for the api and the service; anything else,
  also empty, leaves it on. `DCDASH_FIGURE_CACHE=0` switches the whole figure cache off, and the ledger with it (the api stops
  reading the ledger; the `figures` service goes idle only with `DCDASH_FIGURE_LEDGER` off).
  `DCDASH_FIGURES_INTERVAL`: seconds between two rounds, default 30, never below 5. `DCDASH_FIGURES_MONTHS`: how many months it keeps ready, 1 to 24, default 6.
- **Where to look.** `docker compose ps` shows `figures` as `healthy`: it touches a heartbeat file after every figure and every round and
  is called unhealthy when that file is older than 3 minutes. `docker compose logs --tail 80 figures` shows what it did; a quiet log is
  normal, and a problem is named in a warning.
- **The table is derived.** `docker compose exec db psql -U dcdash -d dcdash -c "TRUNCATE figure_ledger"` is always safe (while it waits for its
  lock, cold pages are at most 0.2 s slower); the service refills the table within a minute and the pages are only slower until then.
- **Memory and CPU.** Measured on the pilot hall (217 meters, one site): the `figures` container uses about 120 to 165 MB of memory,
  0 % CPU while nothing changes and about 5 % of one core while readings land every 5 seconds (measured while the backend test suite was
  also running). For comparison, the api used about 120 MB idle and 220 MB under a busy dashboard, and the database 440 to 470 MB. Not
  measured: a site with 2,000 assets. The work grows with the number of meters (about five times at 2,000), so expect roughly five to
  ten times the CPU and memory there; that is an estimate.
- **Database cost.** While readings land, every 30 seconds the service rewrites the current month's rows (the month's day figures,
  about 150 KB at this size, and two small window rows of a few KB) and reads the month's rows to check them. At this size that writes
  several hundred MB of database log a day and takes about a second of database time every 30 seconds; both grow with the number of
  assets. `DCDASH_FIGURES_INTERVAL` is the knob: a longer interval writes less, but a stored row is used only while it is at most 55
  seconds old, and the service refreshes every interval, so a page that has to compute finds a usable row about 55 / interval of the
  time (about 9 times in 10 at 60 seconds, about half at 110 seconds).

The check you can run yourself, and what to paste back to Claude, is in [Field debugging](field-debugging.md#the-figures-check).

## If you are blocked from signing in

After too many wrong passwords for one account from one computer, that account is blocked from that computer and the sign-in page
says `too many failed attempts, try again in about N minutes`. Other accounts are not affected. The block ends by itself. To get in
sooner:

1. **Another admin presses Unblock.** On the Users tab of Users & Roles a blocked account shows `blocked` and an `Unblock <name>` button; it clears
   that account's blocks from every computer. Resetting the account's password or deleting it clears them too.
2. **An admin changes the numbers** on the Settings page, section Sign-in protection: how many failed sign-ins block an account
   (3 to 20, default 5) and for how many minutes (1 to 60, default 5). A change applies to the next sign-in attempt, also to a block
   that is running: a shorter block time ends a block that has already lasted that long.
3. **An admin switches the protection off** (same section, the Sign-in protection switch; it asks for a confirmation). Every block
   ends at once and no account is blocked while it is off. Failed sign-ins are still written to the audit log, and the Argon2
   password check still takes its time on every attempt: off removes the block, not that slowdown. Plainly: while it is off a
   password can be guessed without limit, and only that Argon2 time slows each attempt. It never switches itself back on: an
   administrator must switch it on again, and then failures are counted from zero. The numbers are kept while it is off.
   Switching it off or on is audited as `settings.sign_in_changed`; the row for switching it off also says how many blocks it
   ended (`blocks_ended`).
4. **If every admin is blocked,** run `docker compose restart api`. The blocks are held in the api's memory, so a restart clears
   all of them (the stored numbers and the switch are kept).

On this Docker setup every browser may look like one computer: Docker can present all browser connections to the stack as coming
from the one Compose gateway address, so the wrong passwords typed on one machine can block that account for everyone who signs in
the same way. Browsers on other computers of a network, behind a Linux server, are told apart.

Related: [Field debugging](field-debugging.md), [Backup and restore](backup-and-restore.md), [Install and run](install-and-run.md), [Screens](screens.md).
