# Changelog archive

The release notes of the older releases, from Phase 1A (2026-10-07) to W7j (2026-10-13), moved out of [CHANGELOG.md](../CHANGELOG.md) when that
page neared its size limit. The layout is the same: newest first, each section headed `## <wave> (<date>, <merge commit>)`, upgrade notes as `###`
entries. They still apply to an install that old: migrations 0004 to 0008 are described here (see
[Migrations in order](upgrading.md#migrations-in-order)). A release that is merged now gets its entry at the top of CHANGELOG.md; when that page
passes about 70,000 bytes its oldest releases move here.

**Before you upgrade from an old version,** read every entry between the version you run and the new one, oldest first: the entries on this page
(lower is older), then those in [CHANGELOG.md](../CHANGELOG.md). **To go back,** use the commit each entry names ("the code to go back to"): a wave's
merge commit in a heading is NOT a place to go back to, because it already contains that wave.

## W7j (2026-10-13, 774cb6e)

### Upgrading to W7j (no migration)

Schema stays `0008`; nothing in the database or the API changes, so there is nothing to restore. The code to go back to is
`eba2d92` (`main` before W7j).

W7j (the pages use their space) changes the `web` image and the front end only. What you will notice: the Audit log has one compact
toolbar (search, user, action, a From to To pair, quick-filter chips, Go to date and Export CSV), rows with an event icon, a user disc,
a "how long ago" line and a Details arrow at the end; Storage has icons on its five tiles, Rows per day (with a small bar per day) and
Retention and capacity side by side; Tariffs puts the site default rate and the asset overrides in two columns under a Currency card and
says once that no currency is set; Settings has two equal cards and an About card whose version line says "Version dev, built ..." when a
stack was built without a build id; Diagnostics uses the whole page width; and Automatic icons now pick a battery, a cooling unit, a fan,
a pump and a sensor for kinds that say so. The pages go to one column below 1280 px.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). Only `web` is rebuilt. `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` still prints `0008 (head)`; `scripts/check_web.sh http://localhost` prints
   nine `ok` lines; the Audit log, Storage, Tariffs, Settings and Diagnostics pages open. A stale page after the update reloads once by itself.
4. **Going back.** Check out `eba2d92` and rebuild as in step 2. There is no database step.

## W7i (2026-10-13, eba2d92)

### Upgrading to W7i (no migration)

Schema stays at `0008`; nothing in the database or the API changes, so there is nothing to restore. The code to go back to is
`65d9fab` (`main` before W7i).

W7i (an acceptance sweep and polish) changes the `web` image, the front end and two diagnostic scripts. What you will notice:
the first load is about four times smaller (the web server now compresses its files, and Discovery's graph library is only fetched
when that page opens); files with a hash in their name are cached for a year, while `index.html` and `theme-init.js` are checked
with the server on every visit, so an update shows at once instead of after a hard reload; with the server down the app says
"Can't reach the server" (with a Retry button) instead of showing the sign-in page, and a page left open recovers by itself; a tab
left open across an update reloads once when it needs a file the update removed, then shows a plain "could not be loaded" panel if
that does not help; the browser tab names the page; a very long asset kind wraps; and `scripts\collect-diagnostics.ps1` (and the
shell twin) now name the program that owns each listening port and note the first-start noise of the database image.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). Only `web` is rebuilt. `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` still prints `0008 (head)`; `scripts/check_web.sh http://localhost` prints
   nine `ok` lines. If a browser shows a white page or a broken layout right after the update, press Ctrl+F5 once: before this
   update the web server sent no caching rule for the page, so a browser may reuse the old copy of `index.html` one more time.
4. **Going back.** Check out `65d9fab` and rebuild as in step 2. There is no database step.

## W7h (2026-10-13, 65d9fab)

### Upgrading to W7h (no migration)

Schema stays at `0008`; nothing in the database or the API changes, so there is nothing to restore. The code to go back to is
`45deb14` (`main` before W7h).

