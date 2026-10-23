# Operating the stack

This page is for whoever keeps a running install healthy: where the logs are, what to do when a container restarts
forever, how the stack stops, what the health checks mean, what the collector cleans up by itself, how it fills the holes an outage leaves, and how to get back in when
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

`GET /api/health/data` is a second check, for the freshness of the data, meant for a monitoring tool: [Watching the data from
outside](#watching-the-data-from-outside). The top bar's chip follows the same rule for stale meters: it counts billing meters that have
stopped giving good readings; before w35 it only asked whether any reading at all was recent, so one dead meter among many never showed.
Its plain `Stale` word (no meter is counted, but no mapped point has a reading from the last minute or so) still uses that older
60-second any-reading rule, so the chip can read `Stale` while the URL still answers 200 for up to about 4 minutes, until the 5-minute
floor has passed.

## Watching the data from outside

`GET /api/health/data` answers one question: are the billing meters still reporting? A **billing meter** is what an asset's figures are
built from: its energy counter (`energy_kwh`), else its power meter (`active_power_kw`), on an enabled source that the collector polls (a
`file` source is never polled). Like `GET /api/health` the URL needs no sign-in, and it names nothing: no meter, source, address or
value, only counts.

```bash
curl -s -o /dev/null -w '%{http_code}' https://<host>/api/health/data
```

- **200** means the billing meters report. It is also 200 for a site with no billing meter yet (`"status":"no_meters"`), for a meter that
  has been mapped but not read yet (`waiting`) and for a counter that has not risen for hours (`not_advancing`: a quiet circuit may
  truly stand still, so that is a warning on the screens and not a failure here).
- **503** means one of three things: at least one billing meter has had no good reading for its allowed time (`"status":"stale"`); a
  whole source stands still, all its counters and its other points (`frozen_sources`, see below); or the answer could not be had in
  time, because the database did not answer within 2 seconds or the query for the meters failed (the body is then only
  `{"status":"unavailable"}`, and a failed answer is reused for 5 seconds).

Use **GET**: the route answers 405 to HEAD and to POST. Some uptime monitors probe with HEAD by default; set the check to GET, or it reads a
permanent "down".

The body of a 200 or of a stale 503 holds these fields:

| Field | Meaning |
|---|---|
| `status` | `ok`, `stale`, `no_meters` or `unavailable` |
| `meters` | how many billing meters there are |
| `waiting` | of them, mapped and not read yet (never counted as stale) |
| `stale` | meters with no good reading for too long, plus the counters of a frozen source |
| `not_advancing` | energy counters that have not risen for the set hours (a warning; not part of `stale`) |
| `frozen_sources` | sources whose counters and other points all stand still |
| `oldest_stale_age_seconds` | how long the longest-silent stale meter has been silent; `null` when none, or when it is not known |
| `collector_alive` | whether the collector's heartbeat is recent; told only, never a 503 by itself (see below) |
| `rollups_late` | a refresh of the long-range rollups is late, so charts over long ranges lag; told only, never a 503 |

**A collector that never ran.** Stale meters show a stopped collector soon enough only once the meters have been read at least once. If
the collector has never run (a new install, or a crash loop before the first reading), every meter is only `waiting`: the chip says
`Collector offline`, but `GET /api/health/data` answers 200 `ok` with `waiting` greater than 0 and `collector_alive` false. A monitor
that wants to alarm on that case reads the body (`collector_alive`, `waiting`), not just the status code.

**How to watch it.** Poll it every 1 to 5 minutes and raise the alarm after 2 failures in a row (a 503, a 401, or no answer). The answer
is reused for 5 seconds, so a monitor does not load the database. A refused connection or a timeout is the monitor's own alarm: the host
or the `api` is down, and only a monitor outside the stack can tell. A watchdog inside the thing that dies dies with it. Alone, the
platform shows the problem to whoever looks (the top bar, [Sources and System events](screens.md#operate)); only an outside monitor tells
someone who is not looking.

**A token, if you want one.** Put `DCDASH_HEALTH_TOKEN=<a long random string>` in `.env` and run `docker compose up -d`. The URL then
answers only to the header below; a missing or wrong token is a 401 with the body `{}` and the header `WWW-Authenticate: Bearer`, and a
token in the address is never read. A blank value means no token.

```bash
curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer <token>' https://<host>/api/health/data
```

With HTTPS set up, port 80 redirects to `https://`
([Optional HTTPS](install-and-run.md#optional-https)); a monitor must follow the redirect or, better, use `https://` from the start. With
a token set, always point it at `https://`, so that the header never crosses port 80 in the clear. Without HTTPS the token travels as
plain text, like every other request to the stack.

**Never make it a container healthcheck** (or a `depends_on` condition). One stale meter would make that container unhealthy and hold
back every service that waits for it, so `docker compose up -d` (and with it `scripts/setup.sh`) could stop on a counter, which a
restart cannot fix. The stack's own checks stay `GET /api/health`.

### When a meter counts as stale

The numbers are set in Storage, card **Data watchdog** ([Storage](storage.md#the-data-watchdog)); the factory values are 5 minutes and 6 hours.

- **Stale.** A billing meter is stale when it has had no good reading for longer than three of its own polls or the floor, whichever is
  longer. The floor is 5 minutes (2 to 60). A reading is good when its quality is good and it has a value. A bad reading does not
  refresh a meter, although it does refresh the **Last reading** age on the Sources page, which counts every reading: a row can show
  `12 s ago` and `3 of 8 meters stale` together. A meter that has rows but never a good one is stale at once.
- **Waiting.** A mapped meter with no reading at all yet is waiting, not stale, so a new mapping does not raise an alarm before its first
  poll. The exception is a source that has been offline (an open `source.offline` problem) for longer than the meter's limit. The
  other side of the same rule: a source that is switched on again, or a point that is mapped again, counts as stale until its first
  poll (about one connection attempt), because its old reading is still stored with its old age; the monitor pages only after 2
  failures in a row, so a short window like that does not page.
- **Not rising.** An energy counter whose value has not changed for 6 hours (1 to 72) is flagged as not rising. This is a warning. A
  counter on a circuit that carries no load is left alone: its asset's power meter, if fresh, reads 0.05 kW or less, and a circuit
  like that may truly stand still. Near very large counter values a small load moves a 32-bit counter only once in many hours, so a
  6-hour setting can flag and clear such a counter again and again: raise the hours, or accept the warning.
- **Frozen.** A source is frozen when at least two of its counters (not stale, not waiting, not on a circuit without load) are all
  not rising, and at least one other mapped point of the source (voltage, current, power) still reads good and none of them has changed
  for that time either. A server that keeps answering with old values looks like this. A frozen source counts as stale: its counters are
  added to `stale`. A single counter that stands still, or a source whose other points still move, stays a warning; a source with no
  other point that reads good is never called frozen.

The incident in System events ([Screens](screens.md#operate)) opens about one to three minutes after a meter turns stale: the figures
service looks about once a minute and opens it on the second look in a row, so a blip of a minute leaves no trace.

## Housekeeping

Every hour the collector deletes expired sessions, finished jobs older than 7 days, and diagnostic journal events (the System events
page) older than the Storage page's limit or beyond the newest rows it allows, by default 90 days or the newest 100 000
(`backend/dcdash/collector/housekeeping.py`; [Storage](storage.md#how-long-system-events-are-kept)). A problem that is still open is never
deleted, and a closed one is kept until its closing is older than the limit. The collector runs at most 4 jobs (connection
tests, browses, checks) at once, so "Test all" tests at most 4 sources at a time and queues the rest.

## The figures service

`figures` is a small background service beside `api` and `collector`. It keeps the figures of the current and the recent months ready in
the database table `figure_ledger`, so that Billing and the dashboards do not have to compute them again after an api restart
([The figure ledger](dashboards-and-billing.md#the-figure-ledger)). It writes that table, and since w35 the `data.stale` and
`data.recovered` entries of the System events journal (below), and nothing else: never a reading, a tariff or a setting.

- **What it does.** Every 30 seconds it looks at the current month (and the previous one during its first week), recomputes what changed
  and stores it. Older months it looks at every 10 minutes, or at once after a configuration change, and it deletes what is no longer
  needed. At 03:00 site time it checks every stored figure against a fresh calculation; a figure that differs is deleted and written to
  the diagnostic journal as `figures.mismatch`.
- **Stopping it is safe.** `docker compose stop figures` makes pages slower after an api restart, never wrong: the api uses a stored
  figure only when it has proof that it is current. `docker compose start figures` brings it back and it refills the table within a minute.
  Stopping it also stops the `data.stale` incidents of System events: they open and close in this process, so while it is stopped
  none opens, grows or closes. The top bar, the Sources line and `GET /api/health/data` stay true, because the rule is worked out
  every time they are read ([Watching the data from outside](#watching-the-data-from-outside)).
- **The stale-meter check.** About once a minute the service that holds the work lock looks at the billing meters and keeps one `data.stale`
  incident per source in System events: it opens on the second look in a row that finds trouble, and when the meters report again it
  closes with one `data.recovered` line. A source that is switched off or deleted while its incident is open, or one that is still polled
  but loses its last billing meter (its points unmapped), closes it as "stopped being read". This check does not depend on the ledger: with `DCDASH_FIGURE_LEDGER=0` the service still runs it (and takes the work lock for
  it), and only the figures work is skipped.
- **Settings.** Put them in `.env` (Compose passes them to the api and the service; run `docker compose up -d` after a change).
  `DCDASH_FIGURE_LEDGER`: `0`, `false`, `off` or `no` (any case) switches the ledger off for the api and the service; anything else,
  also empty, leaves it on. `DCDASH_FIGURE_CACHE=0` switches the whole figure cache off, and the ledger with it (the api stops
  reading the ledger; the `figures` service skips its figures work only with `DCDASH_FIGURE_LEDGER` off, and still runs the stale-meter
  check below).
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

## Background history fill

The collector runs one more loop, beside the polls and the housekeeping: every 10 minutes it asks each enabled source that can read
history for the readings it missed (an outage, values the source stored late). What it fills, what it never fills and how politely it
asks are on [Sources and discovery](sources-and-discovery.md#history-and-backfill). Today only a source of type `simulator` that points
at the stand-in Historian (dev profile) can answer; for every other source the loop does nothing.

- **Settings.** Put them in `.env` (Compose passes them to the api, the collector and the figures service; an empty or missing value
  means the default; run `docker compose up -d` after a change).

  | Variable | Default | Meaning |
  |---|---|---|
  | `DCDASH_HISTORY_EVERY` | `600` | seconds between two cycles; `0` (or less) switches the loop off |
  | `DCDASH_HISTORY_MAX_ROWS` | `20000` | rows expected in one request (at least 100); a longer window is cut into several requests |
  | `DCDASH_HISTORY_RATE` | `30` | requests a minute to one source (at least 1) |
  | `DCDASH_HISTORY_LOOKBACK_DAYS` | `7` | how far back an automatic fill goes (at least 1); never further than two days inside the raw retention |
  | `DCDASH_HISTORY_REREAD_HOURS` | `3` | how old an hour must be before it is asked a second time for late values (0 or more) |

  A value that is not a number, or is below its minimum, is refused with a sentence that names the variable, and the loop stays off: the
  collector logs `the history backfill is off: DCDASH_HISTORY_RATE must be a whole number, not 'abc'.` once, at start
  (`docker compose logs --tail 80 collector`). The rest of the collector keeps running.
- **When it starts.** The loop waits one full cycle after the collector starts, so a restart does not start every fill at once. The
  totals in the status count since that start. A cycle that a stop cut off is not resumed; the next cycle continues from the saved mark.
- **Switching it off is safe.** `DCDASH_HISTORY_EVERY=0` stops new fills and keeps every mark (a state `filling` that a crash left
  behind is put back to `idle` at start, also then). When you switch it on again, the first cycle fills what is missing, up to the
  lookback.
- **A few minutes behind now.** The automatic fill asks up to one mapping interval and a minute before now (the longest interval of the
  source's mapped points), so the live poll stores its own sample of the newest minutes first. `answered_through` therefore shows a
  time a few minutes in the past (2 minutes for a 1-minute mapping, 6 for a 5-minute one): that is normal, not a lag. In the newest
  window a batch is asked at most five further pages per cycle and the rest is asked in the next cycle, so a source that lags and is
  dense can trail by up to a slice and then catches up; nothing is lost.
- **One run per source.** A cycle takes a lock on the source for as long as it works on it. A second collector, or the fill command
  ([Field debugging](field-debugging.md#history-fill)), finds the lock taken: the loop skips that source for that cycle, and the
  command refuses with a sentence and does nothing. A fill a person starts from the Sources page (**Fill older range...**) runs in the
  collector as a job, and a collector restart fails a running one; start it again and it adds only what is missing.
- **Where to look.**
  - The `history:` line of the source in SOURCE HEALTH of the Diagnostics report, and `GET /api/sources/{id}/history` (permission
    `sources.view`), say the state (`idle`, `filling`, `backing_off` or `not_supported`), how far the source has been answered, the
    totals since the collector started, the next try and the last error.
  - The journal (the JOURNAL section of the report) has `history.filled` (a cycle or a fill stored new readings),
    `history.failed` (a source could not be read; written when the trouble begins and then at most every 15 minutes, with a code
    such as `auth_failed`, `not_supported`, `pending_drop`, `owed_range_dropped` or `set_aside`), `history.closed_month` (new readings landed in a month
    that is closed) and `readings.conflict` (the same reading arrived again with another value; the stored value was kept).
- **A source waiting.** `backing_off` with a `next_try_at` is normal after trouble: the loop leaves the source alone until then (4, 8,
  then 15 minutes after a failed cycle, 15 minutes after refused credentials, a day after "no history here"). Fixing the cause does
  not shorten the wait; the fill command ignores it.

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
