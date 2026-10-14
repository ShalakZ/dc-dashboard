# Scheduled backups

This page is for whoever sets up an installation's nightly backups: how to run the backup script from cron or Task Scheduler, how to
read its result, and how `--keep` and `--copy-to` behave. What the scripts do, and how to restore, is on
[Backup and restore](backup-and-restore.md).

Nothing in the stack takes backups by itself. Run `scripts/backup.sh` (or `backup.ps1`) from the machine's scheduler, with a folder
for the local copies, `--keep N` so that the folder does not fill the disk, and `--copy-to` a folder on another drive or share, so
that a lost disk does not take the backups with it.

**Linux (cron).** This is an example: the cron entry itself was not run (the script it calls, with `--keep` and `--copy-to`, was; see
[Practise a restore](backup-and-restore.md#practise-a-restore) for what was proved how). The cron user must be
allowed to run `docker`. cron keeps no exit code, so send the output to a file and look at it (an exit 5 shows as the line
`local backup made, NOT copied; nothing was rotated (exit 5)`):

    0 2 * * * cd /path/to/DC_Dashboard && scripts/backup.sh /var/backups/dcdash --keep 14 --copy-to /mnt/offsite >> "$HOME/dcdash-backup.log" 2>&1

**Windows (Task Scheduler).** A task with this action and principal was registered and started by hand with `Start-ScheduledTask` for
real: it ended with `LastTaskResult` 0, and, with a copy folder that did not exist, with 5. The trigger line is the standard
PowerShell form and was not run:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\DC_Dashboard\scripts\backup.ps1" -Keep 14 -CopyTo D:\backups'
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive   # runs only while this user is logged on
Register-ScheduledTask -TaskName dcdash_backup -Action $action -Trigger $trigger -Principal $principal
(Get-ScheduledTaskInfo -TaskName dcdash_backup).LastTaskResult   # 0 ok, 1 failed, 5 made but not copied
```

- Docker Desktop must be running in that user's session, and the copy drive must be mounted, when the task fires. With Docker not
  running the script exits 1 and makes no backup (see [Backup and restore](backup-and-restore.md)).
- With `-LogonType Interactive` the task runs only while that user is logged on. After a reboot without a logon, or with the machine
  asleep at the trigger time, it does not run, and `LastTaskResult` keeps the PREVIOUS result: a `0` there can be stale. Read
  `(Get-ScheduledTaskInfo -TaskName dcdash_backup).LastRunTime` as well (or the date of the newest file in the backup folder), and
  consider `New-ScheduledTaskSettingsSet -StartWhenAvailable` on the `Register-ScheduledTask` call so that a missed run starts as
  soon as the machine is back (not tried).
- `-File` (not `-Command`) is what hands exit code 5 to Task Scheduler. `-ExecutionPolicy Bypass` applies to that process only and
  changes nothing on the machine; without it the default policy refuses the script (`Restricted` on Windows 10/11; `RemoteSigned` on Windows Server when it came over a
  share or a download).
- The task's environment has no `COMPOSE_PROJECT_NAME`, so it acts on the Compose project named in the `compose.yaml` next to the
  script it runs, unless a `.env` next to it sets `COMPOSE_PROJECT_NAME` (Compose reads that variable from `.env` too; the drill's
  `.env` did not set it).
- `backup.ps1` leaves a permanent, empty file `.dcdash-backup.lock` in the output folder (the one-backup-at-a-time lock; `backup.sh`
  locks the folder itself, leaves no file, and only warns when `flock` is not installed). Do not delete it while a backup runs. Folders with spaces, `&` and `()` in their
  names work; a `%` in the output folder is refused with exit 2.

**Read the result.** `0` is a backup. `1` is no backup (and nothing was deleted). **`5` means the local backup was made but NOT copied**
and nothing was rotated, anywhere. A task list that only shows that the task ran looks the same for `0` and `5`, so read
`LastTaskResult` (or the cron log) and treat anything but `0` as a failure to be looked at. Even `0` does not prove that old backups
were rotated: the line `not rotating` in the log says rotation was skipped (see `--keep` below). While the copy drive stays absent the
local folder is never rotated, so it grows without limit, and the database volume may be on the same disk: do not leave an exit 5
unanswered.

**`--keep N`** (1 to 99999; without it nothing is ever deleted):

- After a verified new dump it keeps the newest N dated pairs (`dcdash-YYYYmmdd-HHMMSS.dump` and `.dump.version`) in the output
  folder, and in the `--copy-to` folder when there is one, and deletes the older pairs. The new backup is never deleted.
- It never touches other names: a pair you named yourself (`before-upgrade.dump` and `before-upgrade.dump.version`) stays, and so
  does any dump without its `.version`.
- It refuses to rotate a folder that holds a dump dated later than the new one (the clock went back, or a file was misnamed), with a
  message on stderr: rotating oldest-first would otherwise delete the previous nights' backups while the clock is wrong. The exit
  code stays 0. If the clock once jumped FORWARD, the script itself wrote a future-dated dump, and from then on every run prints
  `not rotating` while the folders keep growing, with the clock right again. A monitor that reads only the exit code does not see it:
  look for the `not rotating` line in the log, and move or delete the future-dated file and its `.version` file so that rotation
  can resume.
- A removal that fails is reported on stderr and the exit code stays 0, because the new backup is fine.
- Nothing is rotated when the backup was not copied (exit 5).

**`--copy-to DIR`** copies the dump and its `.version` to `DIR`, under a temporary name first, compares the copy with the original and
only then renames it.

- `DIR` must exist (the script never creates it) and must not be the output folder.
- `DIR` must hold a file `.dcdash-backup-target` whose first line is the Compose project name (CRLF line ends and a byte order mark are
  fine). Create it once on the drive: `echo dcdash > /mnt/offsite/.dcdash-backup-target` in bash, and
  `Set-Content -Encoding ascii D:\backups\.dcdash-backup-target dcdash` in PowerShell (`dcdash` is the name in `compose.yaml`; the
  refusal message for a missing marker prints the exact command for your project). Why: on Linux a mount point with nothing mounted
  is an empty folder on the root disk, which a plain "folder exists" test would accept and then rotate; and a drive set up for
  another installation would be treated as one set.
- One folder per installation. Two installations on one drive need two folders, each with its own marker, and different Compose
  project names. The same goes for the OUTPUT folder: `--keep` counts every dated pair in it, whichever installation wrote it (the
  file names carry no project name), so two installations that back up into the same folder delete each other's backups. Give each
  its own output folder (the cron example above uses one path; change it per installation).
- If the folder is missing, has no marker, names another installation, or is the output folder itself, the local backup is still made
  and verified, nothing is rotated, and the script exits 5.

**What is decided and what is not** (an owner decision). The off-host target is a folder you point `--copy-to` at, for example
a USB drive or a share. The scripts do no file encryption: encrypt the drive or share itself (BitLocker To Go on a Windows edition
that has it; otherwise a password-protected archive made by hand, for example with 7-Zip). That was decided, not drilled. The scripts
never copy `.env` or `certs/`, so you keep those yourself. `.env` holds the key for the stored source secrets, so whoever holds the
dump and `.env` together can read them: keep a copy of `.env` (and `certs/`) off the machine, in a place as well protected as the
backups, and again whenever they change.

After the first night, look at the folder and at `LastTaskResult` (or the cron log), and do one [Practise a restore](backup-and-restore.md#practise-a-restore) with the dump.

Related: [Backup and restore](backup-and-restore.md), [Upgrading and going back](upgrading.md), [Operating the stack](operating.md).