W7h (a real first-load screen) is front end only, so only the `web` image changes. A refresh used to show a blank white page and then a
bare "loading..." line until the sign-in check had answered. Now the navy top bar and the sidebar are painted as soon as the page's
stylesheet has arrived (a static copy of the shell inside `index.html`, in the look this browser remembers and with the sidebar open or
minimized as you left it); while the two sign-in requests are out, the same frame shows quiet placeholders and the loading bar runs along
the top edge; then the real shell replaces it without anything moving. The sign-in and setup pages do not show the frame. Screen readers
hear one "Loading" line. A first-ever visit in a browser shows Light and Navy and gold. The frame's content area stays empty until the
page itself starts loading (its own grey shapes appear after the usual sixth of a second). If the app script never arrives (a blocked or stale file), the frame says "Still loading. If this stays, reload the page." after 15 seconds.

1. **Back up first** (a habit here: nothing in the database changes), as in step 1 of "Upgrading and going back".
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). Only `web` is rebuilt. `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` still prints `0008 (head)`. In the browser's developer tools set the network
   to "Slow 4G", reload any page and watch the navy bar and the sidebar appear before anything else; on `/login` no frame shows.
4. **Going back.** Check out `45deb14` and rebuild as in step 2. There is no database step.

## W7g (2026-10-13, 45deb14)

### Upgrading to W7g (migration 0008)

Schema `0007` to `0008`. Downgrade: **lossless** for everything else (it only loses the icon choices described below), so option a
is open. The code to go back to is `15be434` (`main` before W7g).

