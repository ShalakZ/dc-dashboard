# Operating the stack

## Debugging on the SCADA workstation

The protocol for connecting to the real SCADA and debugging it by copy-paste (the Diagnostics page, the connection check, the report format, the offline `scripts/collect-diagnostics.ps1` / `scripts/collect-diagnostics.sh`, the simulator fault switches `SIM_FAULT_*` for rehearsing a failure) is in [docs/field-debugging.md](docs/field-debugging.md). The offline scripts save their files in the git-ignored `logs/` folder of the project, leave routine lines out of the log tails (`-RawLogs` / `--raw-logs` keeps them), compare the Docker clock with the computer's, and the PowerShell script can hide host names, addresses and the user name with `-Mask`.

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

The collector writes a heartbeat to the database every 10 s. `GET /api/collector/status` (operators and admins) says
whether a beat arrived within the last 30 s, measured by the database's clock. The Sources page shows a notice when the
last beat is older than 30 s and, per source, the age of its newest stored reading in the Last reading column
(BAD-quality readings count; a source with no stored reading shows a dash; the age keeps counting after a point is
unmapped, as long as the source is still listed, because a discovered source leaves the list when its last mapped point
is unmapped). No notice is shown when the status cannot be read, for example while the database is down; once the page
has had no answer for 30 s it says "Collector status cannot be read" instead, and the Last reading ages keep counting
from the last answer. After a restore the old heartbeat reads as "silent" until the collector starts.

## Housekeeping

The collector deletes expired sessions and finished jobs older than 7 days every hour
(`backend/dcdash/collector/housekeeping.py`). "Test all" runs at most 4 connector tests at once.

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
