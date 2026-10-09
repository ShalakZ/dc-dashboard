# Manual test notes (section by section)

Owner-led acceptance pass over the whole DC Dashboard, one section at a time (two sections only when a
section needs the other). For each section: what to test, the expected behaviour, then what the owner
saw. Anything that feels off is logged here as a finding. When every section is done, the findings
become a plan.

Status legend: `todo`, `testing` (in progress), `done` (all items checked, findings logged).

## Section map (suggested order: each section needs the ones above it)

| # | Section | Needs | Status |
|---|---|---|---|
| 1 | Getting in and who can do what: sign-in, sign-out, Password, Users, roles | - | done (all 10 items matched; 2 ideas logged) |
| 2 | Settings: site timezone (it decides where a day and a month start) | 1 | done (all 9 items matched; zone left at Asia/Qatar; 1 ux note from Claude) |
| 3 | First run and Sources: create the admin, add and test sources, secrets, failures | 1 | done (rows 1-12 matched after fixing my script; 2 findings from the owner and Claude) |
| 4 | Assets and mapping: the tree, Browse points, Map, live and historical values, deleting | 3 | done (10 mappings in place; 9 findings S4-1..S4-9) |
| 5 | Tariffs: currency, site default rate, per-asset overrides | 4 | done (all rows matched; 1 ux finding) |
| 6 | Billing: month grid, marks, totals, CSV | 4, 5 | done (tested briefly by the owner, no defects; 1 open decision, S6-1) |
| 7 | Dashboards, part 1, building: create, widget dialog, drag and resize, Save, rename, conflicts (it also builds the dashboard that part 2 views) | 4, 5 | done (5 findings S7-1..S7-5; rows 10-13 confirmed by the owner afterwards) |
| 8 | Dashboards, part 2, using: widgets, ranges, live values, per-widget CSV | 7 | done (all 12 rows passed, no new findings) |
| 9 | Storage: sizes, tiers, retention settings | 4 | done (the rest good; findings S9-1..S9-5, incl. recommended enterprise defaults) |
| 10 | Audit: what is logged and who can see it | 1 and the others | done (log works; 7 findings S10-1..S10-7, plus S2-2 found by the inventory) |
| 11 | Scans and Discovery: find sources on the network, map by drag and drop (moved late: it adds assets and sources on top of the clean data) | 3, 4 | done (owner: works great; rows not reported one by one; 4 ideas S11-1..S11-4) |
| 12 | Operations: backup and restore, upgrade runbook, setup scripts, TLS, offline | - | done (Claude ran the checks in four throwaway Compose projects; 14 findings S12-1..S12-14; offline bundle facts below) |
| 13 | Cross-cutting: roles on every screen, phone width, keyboard use | all | testing (Claude's measured pre-checks logged as S13-1..S13-13; the owner's pass by eye is pending) |

(Order changed on 2026-10-09: the original section 5, Scans and Discovery, became 11, and every later
section moved up by one. Finding ids S1-S4 refer to the numbering at the time they were logged.)

## Findings log

Format: `S<section>-<n> [severity] what I did, what I expected, what happened`. Severity: `bug` (wrong
behaviour), `ux` (works but confusing), `idea` (a wish), `question` (I do not understand it).

### Section 1: Getting in and who can do what (done)

- **S1-1 [idea] (owner)** The sign-in block timer should be configurable by an admin in Settings.
  Today it is fixed in code: 5 failed sign-ins for one `host:username` inside a sliding 5-minute window
  block that pair until the window empties (`LoginLimiter(max_failures=5, window_seconds=300)` in
  `backend/dcdash/api/security.py`). The counter lives in memory, so restarting the `api` container
  clears it. To design later: an admin sets the number of failures and the block time in Settings (stored
  in the `settings` table, applied without a restart), and whether an admin can clear a block from the UI.
- **S1-2 [idea] (owner)** An admin should be able to delete accounts; today the Users page can only
  deactivate. To design later: what happens to the audit entries that name the user (keep the name, or
  anonymise), refuse deleting yourself and the last active admin, remove the user's sessions, ask for
  confirmation like the asset and source deletes do, and write an audit entry (`user.deleted`).

### Section 13: Cross-cutting: roles, phone width, keyboard (testing; Claude's pre-checks are below, the owner's pass is pending)

Before writing the owner's script, Claude measured what can be measured, on a scratch copy (throwaway project, the dev
data restored, three test users `t_admin`, `t_op`, `t_view` inserted with the app's own hasher; removed afterwards).
A read-only Sonnet subagent surveyed the code first (role matrix, mobile CSS, keyboard code); its claims were
spot-checked against `App.tsx`, `app.css`, `SourcePointsPage.tsx` and then replaced by measurements where possible.

- **Roles, backend:** every route (61) was called as anonymous, viewer, operator and admin (244 calls, invalid bodies or
  non-existent ids so nothing changed): no mismatch with the gate table of the code. A demotion applies on the very next
  request (POST dashboards 422, then 403; `/api/me` shows the new role at once); a deactivated user gets 401 at once.
- **Phone width**, headless Chromium at 360x800, per role and page (script and PNGs in the session scratchpad, not in the
  repo): see S13-1..S13-3. Content that fits: Assets, Asset page, Dashboards list, Dashboard viewer (stacks), Billing (scrolls
  inside its own box), Settings, Tariffs (not in edit mode), Storage, Password.
- **Keyboard**, real browser: Tab presses before the page content: viewer 6, operator 9, admin 14 (no skip link). The New
  dashboard dialog puts focus in the first field, Tab cycles input, select, Cancel, then the browser UI, then the input again;
  Escape closes it and focus returns to the button that opened it. Deleting an asset first uses the browser's own
  `window.confirm`; the app's modal appears only for an asset with dependents.

