# Upgrading and going back

This page is for whoever updates an installation to newer code: how to upgrade safely, how to check the result and how to go back when
something is wrong. Starting an `api` container from a newer image runs `alembic upgrade head`, which applies the release's migrations
to your data: treat "start the stack on the new code" as "upgrade the database". Do the steps below for every upgrade. **Never use
`docker compose down -v`**: it deletes the database volume.

## The quick way on Windows: `scripts\update.ps1`

One command does the safe version of steps 1, 4 and 5 below and shows you the list of step 2. The numbered steps stay as the
explanation and as the fallback; there is no `update.sh` for Linux yet, so on Linux use the steps.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1
```

What it does, in this order (each step prints a heading `== N/7 ... ==`):

1. **Checks this computer** and stops with the reason and the fix, before anything is touched, when: git or Docker is missing or Docker
   does not answer, `docker compose` is missing, the folder is not a git checkout or its path holds a `%`, `.env` is missing or has no
   `DCDASH_DB_PASSWORD`, nothing is installed yet (no containers and no database volume: run `scripts\setup.ps1` first), a tracked file
   is changed, a merge, rebase or cherry-pick is half done, the checkout is not on the branch it follows (`-Branch`, default `main`), less
   than 5 GB of disk is free, or another update is running.
2. **Shows where you are**: the commit, the database revision and the build that runs now.
3. **Shows what is coming**: it fetches, stops when the update would overwrite a file you copied in by hand, lists the new commits (the
   first 30), lists the new migration files with the sentence "This update changes the database", names the release notes
   (`CHANGELOG.md`), and asks `Continue? (y/N)`.
4. **Backs up** with `backup.ps1`. If the backup fails, or `-CopyTo` could not copy it, nothing else is touched. It prints the commit,
   the revision and the backup path to write down, and keeps them in `logs\update-anchor.txt` until an update finishes.
5. **Brings the new code** with `git merge --ff-only`: never a merge commit.
6. **Builds and starts** with the commit as the build id (Settings then shows the commit, not `dev`), and waits up to 10 minutes: a
   migration can be long, the site is unavailable meanwhile and readings are not collected.
7. **Checks** that every service runs the image just built, that `alembic current` is the newest revision the code knows, that the
   collector keeps running, and the four web checks of step 5 (with HTTPS on, the web service's own health check stands in for them),
   then prints a summary: old commit to new commit, old revision to new revision, the backup, the version Settings now shows, and the
   way back (step 6, with your commit and revision).

Every line is also written to `logs\update-<time>.log`. The script never runs `docker compose down`, a restore, a downgrade or a
prune, never deletes a volume or a dump, and never changes the code except by `git merge --ff-only`. Run it again after a failure: it
tells you what is wrong. "Already up to date" is printed only when every check passed; when the code is current but the containers
were built by hand (Settings shows `dev`), it rebuilds.

| Flag | Meaning |
|---|---|
| `-Branch main` | the branch to follow |
| `-CopyTo DIR` | passed to `backup.ps1` (see [Scheduled backups](scheduled-backups.md)) |
| `-NoPull` | do not fetch or merge: back up, build and check the code that is checked out now (a detached HEAD is fine) |
| `-Yes` | do not ask `Continue? (y/N)` |
| `-DryRun` | the checks, the fetch and the lists are real; every other step is only printed; nothing is changed |
| `-Force` | rebuild even when the code and the running site are already current |

A bash-style `--dry-run`, `--no-pull` or `--copy-to` is refused with the usage line, never run for real (`--yes` and `--force` are
accepted as `-Yes` and `-Force`). Five environment variables change its waits; a value that is not a positive number is ignored:
`DCDASH_UPDATE_POLL_SECONDS` (5), `DCDASH_UPDATE_WAIT_SECONDS` (600), `DCDASH_UPDATE_DB_WAIT_SECONDS` (120),
`DCDASH_UPDATE_MIN_FREE_GB` (5) and `DCDASH_UPDATE_REPORT_SECONDS` (60).

| Exit code | Meaning |
|---|---|
| 0 | done, or already current and healthy (also a finished `-DryRun`) |
| 1 | a check refused, you answered no, bad arguments, or another update is running (`backup.ps1` uses 2 for bad arguments; here 2 is the backup) |
| 2 | the backup failed or was not copied |
| 3 | the new code could not be fetched or applied |
| 4 | the build failed, or the stack did not start, become healthy or answer, or runs the wrong version |
| 5 | the database revision does not match the code |

**The first time:** the update that brings this script still uses the three commands, `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1`, `git pull` and
`docker compose up -d --build` (set the build id first, see [Build id](#build-id), or Settings says `dev`). Do not copy `update.ps1` in
by hand before the pull: git then refuses to overwrite it, and the script refuses to start. From then on use the script.

**If the window shows "Waiting" for more than 10 minutes,** press Ctrl+C: nothing is lost, the backup path is on the screen and in the
log, and `docker compose logs api` says what the api is doing. On a development machine, `scripts/e2e.sh` re-tags the images the stack
uses, so the first update after it reports that the api still runs the old version: run it again with `-Force`.

## The steps

1. **Back up first, and write down where you are.**
   - `scripts/backup.sh --copy-to <folder>` (Windows: `backup.ps1 -CopyTo <folder>`; the copy folder is explained on
     [Scheduled backups](scheduled-backups.md), and plain `scripts/backup.sh` does when you have none). The `db` container must be
     running. If the stack is not running, start only the database with `docker compose up -d db` (`db` has no dependencies and uses
     the TimescaleDB image, so `api` is not created and nothing is migrated). Do not use a plain `docker compose up -d` yet. Keep both
     files the script writes, the `.dump` and the `.version` file.
   - Note the commit you run now (`git rev-parse --short HEAD`) and the revision (`docker compose exec api alembic current`): going
     back needs both.
   - A scheduled `--keep N` deletes dated dumps after N more nights. If you may need this one longer, copy both files of the pair
     under another name (`before-upgrade.dump` and `before-upgrade.dump.version`); `--keep` never touches other names.
   - Keep a copy of `.env` and `certs/` as well (see
     [What the backup does not contain](backup-and-restore.md#what-the-backup-does-not-contain)).
2. **Read the release notes** in [CHANGELOG.md](../CHANGELOG.md) (releases up to W7j are in the [changelog archive](changelog-archive.md)). Its entries are newest first: read every entry between the version
   you run and the new one, starting at the oldest entry you have not applied. Each entry says what it changes, which pre-checks it
   names, how to verify it, whether its downgrade is lossless and which commit to go back to. Each heading carries the wave's date and
   merge commit; [Migrations in order](#migrations-in-order) lists which entry brings which migration.
3. **Do the pre-checks the notes name**, and stop if one says to.
4. **Apply.** Get the new code (`git pull`, or check out the commit you want), then `docker compose up -d --build` (add
   `--profile dev` on a stack that has the simulator; set `BUILDX_NO_DEFAULT_ATTESTATIONS` first, as
   [Upgrading images](#upgrading-images) explains). Alembic prints nothing while it migrates, so watch
   `docker compose logs -f api` until Uvicorn's start-up lines appear (`Application startup complete`); a migration that fails prints
   an error instead. If Compose reports `api` unhealthy, or a dependency failed, while a long migration was running, wait for Uvicorn
   to start and run the same `up -d` again (it is safe); `web` and `collector` start once `api` is healthy. Collection pauses while
   the migration runs, so readings for that interval are not collected. If your Docker stops with an image tag that "already exists"
   (the drills did not see this: `up -d --build` and `build` ran clean although the backend services share one image tag), run
   `docker compose build api web` and then `docker compose up -d`.
5. **Verify.** `docker compose exec api alembic current` prints the revision the release notes name (for example `0005 (head)`).
   `scripts/check_web.sh` (it takes the address as an optional first argument, default `http://localhost`) prints nine lines that end
   in `ok`: first index, spa fallback, api proxy and stream route (the four web checks `update.ps1` runs), then five checks of the
   static-file headers. A failure among the first four only leaves its line out, so count the lines; a later check that fails prints
   `FAIL` and stops. The Sources page shows no collector notice and the Last reading ages stay small once the collector runs; then do
   the extra checks of the release notes.