W7g (asset icons) adds migration `0008`: one new column, `assets.icon`, a nullable text that holds the icon an admin chose for an
asset. It runs in a moment and needs no pre-check. Every existing asset starts on "Automatic", which changes nothing: the icon still
follows the asset's kind. In the Add asset and Edit asset dialogs the new Icon field shows the icon in a small tile and, under Change
icon, a grid of 28 icons to choose from; the choice shows in the Assets Tree, the asset page's title and quick find, and the audit log
records the change. The Assets page is now called "Assets Tree" (the sidebar entry, the first breadcrumb, the tree heading and the
summary's title). The `api` container applies the migration the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0007`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you. Reload open browser tabs.
3. **Verify.** `docker compose exec api alembic current` prints `0008 (head)`; the Add asset dialog shows an Icon field.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0007` and `<old commit>` = `15be434`. The `0008`
   downgrade drops `assets.icon`; nothing else changes, so only the icon choices are lost, and `upgrade` adds the column again with
   every asset on Automatic. A restart of the W7g `api` would run `alembic upgrade head` and apply `0008` again, so the W7g `api`
   must not be running once the schema is back at `0007`.

## W7f (2026-10-12, 15be434)

### Upgrading to W7f (no migration)

Schema stays at `0007`; nothing in the database or the API changes. The code to go back to is `10feba7` (`main` before W7f).

W7f (loading skeletons) is front end only (the `web` image): while a page waits for its first data it shows quiet grey shapes in the
layout the data will have, instead of a bare "loading..." line, only when the wait lasts about a sixth of a second and only on a page's
first load; screen readers hear one "Loading ..." line per area, and "reduce motion" stops the shimmer. Back up as usual, rebuild with
`docker compose up -d --build` (add `--profile dev` on a stack that has the simulator), reload open tabs. To go back, check out
`10feba7` and rebuild (no database step).

## W7e (2026-10-12, 10feba7)

### Upgrading to W7e (no migration)

Schema stays at `0007`; nothing in the database or the API changes. The code to go back to is `499fdc5` (`main` before W7e).

W7e (theme polish) is front end only (the `web` image): buttons, links, the selected tree row and the focus ring follow the Theme colour
in Light and in Dark (Navy and gold's buttons change from a vivid blue to a navy blue in Light mode; the dashboard widgets keep their
light blue); the profile panel has a Mode and a Theme colour dropdown instead of seven round buttons; a thin bar in the theme's marker
colour runs along the top edge while a page loads or you change pages; the Assets tree, the asset's title, the "By kind" list and quick
find carry an icon that follows the asset's kind. Back up as usual, rebuild with `docker compose up -d --build` (the setup scripts pass
the build id), reload open tabs, and check that `docker compose exec api alembic current` still prints `0007 (head)`. To go back,
check out `499fdc5` and rebuild (no database step).

## W7d (2026-10-12, 499fdc5)

### Upgrading to W7d (migration 0007)

Schema `0006` to `0007`. Downgrade: **lossless** for everything else (it only loses the display choices described below), so option a
is open. The code to go back to is `ee1e985` (`main` before W7d).

W7d (appearance) adds migration `0007`: one new column, `users.preferences`, a JSON object that holds each account's Mode (Light,
Dark or Match my device) and Theme colour (Navy and gold, Maroon and gold, Graphite or Desert gold). It runs in a moment and needs no
pre-check. Every existing account starts on Light and Navy and gold; each person changes it in the profile panel (the name block in the
top bar, section Mode and Theme colour) and it follows them to any browser. The default look changes slightly for everyone: the navy
panels now carry gold markers (the selected item's marker, the focus ring and the logo mark, all light blue before) and a gold avatar. The first page load after changing
the look on another computer, or after another person used this browser, shows the previous look for a moment, until the page has asked
the server. The `api` container applies the migration the first time it starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0006`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` prints `0007 (head)`; the profile panel shows the Mode and Theme colour choices.
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0006` and `<old commit>` = `ee1e985`. The `0007`
   downgrade drops `users.preferences`; nothing else changes, so only the display choices are lost, and `upgrade` adds the column
   again with every account on the defaults. A restart of the W7d `api` would run `alembic upgrade head` and apply `0007` again, so the
   W7d `api` must not be running once the schema is back at `0006`.

## W8c (2026-10-12, ee1e985)

Field polish: the offline diagnostics scripts filter routine log lines, save into `logs/`, compare the Docker clock and can mask names (`-Mask`); the report adds DNS lookup lines; the setup scripts take the timezone at install.

## W7c (2026-10-12, 298293f)

An admin chooses a default dashboard that the sidebar and sign-in open, and Billing gets Year and Month selects.

## W7b (2026-10-12, 40d71db)

A row action menu and trash button, help bubbles, the Storage tiles and rows per day, Tariffs in sections, and the sign-in protection switch.

## W8b (2026-10-12, 2f7a518)

Simulator fault switches (`SIM_FAULT_*`), client-side refusal reporting, the offline diagnostics scripts and blind-read examples for field debugging.

## W8 (2026-10-12, 682b636)

### Upgrading to W8 (migration 0006)

Schema `0005` to `0006`. Downgrade: **lossless** for every other table (the dropped table only holds diagnostics), so option a is open.
The code to go back to is `b933bc7` (`main` before W8).

W8 (field diagnostics) adds migration `0006`: one new table, `diag_events`, the persistent event journal behind the Diagnostics report
(connection transitions, job results, check results, API errors), with two indexes. It runs in a moment and needs no pre-check. The
collector's hourly housekeeping keeps at most 14 days and 20 000 rows of it. The `api` container applies the migration the first time it
starts from the new image.

1. **Back up first**, as in step 1 of "Upgrading and going back". Keep the `.dump` and the `.version` file (it says `0005`).
2. **Apply** as in step 4 of "Upgrading and going back": `docker compose up -d --build` (add `--profile dev` on a stack that has
   the simulator). `scripts/setup.sh` and `scripts/setup.ps1` pass the build id for you.
3. **Verify.** `docker compose exec api alembic current` prints `0006 (head)`; the Settings page shows "Version <id>".
4. **Going back.** Use option a or option b of "Upgrading and going back" with `<previous>` = `0005` and `<old commit>` = `b933bc7`. The `0006`
   downgrade drops `diag_events`; nothing else changes, and `upgrade` creates it empty again. A restart of the W8 `api` would run
   `alembic upgrade head` and apply `0006` again, so the W8 `api` must not be running once the schema is back at `0005`.

## W7a (2026-10-12, b933bc7)

One Assets workspace (tree and fleet summary) and the app shell with the navy top bar and breadcrumbs.

## W6 (2026-10-11, ffa44fd)

UI overhaul: a navy sidebar that can be minimized, the asset tree column, and restyled pages, dialogs, banners and forms (widgets unchanged).

## W3d follow-up (2026-10-11, b821ba7)

Passwords inside source URLs are scrubbed from the container logs, an account deleted mid-request answers 401, and the Audit filter refreshes after user changes.

## W3d (2026-10-11, 4ca1b6d)

The sign-in block is configurable and can be lifted per account, accounts can be deleted, and the user name and password inside a source's URL are never returned.

## W3c (2026-10-11, 8301733)

The Audit screen filters, searches, exports CSV, pages, jumps to a date, links each entry to what it is about and shows a friendly sentence next to the raw entry.

## W3b (2026-10-11, 03b3c6d)

Dashboards close up vertically, long names are shortened in legends and axes, the Trend refetches by range, and a parent asset shows the sum of its children's live power.

## W3a (2026-10-11, f0beeb8)

Add an asset under any branch, pick its kind from a list, a sortable and searchable points list, a mapping dialog with a unit warning, Edit on the Sources page, and an honest status for sources that are not polled.

## W2 Part B (2026-10-10, 1fec877)

Pinned base images and a re-pin command, the certificate expiry notice, security headers with a Report-Only content policy, and a notice when your role changes.

## W2 Part A (2026-10-10, f74eed0)

Backup and restore scripts that cannot reach the wrong stack, rotating verified backups, the Windows scripts, and the upgrade and go-back runbook.

## W1b (2026-10-10, ab0869c)

Storage, restore and name safety: a confirmation before retention deletes data, restore pauses retention, a warning when the secret key does not match, duplicate asset names refused, and non-finite readings and scales refused.

## W1a (2026-10-10, efc7e66)

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
   not use step 6 of the Phase 3 entry below for this: it returns to Phase 2 (schema `0003`), which is not a place to go back to from
   a `0004` or `0005` database (Alembic fails with an unknown revision). In both options a restart of the W1a `api` would run
   `alembic upgrade head` and apply `0005` again, so the W1a `api` must not be running again once the schema is back at `0004`.
   - **Option a, keep what was collected since the upgrade.** The `0005` downgrade drops the trigger, its function and the two snapshot
     columns, and `upgrade` rebuilds them from the users. That loses nothing for an entry whose user still exists; the names of
     users deleted after `0005` was applied are lost.
   - **Option b, restore the backup from step 1.** Everything collected since that backup is lost. The restore script is the one of
     the old commit (see step 5 of option b in "Upgrading and going back"). `--force` is needed: the volume
     still holds the W1a database (`0005`) and the dump's `.version` says `0004`, so the script refuses without it.

## W0b (2026-10-10, 60d8b65)

Log rotation, a graceful stop, a readiness health check, the collector heartbeat, and status writes off the poll path.

## W0a (2026-10-09, ec1062b)

UI and documentation fixes from the first manual acceptance pass.

## Phase 3 visual fixes (2026-10-09, e6ca151)

The time axis of energy and cost series is bounded to their range.

## Phase 3 (2026-10-09, 0ada373)

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

## Phase 2 (2026-10-08)

Network discovery: scan scopes, the scan job, the graph, drag-and-drop mapping and the audit log. Its merge commit is not named on purpose: a database at `0004` or later cannot go back to Phase 2 code (see the Phase 3 entry).

## Phase 1C (2026-10-07, 7ed2c44)

OPC UA and Modbus TCP connectors, the storage tiers and the backup scripts.

## Phase 1D (2026-10-07, dcbab5c)

Users, settings, hardening, optional TLS and the end-to-end tests.

## Phase 1B (2026-10-07, 25bf25a)

The React web UI served through Caddy.

## Phase 1A (2026-10-07, 552e9c7)

The backend, the collector and the API.