- **S13-1 [bug, high for phones] (Claude, measured)** The nav bar never wraps or collapses (`app.css:4`, no flex-wrap, no
  menu). At 360 px the page is laid out 559 px wide for a viewer, 786 px for an operator and 1081 px for an admin, on every
  page, and the number equals the nav's right edge. A phone shrinks such a page to fit (an admin sees it at about a third
  of its size); a desktop browser at that width scrolls sideways, with the nav cut off after "Billing, Sou...". Idea: wrap
  or fold the links into a menu button below about 700 px, and shorten the user label.
- **S13-2 [ux] (Claude, measured)** Page content wider than 360 px (nav excluded): Sources 616 px, Source points 505,
  Audit 447, Scans 424, Users 375, and in the dashboard editor the widget Edit/Delete buttons reach 428. Billing already
  scrolls inside `.table-scroll`; the same wrapper would fix the tables. Tariffs in edit mode was not measured.
- **S13-3 [bug] (Claude, measured)** Discovery at 360 px: the first node's Details button sits at x = -536 (outside the
  screen; the default view is not fitted), and with the Details panel open the panel is 320 px wide and the canvas 0 px,
  so the panel is the whole screen (Close brings the graph back). Touch dragging to map was not tested.
- **S13-4 [bug, low] (Claude)** Operators and viewers can open `/sources` and `/sources/:id/points` by typing the URL:
  neither route has `RequireRole` (`App.tsx:38-39`). A viewer gets the page shell with a red "insufficient role" line, not
  the "Operators only" notice the other pages give. An operator on the points page is offered Browse points, Map/Edit and
  Unmap, and `SourcePointsPage` never checks the role; the API refuses all three with 403 (verified: browse, mapping create,
  update, delete are admin-only). Fix: `RequireRole operator` on `/sources`, `admin` on the points page.
- **S13-5 [ux] (Claude, measured)** An unknown URL (for example `/nope`) renders a blank page: no nav, no text, no way
  back except the browser's Back button (no catch-all route in `App.tsx`). Same for every role. The tab title is "DC
  Dashboard" on every page.
- **S13-6 [ux] (Claude, measured)** The current page is marked `aria-current="page"` in the nav, but nothing styles it: no
  visible difference for any role. No skip link; 6, 9 or 14 Tab stops precede the content on every page.
- **S13-7 [bug, medium] (Claude)** The UI learns your role once, at page load (`AuthProvider.tsx`), while the API checks it
  on every request (verified). After an admin changes someone's role, the nav and buttons keep the old role until a reload,
  and a demoted operator with a dashboard editor open gets a 403 only when pressing Save. Idea: refetch `/api/me` on window
  focus and after any 403, and say "your role changed, reload" instead of a bare error.
- **S13-8 [gap] (Claude, code + measurement)** The dashboard editor's move and resize are pointer-only (known: backlog
  section E); with a keyboard you can add, edit, delete and save, but not arrange. It also cannot be used on a phone:
  fixed 12 columns (about 18 px each at 360 px).
- **S13-9 [gap] (Claude, code)** Charts are canvases with no text alternative (no `aria`, no `role="img"`): the Gauge value
  exists only on the canvas, the asset Trend chart has no table or CSV, tooltips and legend toggles are pointer-only.
  Hints in `title` attributes (Billing "no data / no meter / not yet", the `~` and `*` marks, "no data" on tiles) show on
  neither touch nor keyboard focus; the Billing legend repeats the markers in text, which is the mitigation.
- **S13-10 [gap] (Claude, measured)** A focused Discovery node shows no focus ring (the wrapper has `tabindex=0`,
  `outline: none`, no shadow; the buttons inside do show the browser ring). Each node costs several Tab stops (16 in this
  graph). Per the library code, arrow keys move a selected node but the app saves the layout only on drag stop, so keyboard
  moves are probably not saved (not verified in a browser).
- **S13-11 [ux, low] (Claude, code)** Row buttons carry no row context for a screen reader on Sources, Source points,
  Scans, Users and Tariffs ("Delete", "Test", "Edit" repeated); the dashboards list, the editor and the graph nodes use
  `aria-label` with the item name.
- **S13-12 [bug, medium] (Claude, measured on the scratch copy)** `PUT /api/settings/storage` with an empty JSON body returns
  200 and resets every storage setting to the factory defaults (retention 30, compression 7, 1-minute rollups 730, capacity
  100, warning 80), rewrites the live TimescaleDB policies, and writes no audit row. The Storage page always sends every field,
  so the screen is safe; any client or script that leaves a field out changes retention silently. The other `PUT` and
  `POST` routes answered 422 to an empty body. Ties to S9-1, S9-2, S9-3.
- **S13-13 [info] (Claude)** Handled well, from the code and the measurements: every clickable thing is a real `button` or
  link (no `onClick` on a div), all inputs are labelled, the browser's focus ring is kept, dialogs trap focus, close on
  Escape and give focus back, the Discovery side panel hands focus over and back, dashboard and node buttons have names,
  the Billing grid scrolls inside its box and the dashboard viewer stacks into one column below 700 px.

Not verified: a real phone (touch, address-bar height, zoom), touch drag-to-map in Discovery, a screen reader, the dashboard
editor's tab order, Tariffs in edit mode at 360 px, keyboard-only use of Billing and the asset page end to end.

### Section 12: Operations (done; Claude ran every check, nothing here was tested by the owner)

Method: four throwaway Compose projects `dcdash_e2e_ops_a..d` (own volumes, ports 18080-18446, a compose override
kept outside the repo, `COMPOSE_PROJECT_NAME` set per shell, a guard that refuses to run unless the project is
scratch). The scripts call a bare `docker compose`, so without the variable they act on the project named in
`compose.yaml` (`dcdash`); confirmed empirically that the variable wins over `name:`. The dev volume
`dcdash_dbdata` was only read (a fresh `scripts/backup.sh` first: `backups/dcdash-20261009-170424.dump`, 0004).
Afterwards the four projects were removed (`docker volume ls` shows only `dcdash_dbdata`), the repo tree is clean.