6. **Going back.** The release notes say which of the two ways is open. Two rules hold for both. First, go back to the commit you noted
   in step 1, the code that matches the revision you noted and the dump, and **not further**: the code must know the revision the
   database ends up at, and older code fails on start with an unknown revision. With a database at `0004` or `0005` the Phase 2 code
   (schema `0003`) is not a place to go back to. Second, a restart of the new `api` would run `alembic upgrade head` and apply the
   migration again, so the new `api` must not be running again once the schema is back; the orders below make sure of that.
   Afterwards `git checkout main` (or the branch you came from) returns to the new code; `.env` and `backups/` are not in git, so they
   stay. This page changes with the checkout, so copy these steps somewhere first.
   - **Option a, keep what was collected since the upgrade.** Only when the release notes say that the downgrade of this release is
     lossless. `<previous>` is the revision you noted in step 1, `<old commit>` the commit.
     1. `docker compose stop collector`.
     2. `docker compose exec api alembic downgrade <previous>`.
     3. `docker compose stop api` at once.
     4. `git checkout <old commit>`.
     5. `docker compose up -d --build` (add `--profile dev` on a stack that has the simulator). The new `api` runs
        `alembic upgrade head` on the old code, where `<previous>` is the head: nothing to do.
     6. `docker compose exec api alembic current` prints `<previous> (head)`.
   - **Option b, restore the dump from step 1.** It works for every release, and everything collected since that dump is lost (a billing month closed since the dump is open again). Do it
     with the old code and with no new container left to be restarted. Restoring the dump on the new image would not undo the
     upgrade: the last step of `restore.sh` starts the existing `api` and `collector` containers, and they run the migration again.
     1. `docker compose --profile dev rm --stop --force api collector web simulator` removes the new containers (containers only:
        never the `dbdata` volume, and `db` is left alone). Do not add `-v`.
     2. `git checkout <old commit>`.
     3. `docker compose build` builds the images of the old code (see step 4 for a tag that "already exists").
     4. `docker compose up -d db` (a no-op when `db` is already running).
     5. `scripts/restore.sh backups/<dump file> --force`. This is the script of the OLD commit you checked out in step 2, not the
        current one: depending on its age it may not print the project line, may not read the dump first and may not pause retention,
        so expect fewer messages than [Backup and restore](backup-and-restore.md) describes (the drill of option b ran the old script
        of `1ef27a2`). `--force` is needed when the volume holds a newer revision than the dump's `.version` says: without it the
        script refuses (exit 3). It is not needed when the migration never ran. The script drops and recreates the database from the
        dump (read the retention table it prints). Its last step, `docker compose start api collector`, finds no containers and prints
        `collector is missing dependency api`, which the script ignores by design.
     6. `docker compose --profile dev up -d` creates fresh containers of the old code; on the restored database Alembic has
        nothing to do. `docker compose exec api alembic current` prints the dump's revision.

