# Upgrading and going back

Starting an `api` container from a newer image runs `alembic upgrade head`, which applies the release's migrations to your data: treat
"start the stack on the new code" as "upgrade the database". Do these steps for every upgrade. **Never use `docker compose down -v`**:
it deletes the database volume.

**The quick way on Windows: `scripts\update.ps1`.** One command does the safe version of steps 1, 4 and 5 below and shows you the
list of step 2. The manual steps below stay as the explanation and as the fallback (there is no shell twin for Linux yet, see the
backlog).

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1
```

What it does, in this order (each step prints a heading `== N/7 ... ==`):

1. **Checks this computer** and stops with the reason and the fix, before anything is touched, when: Docker does not answer, `.env`
   is missing, a tracked file is changed, you are not on `main`, a merge is half done, less than 5 GB of disk is free, the update would
   overwrite a file you copied in by hand, or another update is running.
2. **Shows where you are**: the commit, the database revision and the build that runs now.
3. **Shows what is coming**: it fetches, lists the new commits (the first 30), lists the new migration files with the sentence "This
   update changes the database", points at the release notes, and asks `Continue? (y/N)`.
4. **Backs up** with `backup.ps1`. If the backup fails, or `-CopyTo` could not copy it, nothing else is touched. It prints the commit,
   the revision and the backup path to write down, and keeps them in `logs\update-anchor.txt`.
5. **Brings the new code** with `git merge --ff-only`: never a merge commit.
6. **Builds and starts** with the commit as the build id (Settings then shows the commit, not `dev`), and waits up to 10 minutes: a
   migration can be long, the site is unavailable meanwhile and readings are not collected.
7. **Checks** that every service runs the image just built, that `alembic current` is the newest revision the code knows, that the
   collector keeps running and the four web checks of step 5 below, then prints a summary: old commit to new commit, old revision to
   new revision, the backup, the version Settings now shows, and the way back (step 6 below, with your commit and revision).

Every line is also written to `logs\update-<time>.log`. The script never runs `docker compose down`, a restore, a downgrade or a
prune, never deletes a volume or a dump, and never changes the code except by `git merge --ff-only`. Run it again after a failure: it
tells you what is wrong. "Already up to date" is printed only when every check passed; when the code is current but the containers
were built by hand (Settings shows `dev`), it rebuilds.

| Flag | Meaning |
|---|---|
| `-Branch main` | the branch to follow |
| `-CopyTo DIR` | passed to `backup.ps1` (see "Scheduled backups") |
| `-NoPull` | do not fetch or merge: back up, build and check the code that is checked out now (a detached HEAD is fine) |
| `-Yes` | do not ask `Continue? (y/N)` |
| `-DryRun` | the checks, the fetch and the lists are real; every other step is only printed; nothing is changed |
| `-Force` | rebuild even when the code and the running site are already current |

A bash-style `--dry-run`, `--no-pull` or `--copy-to` is refused with the usage line, never run for real (`--yes` and `--force` are
accepted as `-Yes` and `-Force`).

| Exit code | Meaning |
|---|---|
| 0 | done, or already current and healthy (also a finished `-DryRun`) |
| 1 | a check refused, you answered no, bad arguments, or another update is running (`backup.ps1` uses 2 for bad arguments; here 2 is the backup) |
| 2 | the backup failed or was not copied |
| 3 | the new code could not be fetched or applied |
| 4 | the build failed, or the stack did not start, become healthy or answer, or runs the wrong version |
| 5 | the database revision does not match the code |

**The first time:** the update that brings this script still uses the three commands, `.\scripts\backup.ps1`, `git pull` and
`docker compose up -d --build` (set the build id first, see "Build id" below, or Settings says `dev`). Do not copy `update.ps1` in by
hand before the pull: git then refuses to overwrite it, and the script refuses to start. From then on use the script.

**If the window shows "Waiting" for more than 10 minutes,** press Ctrl+C: nothing is lost, the backup path is on the screen and in the
log, and `docker compose logs api` says what the api is doing. On a development machine, `scripts/e2e.sh` re-tags the images the stack
uses, so the first update after it reports that the api still runs the old version: run it again with `-Force`.

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
   `--profile dev` on a stack that has the simulator; set `BUILDX_NO_DEFAULT_ATTESTATIONS` first, as "Upgrading images"
   below explains). Alembic prints nothing while it migrates, so watch
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

**Upgrading images.** The images the project builds on (`python`, `uv`, `node`, `caddy` and the TimescaleDB image of `db`) are pinned by
digest in `backend/Dockerfile`, `frontend/Dockerfile` and `compose.yaml`. A rebuild therefore no longer changes the base layers by
surprise, and a security fix in a base image only arrives when you re-pin. Run `scripts/pin_images.sh --update` before a release, or
monthly: it asks the registry for the digest of each tag and prints a before and after table (`--check` needs no network and fails
on an unpinned or malformed reference). Then rebuild, run the tests and commit the changed files. `backend/tests/conftest.py` pins
`timescale/timescaledb:2.30.2-pg16` for the test database separately, and is re-pinned by hand with the others.

The first `docker compose up -d` after the digests arrived recreates `db` as well as the other services, once: the `image:` line of
`db` gained the digest, which changes its configuration although the image is the same. The database is unavailable for a short
while, and `api` and `collector` restart too. The data volume is kept. Take a backup first, as for any upgrade (step 1 above, and
"Backup and restore").

`scripts/setup.sh` and `setup.ps1` set `BUILDX_NO_DEFAULT_ATTESTATIONS=1` before they build, so running them again when nothing changed
keeps the running containers. A hand-typed `docker compose up -d --build` should set it first (bash: `export BUILDX_NO_DEFAULT_ATTESTATIONS=1`;
PowerShell: `$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '1'`). Without it every build gives `api` and `web` a new image id, because the default
attestation record is part of the id, and `up -d` recreates `api`, `collector`, `web` and `simulator` (about 12 s without service) even
though nothing changed; `db` is kept after that first time (the one described above). The first run after adopting the variable recreates them once.

**Build id.** The backend images carry the commit they were built from, so a diagnostics report (and Settings, and `GET /api/version`)
proves which code produced it. `scripts/setup.sh`, `setup.ps1` and `e2e.sh` pass it on by themselves. For a hand-typed
`docker compose build` or `up -d --build`, set the two variables first (bash:
`export DCDASH_BUILD_ID=$(git describe --always --dirty) DCDASH_BUILD_TIME=$(git log -1 --format=%cI)`; PowerShell:
`$env:DCDASH_BUILD_ID = git describe --always --dirty; $env:DCDASH_BUILD_TIME = git log -1 --format=%cI`); without them the images say
`dev` / `unknown`. The id is the commit, with `-dirty` while tracked files differ from it, and the time is the commit's, never the
clock of the build, so building the same tree again changes nothing. A new id (a new commit, or `-dirty` appearing) rebuilds the
last image layer and recreates `api`, `collector` and `simulator` once. The `web` image carries no build id.