What was verified (evidence from the run, not from reading code):

| Check | Result |
|---|---|
| Backup of the live dev DB | 0.8 s, 350 kB; pg_dump took a consistent snapshot while the collector kept writing; the circular-FK warning is the expected one |
| Restore of that dump into a fresh project, compared with fingerprints (count + md5 of ordered rows per table, readings and both rollups below a cut-off, jobs, extensions) | identical, except what changed in dev after the dump (the owner moved Discovery nodes and signed in again: re-read from the dump file, `graph_layout` and `sessions` equal the dump) and `settings.collector_networks`, which the scratch collector rewrote with its own Docker subnet (172.21 instead of 172.20); restore 10.6 s |
| Usable after restore | `/api/setup` says `needed:false`; all three sources `online` (secrets decrypted with the same `.env`); newest reading advances; next asset id is 9; no errors in the logs. One-minute hole in the raw data between dump and restore (the RPO) |
| Guards of `restore.sh` | version mismatch refused with exit 3; `--force` of the old 0003 dump restores and the restarted api migrates it to 0004 by itself (10.7 s + about 30 s; `minutes` column present, both rollups rebuilt, `billing` setting seeded); a corrupted dump fails (exit 1) and leaves the DB usable and api running. `scripts/backup_smoke.sh` passes in a scratch project (45 s) |
| Large data and compressed chunks | seeded 4.52 M raw rows (22 days, 31 points), compressed 3 of 5 chunks (15x on this synthetic data), 378 k 1-minute and 6.3 k hourly rollup rows; db 200 MB; backup 3.8 s, dump 47.6 MB; restore into a brand-new project 12.8 s; the compressed chunk came back compressed and queryable; rollups, policies and the overlapping raw data identical (count, sum, per-point digest) |
| Restart behaviour | database stopped for 42 s: api and collector recover with no action, readings resume within seconds. Real crash (`pg_ctl stop -m immediate`): container restarted by the restart policy in about 1 s, crash recovery clean, data identical afterwards. Everything stopped, then api/collector started before the db (what a host reboot does, no `depends_on` ordering): both crash-loop (6 restarts) and are healthy about 12 s after the db is up. Note: `docker kill` is not a crash (Docker treats it as a manual stop and does not restart) |
| TLS (an adapted copy of the script's steps in a scratch certs dir) | unreadable key gives the clear entrypoint message; after the chown to uid 10002, HTTPS 200, HTTP gets 308, HSTS present, the session cookie gains `Secure`, SSE works over HTTP/2 (`: connected` arrives at once) |
| Setup re-run | `.env` unchanged by a second run; the first run took 44 s (cached build) |
| `scripts/check_web.sh` | all four lines ok |
| Secrets in logs | none (db password, secret key and `sim-key` searched in all retained logs of the dev stack) |

Not verified (say so, do not assume): the `.ps1` scripts (they parse cleanly in PowerShell 5.1, but were never executed; a
run from the WSL path would write into `C:\Windows` because `cmd /c` refuses a UNC working directory); a real host reboot
or Docker Desktop autostart; disk-full behaviour; the server side of TLS 1.0/1.1 (my probe was refused by the client's
OpenSSL, so it proves nothing); `check_tls.sh` as written (not run, see S12-5); the pinned TimescaleDB Windows build
(see the offline bundle part).

- **S12-1 [bug, high] (Claude)** `/api/health` always answers `{"status":"ok"}` (`api/main.py:79`), so Docker shows the api
  `healthy` for the whole time the database is dead (verified over a 42 s outage), while real requests do not answer
  within 3 s (measured with a 3 s client limit; the actual server-side wait was not measured). The collector, web and
  simulator have no healthcheck at all, and nothing watches "newest reading age". After the outage the raw data of the
  outage window is present but at half density (1 reading per 10 s instead of 2 for a 5 s stream; cause not
  investigated). Idea: health checks the database with a short timeout (separate liveness and readiness), a
  collector heartbeat that Docker or the UI can see, and a "last reading" age on the Sources page.
- **S12-2 [bug, high] (Claude)** No log rotation: the engine default is `json-file` with no options (checked on every
  dev container), so logs grow without limit. The collector writes 1.86 MB an hour on the dev data (3 sources), 43
  MB a day, about 15 GB a year, and it is almost entirely asyncua at INFO: `opening connection`, `create_session`,
  `activate_session`, `read_attributes`, `close_session`, plus a 1.4 kB `find_endpoint` line, 759 times an hour each.
  Fix: `logging: options: max-size / max-file` in `compose.yaml`, and set the `asyncua` (and `pymodbus`) loggers to
  WARNING in `collector/main.py` (the scan code already does it process-wide during scans).
- **S12-3 [bug, medium] (Claude)** The collector and the api ignore SIGTERM: the collector's PID 1 is Python without a
  SIGTERM handler (signal mask checked; a direct `kill -s TERM` left it running after 3 s), the api's PID 1 is `sh -c
  "alembic upgrade head && uvicorn ..."` which does not forward it. `docker stop` therefore waits the whole grace
  period and ends with SIGKILL (exit 137; 10.2 s with `-t 10`). This machine's Docker has `StopTimeout=1` in every
  container config, which is not from `compose.yaml`, so here it only costs 1 s; a normal Linux host waits 10 s for
  every stop, restart and `down`. Cost: the writer's in-memory buffer (flushed every 1 s) is lost on each stop, and
  Postgres sees dropped connections. Fix: `exec uvicorn` in the command, a SIGTERM handler in the collector that
  flushes the writer, or `init: true`.
- **S12-4 [risk, high] (Claude)** `.env` is the one thing the backup does not contain and nothing protects. (a) A
  wrong or new `DCDASH_SECRET_KEY`: nothing crashes, the sources without a secret keep working, and a source with a
  secret goes `offline` with `stored secret cannot be decrypted` (verified). (b) A lost `.env` plus `scripts/setup.sh`:
  the script sees no `.env`, writes new random values and prints `Created .env`, like a first run; the existing
  database volume still has the old password, so the api crash-loops with `password authentication failed for user
  "dcdash"`, the web answers nothing, `setup.sh` exits 1 with `dependency failed to start` (verified; putting the
  original `.env` back and `docker compose up -d` recovers, the data was intact). Someone who then "fixes" it with
  `down -v` loses the database. Fix: `setup.sh` refuses (or asks) when the `dbdata` volume exists and `.env` is
  missing; `backup.sh` warns that `.env` is not included and says where the key must be kept; the README's disaster
  recovery steps list `.env` plus the dump.
- **S12-5 [bug, medium] (Claude)** The ops scripts act on whatever stack is running, which is the data-safety problem
  `e2e.sh` had. `check_tls.sh` (read, not run, because it cannot be isolated): `docker compose up -d --build web` also
  starts db and api and re-tags the shared images; it ends with a bare `docker compose down` (stops the whole stack);
  it overwrites `certs/privkey.pem` and `certs/fullchain.pem` and deletes both at the end (a real certificate with
  those names would be destroyed); `sudo chown` needs a password prompt; and it tests `https://localhost` and
  `http://localhost`, so the ports cannot be changed. `backup_smoke.sh` deletes an asset and drops and restores the
  live database (fine only on a stack you can lose). Both should name a project like `e2e.sh` does (`-p`, a prefix
  guard) and the TLS script should use its own certs directory and a throwaway container for the chown.
- **S12-6 [gap, medium] (Claude)** Certificate life cycle. A new certificate written to `./certs` is not picked up: the
  old serial is served until `docker compose restart web` (verified; the README does not say so). An expired
  certificate is served silently (the container is `Up`, no log line, nothing in the app), so users only learn from
  their browser. A key that does not match the certificate gives a clear Caddy error (`private key does not match
  public key`) and a crash loop, which is fine. Ideas: show the certificate's expiry in Settings or the future doctor
  script and warn 30 days before, and write the rotation steps in the README.
- **S12-7 [hardening, medium] (Claude)** The site sends no security headers except HSTS in TLS mode (no
  `X-Frame-Options` / `frame-ancestors`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`);
  `Server: Caddy` is shown. The HTTP to HTTPS redirect drops a non-standard HTTPS port (`https://localhost/...`),
  which only matters if 443 is not the public port. The session cookie is `HttpOnly; SameSite=strict` and gets
  `Secure` over TLS (verified).
- **S12-8 [ux, medium] (Claude)** Re-running `scripts/setup.sh` is safe for the data and for `.env` (unchanged), but it
  recreates the api, collector, web and simulator every time (about 12 s without service): two consecutive fully
  cached builds produced different image ids (probably BuildKit's per-build attestation, not tested with
  `--provenance=false`), so Compose sees a new image. Because the build tags `dcdash-backend:local` and
  `dcdash-web:local` are shared by every project, any build re-tags them for all of them (the README already says it
  for the e2e run). Lesson from this pass: do not remove images by id on this engine (containerd store: a container's
  `.Image` is not the id that `docker image inspect` prints); I removed the two tagged images by mistake and rebuilt
  them from cache; the dev containers still run their older images and will be recreated at the next `up -d`.
- **S12-9 [gap, medium] (Claude)** A restore re-arms the retention policy at once. In the large drill the restored
  database lost, within 30 s, exactly the two chunks that lay wholly beyond `raw_retention_days` (14), because the
  retention job runs right after `timescaledb_post_restore()` (job 1026, success, 0 failures); the source had not run
  its daily job yet. A forensic restore of an old dump therefore discards its old raw data unless the retention is
  raised first. Idea: `restore.sh` prints the retention horizon and how many chunks it will drop, and the README says
  to raise `raw_retention_days` before restoring old data.
- **S12-10 [design risk, medium for real OPC UA] (Claude)** The OPC UA connector opens and closes a session for every
  poll on purpose (`connectors/opcua.py:104`, "a fresh client per call, always disconnected"): about 720 sessions an
  hour per source at 5 s. Only the simulator was tried; real SCADA servers cap the number of sessions and many log
  each session in their security audit. To decide before the first real connection: keep one session with a
  watchdog, or a longer interval per source (links to the OPC UA credentials item in backlog section B).
- **S12-11 [gap, medium] (Claude)** Backups are manual, unencrypted, never rotated and stored beside the database
  (`./backups`); nothing schedules them, copies them off the machine, or reminds anyone to practise a restore. The
  dump holds password hashes and the source secrets as ciphertext (useless without the key, see S12-4). Idea: a
  scheduled backup (Task Scheduler or cron), keep the last N, an off-host copy step, and the restore drill of this
  pass written as a runbook (new machine: `.env`, `setup`, dump, `restore.sh`, checks).
- **S12-12 [docs] (Claude)** The README's "Upgrading to Phase 3" part is now history for this install (the dev stack is
  on 0004); it should become a general "upgrade" runbook: back up, read the pre-check, start, verify, go back. The
  `--force` path it describes was exercised in this pass and works.
- **S12-13 [observation] (Claude)** After a restore the collector rewrites `settings.collector_networks` with its own
  Docker subnet, so the scan range prefill follows the machine, not the restored data (the backlog section B item
  "prefill will be wrong" is the same behaviour).
- **S12-14 [gap] (Claude)** The Windows scripts (`setup.ps1`, `backup.ps1`, `restore.ps1`) have never been run; their
  logic mirrors the shell scripts (read side by side) but `backup.ps1` and `restore.ps1` depend on `cmd /c` binary
  redirection. They need one real run on a Windows machine with Docker before anyone relies on them.

Idle footprint of the dev stack (one sample): collector 94 MiB, api 155 MiB, db 242 MiB, web 14 MiB, simulator 116 MiB;
CPU about 2 % in total. Without the simulator the stack idles under 0.5 GB of memory.

#### Offline bundle (backlog section D): what exists, what is still missing

- Measured: the three images to ship are 788 MB (`dcdash-backend`), 95.5 MB (`dcdash-web`) and 2.48 GB
  (`timescale/timescaledb:2.30.2-pg16`); one `docker save` piped through `gzip -3` is 0.73 GB (782 MB), a single file
  that fits the RDP transfer plan. The simulator runs from the backend image.
- Nothing of the bundle exists yet: no bundle script, no image-only compose file (every app service has `build:`, and
  `setup.sh` / `setup.ps1` always run `up -d --build`, which cannot work offline), no checksum manifest, no `doctor`
  script, no log collector, no offline smoke test.
- The build needs the internet for `python:3.12-slim`, `ghcr.io/astral-sh/uv:latest`, `node:22-alpine`, `caddy:2-alpine`,
  PyPI (`uv sync`), npm (`npm ci`) and Alpine (`apk add libcap`). All four base references float; pin them by digest
  so the bundle can be reproduced (see S12-8).
- The bigger question: the owner's note says the workstation has no Docker and no WSL. A `docker save` bundle only serves
  a Linux VM image or a Docker install. For a native Windows install: release 2.30.2 does ship
  `timescaledb-postgresql-16-windows-amd64.zip` (8 MB, checked through the GitHub releases API; every recent release
  has one). Not verified, and decisive: whether that Windows build includes compression, continuous aggregates and
  policies, which the app uses. The vendor's Windows page names no edition and no feature list, so only a test on a
  Windows machine will tell. The backend and the Caddy part have not been run natively on Windows either.
- Decisions the bundle waits on: route A (native Windows) or B (Linux VM), the Windows edition, Hyper-V or virtualization
  availability, the RDP file-transfer limit, and whether the workstation may run Docker Desktop at all.

### Section 11: Scans and Discovery (done; the owner likes it a lot)

The owner said it is done very well and works great. The scan, the graph and the mapping dialogs were not
reported row by row. The owner asked how to read the graph (answered in the chat: source, clusters and points
on the left, dashed, are what was discovered; assets on the right, solid, are the owner's tree; a solid edge
from a point to an asset is one mapping; there is no separate "tool" entity between an asset and a source,
the mapping is the link) and thought out loud about taking it further.

- **S11-1 [idea] (owner)** Boxes should snap together: snap to a grid, magnetic alignment to neighbouring
  boxes, and a "tidy up" button, so that arrangements stay neat as they grow.
- **S11-2 [ux] (owner, from needing to ask)** The graph should explain itself: a legend (dashed means
  discovered, solid means yours, a solid edge means mapped) and a short "how to read this" hint.
- **S11-3 [idea] (owner)** Differentiate the node types visually and display them smartly: icons by asset
  kind (site, room, panel, meter) and by protocol (OPC UA, Modbus, HTTP), status colours on sources (online,
  offline, needs credentials) with last seen, counts of mapped and unmapped points per source, highlight of
  orphans (unmapped points), lanes or containers (a room as a box that holds its panels), automatic
  hierarchical layout, saved views, and export of the picture (PNG, SVG, PDF) as architecture documentation.
- **S11-4 [idea] (owner, architecture)** A user should be able to draw the architecture visually. Today the
  asset tree has one relation, "contains" (a room contains a panel). A data centre also needs "feeds" (the
  power path: utility, MV, LV panel, PDU, rack) for a single-line diagram. Decide whether "contains" and
  "feeds" are two relations, and whether Billing's roll-up follows one or the other (it follows "contains"
  today; see S6-1).