Both options were run step by step as written, in a throwaway Compose project, on `1ef27a2` (schema `0004`) upgraded to `a6d11e1`
(schema `0005`). Option a was lossless: the asset made and the readings collected after the upgrade were still there, and
`alembic current` printed `0004 (head)`. Option b refused without `--force` (exit 3), restored with it (exit 0, and the ignored
message appeared as described), and lost what came after the dump.

## Migrations in order

The files are in `backend/migrations/versions/`; each revises the one before it, and `0016` is the head. The release-note entry of a
migration says how to apply it, how to verify it and the commit to go back to.

| Revision | What it does | Downgrade | Release note |
|---|---|---|---|
| `0001` | the initial schema | before the release notes; its downgrade drops every table | none |
| `0002` | storage tiers: compression, the 1-minute and 1-hour rollups, retention, the storage settings | before the release notes; its downgrade drops the rollups and the policies | none |
| `0003` | discovery: scan scopes, scans, findings, the graph layout, `sources.origin` | before the release notes; its downgrade drops those tables and the column | none |
| `0004` | billing and dashboards: tariffs, dashboards, widgets, the billing setting, 7-day rollup refresh windows, minutes in the hourly rollup | **not lossless**: option b only | [Phase 3](changelog-archive.md#upgrading-an-existing-database-to-phase-3) |
| `0005` | the audit actor: who did an entry survives the deletion of the account | lossless except the names of accounts deleted after the upgrade | [W1a](changelog-archive.md#upgrading-to-w1a-migration-0005) |
| `0006` | the diagnostic event journal behind the field-diagnostics report (`diag_events`) | lossless except the journal itself | [W8](changelog-archive.md#upgrading-to-w8-migration-0006) |
| `0007` | per-account appearance (`users.preferences`) | lossless except the display choices | [W7d](changelog-archive.md#upgrading-to-w7d-migration-0007) |
| `0008` | a chosen icon per asset (`assets.icon`) | lossless except the icon choices | [W7g](changelog-archive.md#upgrading-to-w7g-migration-0008) |
| `0009` | roles and permissions: the `roles` table, `users.role_id` in place of `users.role` | lossless for accounts that hold Viewer, Operator or Admin; custom roles are lost and their accounts come back as Viewers | [W9a](../CHANGELOG.md#upgrading-to-w9a-migration-0009) |
| `0010` | the asset kinds registry (`asset_kinds`), seeded from the kinds assets already use | lossless except the registry (icons go back to the keyword guess) | [W7m](../CHANGELOG.md#upgrading-to-w7m-migration-0010) |
| `0011` | data only: the permission Manage asset kinds (`assets.kinds`) for the custom roles that could change kinds | lossless for the data; only which permissions a custom role lists changes | [W7o](../CHANGELOG.md#upgrading-to-w7o-migration-0011) |
| `0012` | close month: the `billing_closes` table (a closed billing month's stored figures) | lossless for everything that existed before; a downgrade drops the closed months (and a restore of an older dump brings back the older set) | [W11](../CHANGELOG.md#upgrading-to-w11-migration-0012) |
| `0013` | text widget: the widget type CHECK allows `text` | lossless while no text widget exists; refuses while one does: remove them first | [w22](../CHANGELOG.md#upgrading-to-w22-migration-0013) |
| `0014` | the figure ledger: the table `figure_ledger` (derived data: computed figures kept between requests) | lossless except the stored figures, which are recomputed (the downgrade drops the table) | the w26b entry in the [CHANGELOG](../CHANGELOG.md) |
| `0015` | display screens: three empty tables, `playlists`, `playlist_items` and `displays` | lossless for everything older; the downgrade drops the three tables and loses the playlists and display links | the w28 entry in the [CHANGELOG](../CHANGELOG.md) |
| `0016` | a unique key on readings (`readings_point_ts_key`, in place of the plain index `readings_point_ts`) and the small table `history_status` (the history fill's progress per source) | lossless: the downgrade builds the plain index again and drops `history_status`, which is derived data | the w30 entry in the [CHANGELOG](../CHANGELOG.md), and [`0016`](#0016-and-the-history-fill-w30) below |

Waves without a migration also have entries in the CHANGELOG (for example W7p, no migration): read them too, they can name checks.

**`0014` and the `figures` service (w26b).** The migration only adds the table `figure_ledger`, empty at first (nothing else changes); the
`figures` service fills it. The service is new in `compose.yaml` and starts with the ordinary `docker compose up -d`.
`scripts\update.ps1` starts it the same way but does not list it in its health checks, so after an update look at `docker compose ps`:
`figures` should be `healthy` within a few minutes. If it is not running the pages are only slower, never wrong. An older image left
running beside the new table is harmless: the old code ignores the table. Going back to code from before w26b: stop `figures` first
(`docker compose stop figures`), because the old `compose.yaml` does not know the service and would leave its container running. Remove
the container one of two ways. Either while the new checkout is still in place (before the `git checkout`), run
`docker compose rm --stop --force figures` (option b: the same as adding `figures` to the `rm` line of its step 1); or leave it and add
`--remove-orphans` to the next `up -d` that you run from the OLD checkout, whose compose file no longer has the service. There is no
need for `docker compose down --remove-orphans` (it would also take every other container down). Not rehearsed.

### `0016` and the history fill (w30)

**What it changes.** Two things, and no reading and no figure changes.
- A unique key on `readings` (`readings_point_ts_key`): the database now refuses a second reading with the same point and the same time.
  It replaces the plain index `readings_point_ts` (the same columns in the same order, so every query that used the old index can use
  the new one).
- The table `history_status`, empty at first: one row per source that says how far the history fill has got
  ([Sources and discovery](sources-and-discovery.md#history-and-backfill)). It is derived data, written by the collector.

**What an update looks like.** The first start of the new `api` runs the migration. On a copy of the development database (400 MB,
4,269,975 readings) it took 4.2 seconds, 2.4 of them spent counting duplicates. On a database of 1.6 GB expect up to about 20 seconds;
that is the measurement scaled up, not a measurement. Do not stop it. While the unique key is built, writes to `readings` wait (the
longest wait of a writer in the drill was 0.89 seconds) and reads do not. The new key is built before the old index is dropped, so for a
moment the database holds both (about 104 MB each on the copy), and then one. Collection pauses while the migration runs, as in step 4
above.

**If it refuses.** If some reading is stored more than once, the migration stops before it changes anything. Its message starts
`migration 0016 was stopped before it changed anything, because readings holds N reading(s) that are stored more than once`. The
database is still at the revision it was at before, and the `api` restarts in a loop and stops here every time until you stop it:
`docker compose stop api`. Then follow [Duplicate readings](#duplicate-readings). A migration never deletes a reading: which copy is the
right one is for a person to decide, and a downgrade could not put a deleted reading back. A second refusal exists for a busy
database: `migration 0016 could not get the lock it needs on readings within 120 seconds`. A long query or a writer held the lock,
nothing was changed, and starting the `api` again is usually enough. If the refusal repeats, stop `figures` and `collector` for a minute
(the figures worker can hold one long query, up to two minutes) and start again.

**Going back.** Lossless; use option a of step 6 with `alembic downgrade 0015` and the code from before w30 (`de67feb`, or the commit you
noted in step 1). The downgrade drops `history_status`, builds the plain index again, and drops the unique key last, so there is never
a moment without an index. It took 1.9 seconds on the copy, and every table was identical to its state before the upgrade (counts and row
hashes). Afterwards a reading can be stored twice again, as before. Upgrading once more (7.0 seconds on the copy) builds the key and an
empty `history_status`; the history fill then starts again from its lookback, and the store ignores whatever it already has.

## Duplicate readings

Read this when the update to migration 0016 refused because some readings are stored more than once. Everything here only reads: nothing
in this section changes the database.

1. **Stop the `api`**, so that it stops restarting: `docker compose stop api`. The `db` container stays up.
2. **Back up.** `scripts/backup.sh` (Windows: `scripts\backup.ps1`), and keep both files it writes, the `.dump` and the `.version` file.
3. **List the duplicates.** Open `docker compose exec db psql -U dcdash -d dcdash` and paste the two statements. The first counts the
   pairs (a pair is one point at one time) and the readings beyond the first of each; the second lists at most 50 of them, with the
   lowest and the highest value stored, so you can see whether the copies agree. Counting reads the whole table: it took 2.6 seconds
   on 4.3 million readings.

   ```sql
   SELECT count(*) AS pairs, coalesce(sum(n - 1), 0) AS extra_rows
   FROM (SELECT point_id, ts, count(*) AS n FROM readings GROUP BY point_id, ts HAVING count(*) > 1) d;

   SELECT point_id, ts, count(*) AS times_stored, min(value) AS lowest, max(value) AS highest
   FROM readings
   GROUP BY point_id, ts
   HAVING count(*) > 1
   ORDER BY point_id, ts
   LIMIT 50;
   ```

4. **Send the output to support**: the migration's message, the count and the list (in the field-debugging loop, paste them into a
   Claude session with the message template of [Field debugging](field-debugging.md)). Do not delete anything by hand before then. The
   platform never removes readings by itself.
5. **Start again** with `docker compose up -d` once the duplicates have been dealt with. The migration runs from the beginning and counts
   again.

No code of the platform stores a reading twice, so duplicates in a database mean that something wrote into it from outside the
platform.

## Upgrading images

The images the project builds on (`python`, `uv`, `node`, `caddy` and the TimescaleDB image of `db`) are pinned by digest in
`backend/Dockerfile`, `frontend/Dockerfile` and `compose.yaml`. A rebuild therefore does not change the base layers by surprise, and a
security fix in a base image only arrives when you re-pin. Run `scripts/pin_images.sh --update` before a release, or monthly: it asks
the registry for the digest of each tag and prints a before and after table (`--check` needs no network and fails on an unpinned or
malformed reference). Then rebuild, run the tests and commit the changed files. `backend/tests/conftest.py` pins
`timescale/timescaledb:2.30.2-pg16` for the test database separately, and is re-pinned by hand with the others.

The first `docker compose up -d` after the digests arrived recreates `db` as well as the other services, once: the `image:` line of
`db` gained the digest, which changes its configuration although the image is the same. The database is unavailable for a short
while, and `api` and `collector` restart too. The data volume is kept. Take a backup first, as for any upgrade (step 1 above; the scripts
are on [Backup and restore](backup-and-restore.md)).

`scripts/setup.sh` and `setup.ps1` set `BUILDX_NO_DEFAULT_ATTESTATIONS=1` before they build, so running them again when nothing changed
keeps the running containers. A hand-typed `docker compose up -d --build` should set it first (bash:
`export BUILDX_NO_DEFAULT_ATTESTATIONS=1`; PowerShell: `$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '1'`). Without it every build gives `api`
and `web` a new image id, because the default attestation record is part of the id, and `up -d` recreates `api`, `collector`, `web` and
`simulator` (about 12 s without service) even though nothing changed; `db` is kept after that first time (the one described above).
The first run after adopting the variable recreates them once.

## Build id

The backend images carry the commit they were built from, so a diagnostics report (and Settings, and `GET /api/version`) proves which
code produced it. `scripts/setup.sh`, `setup.ps1`, `e2e.sh` and `update.ps1` pass it on by themselves. For a hand-typed
`docker compose build` or `up -d --build`, set the two variables first:

```bash
export DCDASH_BUILD_ID=$(git describe --always --dirty) DCDASH_BUILD_TIME=$(git log -1 --format=%cI)
```

```powershell
$env:DCDASH_BUILD_ID = git describe --always --dirty; $env:DCDASH_BUILD_TIME = git log -1 --format=%cI
```

Without them the images say `dev` / `unknown`. The id is the commit, with `-dirty` while tracked files differ from it, and the time is
the commit's, never the clock of the build, so building the same tree again changes nothing. A new id (a new commit, or `-dirty`
appearing) rebuilds the last image layer and recreates `api`, `collector` and `simulator` once. The `web` image carries no build id.

Related: [Backup and restore](backup-and-restore.md), [Scheduled backups](scheduled-backups.md), [CHANGELOG](../CHANGELOG.md),
[Install and run](install-and-run.md).
