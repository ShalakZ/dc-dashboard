# Backup and restore

This page is for whoever looks after an installation's data: how to back up the database, how to restore a dump, what a backup does
not hold, and how to practise a restore before you need one. Running backups on a schedule is on [Scheduled backups](scheduled-backups.md).

Both scripts talk to the `db` container of the running stack (`.ps1` twins exist for Windows).

    scripts/backup.sh [out_dir] [--keep N] [--copy-to DIR]   # ./backups/dcdash-YYYYmmdd-HHMMSS.dump + .dump.version (Alembic revision)
    scripts/restore.sh <dump> [--force] [--apply-retention]  # reads the dump, stops api+collector, recreates the database, restores, restarts

A self-test that runs both in a throwaway Compose project of its own, never in your stack, is
`OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh` (see [Practise a restore](#practise-a-restore)).

Windows PowerShell (run them like this):

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\backup.ps1 [Out] [-Keep N] [-CopyTo DIR]
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore.ps1 <dump> [--force] [--apply-retention]

`-ExecutionPolicy Bypass` applies to that one process and changes nothing on the machine. It is there because the default
policy refuses scripts: `Restricted` (Windows 10/11) refuses every script, `RemoteSigned` (Windows Server) one that came over a share or a download. `-File` (not `-Command`) matters for
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
therefore never replaces or evicts a good backup. After every backup it says that `.env` and `certs/` are not in the dump (see
[What the backup does not contain](#what-the-backup-does-not-contain)). With Docker stopped it cannot reach the database: it prints `pg_dump failed; no backup was made and no old
backup was touched` and exits 1 (read from the script; not tried with Docker stopped).

| Exit | `backup.sh` / `backup.ps1` | `restore.sh` / `restore.ps1` |
|---|---|---|
| 0 | the backup was made (and copied, when `--copy-to` was given) | restored |
| 1 | failed: `pg_dump` failed, the dump was empty or cannot be read back, another backup is running in that folder (one at a time per output folder), or a backup with this timestamp exists. Nothing was created, nothing deleted | the dump file does not exist (`no such dump file`) or cannot be read (cut off, damaged): refused up front, "nothing was changed". Or something failed after `api` and `collector` were stopped but before the dump was loaded (the `DROP`/`CREATE DATABASE` step, say): they are started again, the database may be missing or empty, run the restore again with the same dump. Or the restore failed after the database was replaced: read the messages and the log path it prints (it still runs `timescaledb_post_restore()` and starts `api` and `collector`, so the database may be partly restored) |
| 2 | usage error (`--keep` outside 1 to 99999, an unknown argument, a `%` in the output folder on Windows; PowerShell's own parameter errors, such as a missing value or a duplicate parameter, exit 1 instead) | usage error (no dump named, an unknown argument, a `%` in the dump path on Windows) |
| 3 | - | the dump's `.version` differs from the running schema (needs `--force`) |
| 4 | - | restored, but the retention check failed (see "Retention and a restore" below) |
| 5 | **the local backup was made but NOT copied**; nothing was rotated | - |

Exit 5 and the copy folder are explained on [Scheduled backups](scheduled-backups.md).

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

## What the backup does not contain

The dump is the database only. `.env` is not in it, and `.env` holds `DCDASH_SECRET_KEY`, the key that encrypts the
passwords and keys stored for your sources. `certs/` (the HTTPS key and certificate, and an OPC UA client certificate if you
use one) is not in it either. Keep a copy of `.env` and `certs/` with every backup, off the machine. The scripts never copy them, not
even with `--copy-to`; `backup.sh` says so after every backup.

The api checks the key when it starts. It test-decrypts the stored source secrets and, once every one of them decrypts, stores a
fingerprint of `DCDASH_SECRET_KEY` in the database (`settings`, key `secret_key_check`; it cannot be turned back into the key). If some cannot be decrypted,
the api log names the sources, and the Sources page shows a banner to operators and admins until the original `.env` is back or the
secrets are typed in again.

- **Restoring on a new machine:** put that `.env` and `certs/` in place, run `scripts/setup.sh`, then `scripts/restore.sh <dump>`
  (the whole sequence, with the checks, is under [Practise a restore](#practise-a-restore)).
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

## After a restore

Every collector start, including the one at the end of a restore, rewrites the stored scan network (`collector_networks`)
with the /24 around the collector's own addresses, so the targets pre-filled in a new scope follow this installation, not
the restored data. Check them before the first scan.

## Practise a restore

A backup you have never restored is a guess. Practise the restore before you need it, and again after you change anything about how
backups are made. The sequence for a new machine (or a machine whose stack you have lost):

1. Install Docker (Docker Desktop on Windows) and get the code. Check out the commit the dump was made on, or a later one: the
   dump's `.version` file says which schema it has (see [Upgrading and going back](upgrading.md) for what a different schema means).
2. Put the copies of `.env` and `certs/` that you kept with the dump in place (see
   [What the backup does not contain](#what-the-backup-does-not-contain); the HTTPS key needs the owner and mode from
   [Optional HTTPS](install-and-run.md#optional-https)).
3. `scripts/setup.sh` (Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1`). It leaves an existing
   `.env` alone, and refuses to create a new one when the database volume already exists. It prints
   `starting Compose project: <name>`; check the name.
4. `scripts/restore.sh <dump>` (Windows: `scripts\restore.ps1`, started the way the top of this page shows). Check the first line,
   `restoring into Compose project: <name>`. A dump from an older schema needs `--force`; a dump from a newer one must not be restored.
   Read the retention table it prints: if it says `Retention is PAUSED`, decide on the Storage page before you press Save (see
   "Retention and a restore").
5. Check: `docker compose ps` shows `db`, `api` and `web` healthy; `docker compose exec api alembic current` prints the head revision;
   `scripts/check_web.sh` prints nine `ok` lines (see [step 5 of the upgrade](upgrading.md#the-steps)); sign in with the account from the old system; on the Sources page no source says
   `stored secret cannot be decrypted` (it does when `.env` is not the original) and the Last reading ages shrink once the collector
   runs; check the scan targets in a new scope before the first scan (see [After a restore](#after-a-restore)).

What the drills did and did not cover. Run for real, in throwaway Compose projects: on Windows `setup.ps1`, `backup.ps1` (with
`-Keep` and `-CopyTo`), `restore.ps1` and a Task Scheduler task; on Linux `backup.sh` (with `--keep` and `--copy-to`: rotation, the
marker file, every exit 5 case, the usage errors, a second backup at the same time, a dump dated in the future, and the database
stopped), `restore.sh` (with and without `--force`, with `--apply-retention`, with a cut-off dump and with a missing one), both
"going back" options of [Upgrading and going back](upgrading.md), and the two self-test scripts below. Not run for real: `setup.sh` (its Windows
twin `setup.ps1` was), Docker Desktop stopped under `backup.ps1`, a cron or Task Scheduler trigger firing by itself, a copy drive
pulled out in the middle of a copy, and a restore on a second machine from a dump and an `.env` that were carried over.

**The self-test.** `OPS_COMPOSE_PROJECT=dcdash_e2e_drill scripts/backup_smoke.sh` builds a throwaway stack of its own, backs it up,
deletes an asset, checks that a dump with a wrong `.version` is refused (exit 3), restores, checks that the asset is back, and then
checks that a corrupted dump is refused with nothing changed (exit 1, `api` still running). It removes its project and its volume
when it ends (run for real: it ended with `backup smoke OK` and `restore failure-path OK`, and left no container or volume). `scripts/check_tls.sh` is the same kind
of script for HTTPS (see [Optional HTTPS](install-and-run.md#optional-https)). Both:

- need a project name that starts with `dcdash_e2e`, followed only by lower-case letters, digits, `_` or `-` (`OPS_COMPOSE_PROJECT` picks it; without it `backup_smoke.sh` uses
  `dcdash_e2e_smoke` and `check_tls.sh` uses `dcdash_e2e_tls`) and refuse any other name, so they cannot be pointed at the project with
  your data (`dcdash`, volume `dcdash_dbdata`);
- build images of their own (`<project>-backend:scratch`, `<project>-web:scratch`) and make up a database password and a secret key
  for the run, so `dcdash-backend:local`, `dcdash-web:local` and your `.env` are not used or changed. They remove their containers,
  network and volume when they end but leave those images behind (the drill left three); remove them with
  `docker image rm <project>-backend:scratch <project>-web:scratch` when you do not need the build cache they hold;
- publish what they publish (`check_tls.sh`: the `web` service) only on `127.0.0.1:18080` and `127.0.0.1:18443`
  (`SCRATCH_HTTP_PORT` and `SCRATCH_HTTPS_PORT` change the numbers, from 1024 to 65535), never on ports 80 and 443.

They are bash scripts: on Windows run them from WSL. Both share `scripts/lib/scratch.sh`, which sets up the throwaway project.

Related: [Scheduled backups](scheduled-backups.md), [Upgrading and going back](upgrading.md), [Storage](storage.md),
[End-to-end tests](end-to-end-tests.md).