### Section 10: Audit (done; the log works, a lot is missing around it)

Audit coverage inventory (Claude, read from the source: every POST/PUT/PATCH/DELETE route, whether its code
calls `audit(`): 14 of 35 data-changing endpoints are audited.
Audited: asset delete; dashboard create, save, delete; discovery accept; scope create, update, delete; scan
start; billing currency; source delete; tariff create, update, delete.
NOT audited, high importance: user create and patch (role changes, deactivate, reactivate, admin password
reset), own password change, sign-in successes, failures and lockouts (security events), storage settings,
site timezone, mapping create, update and delete, asset create and update, source create and update.
Medium: source test, test-all and browse (they open connections toward the SCADA; scan start is audited, these
are not). Low or not needed: discovery layout save (positions), widget data (reads), logout, first-run setup
(arguably high: it creates the first admin). Outside the API entirely: backups, restores, migrations and
container restarts (operational log, not the app's).

- **S10-1 [gap] (owner)** Everything important must be audited, starting with storage updates. Use the
  inventory above as the work list; decide what counts as important (the high-importance list is the
  proposal), and make the audit write part of each route so a new route cannot forget it (a test that fails
  when a data-changing route has no audit call, with an explicit allow-list for the reads).
- **S10-2 [idea] (owner)** Filtering and searching: by user, action, date range, and text inside the detail,
  plus quick filters (for example "only deletions", "only today").
- **S10-3 [idea] (owner)** Export: CSV (and perhaps JSON) of the filtered view, with timestamps in the site
  zone with offset, the same CSV safety rules as the other exports (BOM, formula-injection prefix).
- **S10-4 [idea] (owner)** Navigation: jump to a date, page controls that scale, and entries that link to the
  object they are about (asset, dashboard, tariff, source), with permanent links to one entry.
- **S10-5 [ux] (owner)** The screen itself needs a UI and UX pass.
- **S10-6 [idea] (owner)** Two views of an entry: the raw log (exactly what is stored, the detail as JSON)
  and a friendly one ("admin changed the site currency from QAR to USD", with before and after shown side by
  side). The friendly view needs the old values stored too: today `tariff.updated` keeps only the new values
  (final review finding F6).
- **S10-7 [idea] (Claude, enterprise)** Decide the audit log's own policy: how long entries are kept, that
  nobody can edit or delete them from the app (true today: the screen is read-only, but a database
  administrator can), and optional forwarding to a central log (syslog or a SIEM) for sites that need
  tamper-evidence.

### Section 9: Storage (testing; the owner found the rest good)

Checked by Claude in the database after the owner's change: the stored setting (raw 14 days, compress after
3, 1-minute rollups 730, warn 70) and the live TimescaleDB policies agree (`readings` compression 3 days,
retention 14 days, `readings_1m` retention 730 days), so the screen really drives the database. The warning
works as specified: `used_pct >= warn_threshold_pct` shows an alert in the page (UI only, no outbound
alert). Measured on the dev data: 14,345 raw rows take 2,064 kB (about 147 bytes per row including indexes
at this tiny size), 10 live streams make about 4,560 rows an hour (about 109k a day), chunks are 7 days, so
the real compression ratio cannot be seen until data is older than the compression delay.

- **S9-1 [idea] (owner)** The Storage form needs a **Reset** button and a **Set as default** button. Reading
  to confirm with the owner: Reset throws away unsaved edits and shows the saved values again; Set as
  default fills in the factory values (raw 30, compress after 7, 1-minute rollups 730, capacity 100 GB,
  warn 80) and saves, or leaves them to Save. The other possible meaning of "set as default" is "make the
  current values the organisation's defaults for later resets". Decide when planning.
- **S9-2 [safety] (Claude)** Shortening a retention period gives no warning and no confirmation, yet the
  next policy run deletes everything older than the new limit, permanently (checked: nothing in
  `StoragePage.tsx` asks). Idea: a confirmation that says what will be deleted (readings older than N days,
  about X rows) before saving.
- **S9-3 [gap] (Claude)** Storage settings changes are not written to the Audit log (no `audit(` call in
  `backend/dcdash/api/storage.py`), although they decide how long data survives. Idea: audit
  `storage.changed` with the old and new values.
- **S9-4 [idea] (owner's enterprise question, answered in the chat; for the planning phase)** Enterprise
  policy items: a default polling policy (the 5 s default for six metrics is the main driver of volume),
  named retention profiles (lean, standard, forensic), outbound alerts for the capacity warning, scheduled
  off-host backups (`scripts/backup.sh` is manual), and a change-control step for retention (confirm, audit,
  perhaps a second approver in strict organisations).

- **S9-5 [decision for the plan] (owner asked what enterprise defaults should be)** Recommended factory
  defaults for a data-centre installation (Claude's judgement from the retention rules of the app and
  typical time-series practice, not a standard; the site's own regulatory and contractual obligations
  override it): raw retention 30 days (14 when the volume is tight), compress after 7 days (leave: chunks
  are 7 days wide, so compressing earlier changes nothing useful), 1-minute rollup retention 365 days
  (today 730), hourly rollup kept forever (unchanged), disk capacity = the real size of the database volume
  (no universal default: ask at install; today a 100 GB placeholder), warn at 70 % (today 80). The values
  the owner typed during testing (14 / 3 / 730 / 100 / 70) are test values, not a proposal. Facts behind it:
  retention drops whole 7-day chunks, so effective raw retention is up to 7 days longer than the setting;
  measured row costs on the dev data are about 147 bytes (raw) and at most about 195 bytes (1-minute
  rollup, inflated by overhead at tiny size); at scale the 1-minute tier is the biggest consumer and it is
  not compressed today (only `readings` has a compression policy). Idea: compress the rollups, and make the
  polling interval the main sizing lever (see S9-4). To do: change `StorageSettings` defaults and the
  seeded value, then re-check the migration seed and the Storage page defaults button (S9-1).

### Section 7: Dashboards, part 1, building (done; rows 10-13 confirmed by the owner afterwards)

The owner built a dashboard with a stat, a gauge, a time series, two bar charts and a table, and said the
widget dialog is fine for now and it feels good overall but can be improved. Rows 10-13 (unsaved-changes
prompt, Save and reload, rename and duplicate name, two-tab conflict) were confirmed later by the owner.

- **S7-1 [bug] (owner)** The default gauge is messy: the asset name is drawn in the middle of the dial and
  overlaps the scale numbers and the needle, also when the widget is enlarged. Cause: `GaugeWidget.tsx`
  positions only the value (`detail`, `offsetCenter [0, "70%"]`); the title (the asset name) keeps the ECharts
  default position, the centre. Fix: put the name below the value or in the widget's own subtitle line,
  scale the text with the widget, and shorten long names with a tooltip.
- **S7-2 [bug] (owner)** A dashboard cannot use a wide screen: it only fills the left part (about 1200 px
  on a 2000 px display). Cause: every page shares `main { max-width: 1200px }` (`frontend/src/app.css:6`),
  while the Discovery graph opts out with `main:has(.graph-page) { max-width: none }`. A wall screen is a
  stated use of the dashboards, so dashboards should opt out the same way (maybe a "fit to screen" choice).
  Billing, with its 31 day columns, would also gain from more width.
- **S7-3 [ux] (owner)** Long asset names do not fit in a default-size widget: legends scroll or cut off
  and bar labels are shortened (`MV2-R2-LV-Panel-02`). Ideas: bigger default sizes per widget type, legends
  that wrap, labels that truncate with a tooltip. S7-2 gives more room.
- **S7-4 [bug] (owner)** Dragging a widget onto an occupied place sends the displaced widget far down
  instead of only making room for the moved one. Cause: the editor uses `noCompactor` on purpose
  (`DashboardGrid.tsx:34`), so that saved positions look the same in the view and in the editor, and
  without compaction a collision just pushes the other widget below. Options: vertical compaction in the
  editor, the view and on Save (editor and view must stay identical), or swapping positions when dropping
  on an occupied place. Also `nextPosition`'s comment still says "the grid then compacts it upwards".
- **S7-5 [ux] (owner)** Deleting a widget does not ask first. Nothing is saved until Save (Cancel or Reload
  undoes it) but there is no undo inside a session. Ideas: confirm like the other deletes, or an "Undo"
  link right after a delete.

### Section 6: Billing (done, tested briefly by the owner)

The owner checked the grid, marks, CSV and the rate changes briefly and found no defects. What the
automated tests and the e2e cover (the grid, the CSV header, shaded and empty cells, cost arithmetic, widget
totals equal to Billing totals) was not walked row by row on the owner's data. Rows worth a glance when
convenient: 4 (asset page equals Billing), 6 and 7 (roll-ups), 10 (CSV).

- **S6-1 [open decision] (owner)** A parent's cost is its own energy times the rate that applies to the
  PARENT (its own override, an ancestor's, else the site default), never the sum of its children's
  costs. With Room 2 on 0.30 and MV2 on 0.12, MV2's cost is not Room 1's cost plus Room 2's cost. The owner
  will confirm with the real administrators which behaviour they want; left as it is for now. If it
  changes, it is one rule in `core/cost.py` (price each leaf, then sum up the tree) plus the spec
  sentence in section 10.2.

### Section 5: Tariffs (done)

Everything in the script matched (currency validation and confirmations, site default rate, overrides,
cost arithmetic, future-dated rate).

- **S5-1 [ux] (owner)** The up and down arrows in a rate box jump a whole unit (0.12 to 1.12), not by
  cents. Cause: both rate inputs use `step="any"` (`frontend/src/pages/TariffsPage.tsx:101` and `:152`),
  which makes the browser step by 1. Fix: `step="0.01"` on both. Typed values with up to six decimals
  stay valid because the forms skip the browser's own validation (`noValidate`) and the server does the
  checking. Worth checking other number boxes for the same habit (mapping Scale, Storage settings).

### Section 4: Assets and mapping (done)

Owner's state at 11:47: assets `MV2` (DC) > `MV2-Room-1` (Room) > `MV2-R1-LV-Panel-01`, `-02`, and
`MV2-Room-2` > `MV2-R2-LV-Panel-01`, `-02` (kind `LV_Panel`, sort orders 1 and 2). Mappings: `MV2-R1-LV-Panel-01`
has `active_power_kw`, `current_a`, `energy_kwh`, `voltage_v` from `sim-opcua` (LVP01), and
`MV2-R2-LV-Panel-01` has `active_power_kw` from `LVP02 kW`. Readings are flowing (newest within seconds
of the check). Unmapping and deleting work (owner). S3-1 reproduced: `sim-modbus` and `sim-http` have no
mapping, so they show `online` with a Last seen about 6 minutes old.

- **S4-1 [ux] (owner)** Adding a child asset means choosing the parent in a dropdown each time, which
  gets harder as the list grows. The owner then found you can already add under a specific asset by
  pressing it. So the need is to make that obvious: for example a `+` next to each branch that preselects
  the parent.
- **S4-2 [idea] (owner)** `Kind` is free text, so the naming convention has to be remembered (`LV_Panel`
  vs `LV panel`). Make it a dropdown or a pick from a list of defined kinds, maybe with the same
  "choose where you are" behaviour as S4-1. Not decided yet.
- **S4-3 [bug] (owner)** Duplicate asset names are allowed, even with the same kind, and there is no
  refusal text. With two `LV_Panel_01` in two rooms, the asset list in the mapping dialog shows both as
  `LV_Panel_01` with no way to tell which room each is in, so a point can be mapped to the wrong one. The
  same bare-name problem was fixed for the Tariffs picker and the dashboard asset picker (labelled by
  path) but not here: the mapping dialog's Asset list and the Assets form's Parent list still show bare
  names. Policy to decide: refuse the same name under the same parent (a real duplicate), allow it
  under different parents, and show the path in every asset list.
- **S4-4 [ux] (owner)** Mapping a point means scrolling all the way down to the mapping form. To tackle
  in the UI polish.
- **S4-5 [idea] (owner)** The points list needs sorting (name, address, type, unit, mapped or not) and
  most likely a filter such as "unmapped only" and a search. Without it, mapping 60 points per source is
  slow and error-prone, and a real SCADA will have far more.

Second round (owner): the duplicate-asset and duplicate-mapping refusal works (a point has one mapping,
an asset has one per metric). Live tiles and tables update; the 1h `energy_kwh` chart is empty; charts
need a refresh to move. Screenshots of the two rooms show `reconnecting…`, Live power `—`, Energy today
13.03 kWh (estimated) and 10.70 kWh (estimated), Cost today `— no rate set`, Trend "No metric to chart",
Metrics "No metrics are mapped to this asset".

- **S4-6 [bug] (owner)** The Trend chart on an asset page is EMPTY for `energy_kwh` on the 1h range.
  Cause: `withGaps` in `frontend/src/components/TrendChart.tsx` inserts a gap whenever two points are
  more than 1.5 buckets apart. A 1h range has 12 s buckets and energy arrives every 60 s, so every point
  is alone, and a lone point is drawn as nothing (`symbol: "none"`). It is the same bug that was fixed in
  the dashboard widgets (isolated points get a dot; gap size from the median step) but this older chart
  was never updated. Any metric sampled slower than about 18 s is affected on the default 1h range.
  Fix: reuse the widgets' rules in `TrendChart`.
- **S4-7 [ux] (owner)** The Trend chart does not move live while the tiles and tables do. The tiles use
  the live stream (every few seconds); the chart refetches every 30 s (`useSeries`,
  `refetchInterval: 30_000`), so it looks frozen. Ideas: append streamed points, refetch faster on short
  ranges, or at least show "updated hh:mm:ss".
- **S4-8 [bug] (from the owner's screenshots)** An asset with no points of its own (a room) shows
  `reconnecting…` next to its title forever. The label is `connected ? "live" : "reconnecting…"`, and
  with nothing to subscribe to no connection is ever opened. It should say nothing, or "no live data".
- **S4-9 [idea] (from the owner's screenshots)** Parent assets show Live power `—`, an empty Trend and
  an empty Metrics table, although Energy today does roll up from the children. Ideas: roll up the
  children's live power, let the Trend show the rolled-up energy for a parent, and explain `(estimated)`
  (part of the figure came from average power x time, not from an energy counter) with a tooltip.

Mappings completed by Claude at the owner's request (direct database insert plus the collector
notification, the same rows `POST /api/mappings` writes; ids 30-32): `MV2-R1-LV-Panel-02` energy from
`sim-http` `LVP01 kWh`, `MV2-R2-LV-Panel-01` energy from `sim-opcua` `LVP02 kWh`, `MV2-R2-LV-Panel-02`
energy from `sim-modbus` `LVP01 kWh` (all 60 s, scale 1). Final state, 10 mappings, readings flowing on
all of them, all three sources online:

| Asset | Power (every 5 s) | Energy (every 60 s) | Also |
|---|---|---|---|
| MV2-R1-LV-Panel-01 | sim-opcua LVP01 kW | sim-opcua LVP01 kWh | voltage and current from sim-opcua LVP01 |
| MV2-R1-LV-Panel-02 | sim-http LVP01 kW | sim-http LVP01 kWh | |
| MV2-R2-LV-Panel-01 | sim-opcua LVP02 kW | sim-opcua LVP02 kWh | |
| MV2-R2-LV-Panel-02 | sim-modbus LVP01 kW | sim-modbus LVP01 kWh | |

### Section 3: First run and Sources (done)

Fresh start (owner chose option A, 2026-10-09 11:05): the dev database was backed up to
`backups/dcdash-20261009-110350.dump` (schema 0004, it held the leftovers described below, the test users
`op1` and `view1` and the Qatar timezone), then wiped (`down -v`) and started clean from `main`
(`e6ca151`). Migrations ran from scratch to `0004 (head)`, no errors. Seeded settings: timezone `UTC`
(from `.env`), currency `null`, storage 30 days raw / 7 days compression / 730 days 1-minute, scan network
`172.20.0.0/24`. All tables empty, first-run page waiting (`needed: true`).

Result (owner): rows 1-12 matched. Row 6 first showed `offline`, `auth_failed: credentials rejected`
because Claude's script left out the Secret: the dev HTTP simulator needs the API key `sim-key`
(`compose.yaml`: `SIM_API_KEY: sim-key`; the `simulator` connector sends the source's Secret as the
`X-API-Key` header). The OPC UA simulator has no password (`SIM_OPCUA_PASSWORD` unset), so it accepts any
login. The owner recreated `sim-http` with the secret: Test OK in 4 ms.

- **S3-3 [docs]** The README never says that the dev simulator's HTTP endpoint needs `sim-key` as the
  source Secret. A first-time user adding the simulator the way the README describes gets
  `auth_failed`.
- **S3-4 [bug] (owner)** The Sources page has no Edit: to change a secret or any setting you must delete
  the source and add it again. The API supports it (`PATCH /api/sources/{id}`, admin) and the Discovery
  side panel (a source's Details) edits credentials, but the Sources page does not. Idea: an Edit on the
  Sources page using the same form as Add.
- **S3-5 [idea] (Claude, for section 11)** The README says user management and source create/edit are not
  audited (only the Phase 3 actions: tariffs, currency, dashboards, asset and source deletes). Consider
  auditing user and source changes. It ties into S1-2 (deleting accounts).

Found by Claude while preparing (not by the owner):

- **S3-1 [ux]** A source with no mapped points is never polled (the collector only reads the mapped
  points of enabled sources, `collector/scheduler.py`), and `Last seen` only advances on a successful
  poll. So the dev source `sim-modbus` (0 mapped points) keeps showing status `online` with a
  `Last seen` that is hours old. The status is just the last known one. Idea: show "not polled (no mapped
  points)" instead of a stale `online`.
- **S3-2 [idea]** The dev database holds leftovers of `scripts/smoke.py`: three assets all named
  `smoke-asset` (ids 2, 3, 4), an asset `Smoke Panel`, and a nonsense mapping (the voltage point
  `LVP08 V`, unit hint V, mapped to `energy_kwh` on a `smoke-asset`). The app accepted that mapping
  without any warning. Idea: warn in the mapping dialog when a point's unit hint does not fit the chosen
  metric (V on an energy metric). The duplicate names are what Billing and the Tariffs picker had to be
  taught to tell apart.

### Section 2: Settings (done)

- **S2-1 [ux] (found by Claude while preparing the section)** The hint under the Timezone field reads
  "Used for "today" in energy totals. Readings are stored in UTC." Since Phase 3 the zone also decides
  where a day and a month start on Billing and on dashboard ranges (`today`, `yesterday`, `this_month`,
  `last_month`), and the times shown on the Audit page, the asset chart and the dashboards. The hint
  understates it (`frontend/src/pages/SettingsPage.tsx`).
- **S2-2 [gap] (found by Claude in section 10; also a correction)** Changing the site timezone is NOT
  written to the Audit log (`PUT /api/settings/general` has no `audit(` call; only the currency is audited).
  In the section 2 script Claude wrongly told the owner that an entry for the settings change would
  appear in Audit. It would not. The timezone decides every day boundary and every displayed time, so it
  must be audited (old and new zone).
