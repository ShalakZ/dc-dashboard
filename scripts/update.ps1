# Updates an install of DC Dashboard in one safe command: checks this computer, shows where the install is and what is coming, backs up
# the database (and stops if the backup fails), fast-forwards the code, builds with the build id so Settings shows the commit, waits for
# the stack, checks the database revision and the web, and ends with a plain summary and the way back.
# Usage: scripts\update.ps1 [-Branch main] [-CopyTo DIR] [-NoPull] [-Yes] [-DryRun] [-Force]
#   -Branch   the branch to follow (default main)
#   -CopyTo   passed to scripts\backup.ps1: a second place for the backup (README, "Scheduled backups")
#   -NoPull   do not fetch or merge: back up, build and check the code that is checked out now (a detached HEAD is fine)
#   -Yes      do not ask "Continue? (y/N)"
#   -DryRun   do the read-only steps (checks, where you are, git fetch, the incoming list) and only PRINT the rest; asks nothing
#   -Force    rebuild even when the code and the running site are already current
# Exit codes: 0 done, or already current and healthy (also -DryRun finished); 1 a check refused, you said no, bad arguments, or another
# update is running; 2 the backup failed or was not copied (-CopyTo problem); 3 the new code could not be fetched or applied; 4 the build
# failed, or the stack did not start, become healthy or answer, or runs the wrong build; 5 the database revision does not match the code.
# An unexpected error ends with the exit code of the step it happened in. Every line shown is also written to logs\update-<stamp>.log.
# Environment overrides (a value that is not a positive number is ignored): DCDASH_UPDATE_POLL_SECONDS (5, seconds between checks),
# DCDASH_UPDATE_WAIT_SECONDS (600, how long to wait for the api), DCDASH_UPDATE_DB_WAIT_SECONDS (120, how long to wait for the
# database before the backup), DCDASH_UPDATE_MIN_FREE_GB (5, free disk space below which it refuses).
# Never, in any path: docker compose down, rm, kill or restart; docker volume, system or prune commands; --force-recreate,
# --remove-orphans or -V on up; restore.ps1; alembic downgrade; git reset, clean, checkout, stash, rebase or pull (the code moves only
# by git merge --ff-only); deleting a dump or any file under backups\.
# Run it with powershell.exe -File (exit codes do not reach the caller under -Command). Windows PowerShell 5.1 and pure ASCII on
# purpose: no && || ?? ?. and no ternary. A bash-style --yes or --force binds to its PowerShell twin (harmless, as in backup.ps1);
# any other stray (--dry-run, --no-pull, --copy-to X, a typo) prints the usage line and exits 1, never a real run.
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Branch = "main",
    [string]$CopyTo = "",
    [switch]$NoPull,
    [switch]$Yes,
    [switch]$DryRun,
    [switch]$Force,
    [Parameter(ValueFromRemainingArguments = $true)]$Rest
)
$ErrorActionPreference = "Stop"
$Usage = "usage: update.ps1 [-Branch main] [-CopyTo DIR] [-NoPull] [-Yes] [-DryRun] [-Force]"

# ---- arguments: nothing has been touched yet, so a bad one is just a usage line --------------------------------------------------
$Strays = @($Rest | Where-Object { $null -ne $_ })
if ($Strays.Count -gt 0) { [Console]::Error.WriteLine("$Usage (not understood: $($Strays -join ' '))"); exit 1 }
if ($Branch -notmatch '^[A-Za-z0-9._][A-Za-z0-9._/-]*$' -or $Branch.Contains("..")) {
    [Console]::Error.WriteLine("$Usage (-Branch takes a branch name such as main)"); exit 1
}
if ($PSBoundParameters.ContainsKey('CopyTo') -and -not $CopyTo) { [Console]::Error.WriteLine("$Usage (-CopyTo needs a folder)"); exit 1 }
# A relative folder means relative to where the person typed the command, before this script moves to the install folder.
if ($CopyTo -and -not [IO.Path]::IsPathRooted($CopyTo)) { $CopyTo = Join-Path (Get-Location).ProviderPath $CopyTo }
# A trailing backslash would escape the closing quote when the folder is handed to backup.ps1 (D:\ is the one place it must stay).
if ($CopyTo -and $CopyTo -notmatch '^[A-Za-z]:\\$') { $CopyTo = $CopyTo.TrimEnd('\') }

# ---- helpers ------------------------------------------------------------------------------------------------------------------------
$Utf8 = New-Object System.Text.UTF8Encoding $false
$script:LogPath = ""
$script:Lock = $null
$script:StepNo = 0
$script:StepTitle = ""
$script:ProfileArgs = @()

function Get-PositiveNumber([string]$Name, [double]$Default) {
    $Text = [Environment]::GetEnvironmentVariable($Name)
    $Number = 0.0
    if ($Text -and [double]::TryParse($Text, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$Number) -and
        $Number -gt 0 -and -not [double]::IsInfinity($Number) -and -not [double]::IsNaN($Number)) { return $Number }
    return $Default
}
$PollSeconds = Get-PositiveNumber "DCDASH_UPDATE_POLL_SECONDS" 5
$WaitSeconds = Get-PositiveNumber "DCDASH_UPDATE_WAIT_SECONDS" 600
$DbWaitSeconds = Get-PositiveNumber "DCDASH_UPDATE_DB_WAIT_SECONDS" 120
$MinFreeGb = Get-PositiveNumber "DCDASH_UPDATE_MIN_FREE_GB" 5

# A log that cannot be written is a warning, never a stop: the update matters more than its transcript.
function Add-LogLine([string]$Text) {
    if (-not $script:LogPath) { return }
    try {
        [IO.File]::AppendAllText($script:LogPath, $Text + "`r`n", $Utf8)
    } catch {
        $script:LogPath = ""
        [Console]::Error.WriteLine("WARNING: the log file cannot be written ($($_.Exception.Message)); the update goes on without it.")
    }
}
# Every line shown is also logged. -Err sends it to stderr (refusals and failures), like backup.ps1.
function Say([string]$Text = "", [switch]$Err) {
    if ($Err) { [Console]::Error.WriteLine($Text) } else { Write-Host $Text }
    Add-LogLine $Text
}

function Stop-Update([int]$Code, [string[]]$Lines = @()) {
    foreach ($Line in $Lines) { Say $Line -Err }
    Say "FAILED (exit $Code)" -Err
    exit $Code
}
# A check said no (exit 1) or a step could not go on (another code): what is wrong, what to do, and what was or was not touched.
function Refuse([string]$Reason, [string]$Fix, [string[]]$Details = @(), [string]$Changed = "", [int]$Code = 1) {
    $Label = "STOPPED"
    if ($Code -eq 1) { $Label = "REFUSED" }
    $Out = @("${Label}: $Reason") + $Details + @("Fix: $Fix")
    if ($Changed) { $Out += $Changed } else { $Out += "Nothing was changed." }
    Stop-Update -Code $Code -Lines $Out
}

function Start-Step([int]$No, [string]$Title) {
    $script:StepNo = $No
    $script:StepTitle = $Title
    Say ""
    Say "== $No/7 $Title =="
}

# The one way to run a native command. Windows PowerShell 5.1 turns stderr output of a native command into a terminating error under
# $ErrorActionPreference = "Stop" (and a -2>$null does the same), so the preference is lowered for the call and stderr is folded into
# the stream as plain text. A stderr line carries a trailing CR, hence the TrimEnd. The exit code is read right after the pipeline.
# Lines = everything, for messages; Out = stdout only, for parsing (a Compose warning on stderr must never read as a container id).
function Invoke-Native([string]$Exe, [string[]]$Arguments = @(), [switch]$Quiet) {
    $ErrorActionPreference = "Continue"
    $Lines = New-Object System.Collections.Generic.List[string]
    $Out = New-Object System.Collections.Generic.List[string]
    & $Exe @Arguments 2>&1 | ForEach-Object {
        $Text = ("$_").TrimEnd("`r", "`n")
        [void]$Lines.Add($Text)
        if ($_ -isnot [System.Management.Automation.ErrorRecord]) { [void]$Out.Add($Text) }
        if (-not $Quiet) { Say $Text }
    }
    $Code = $LASTEXITCODE
    if ($null -eq $Code) { $Code = 0 }
    return [pscustomobject]@{ Code = [int]$Code; Lines = $Lines.ToArray(); Out = $Out.ToArray() }
}
function Invoke-Git([string[]]$GitArgs, [switch]$Quiet) { return Invoke-Native "git" $GitArgs -Quiet:$Quiet }
# Every compose call carries --profile dev once step 2 has found the simulator.
function Invoke-Compose([string[]]$ComposeArgs, [switch]$Quiet) {
    return Invoke-Native "docker" (@("compose") + $script:ProfileArgs + $ComposeArgs) -Quiet:$Quiet
}
function Get-FirstLine($Result) {
    foreach ($Line in @($Result.Out)) { if ("$Line".Trim()) { return "$Line".Trim() } }
    return ""
}

# The container of a service, including a stopped one (ps -a), looked up again on every call. $null when there is none.
function Get-ServiceState([string]$Service) {
    $Ps = Invoke-Compose @("ps", "-a", "-q", $Service) -Quiet
    $Id = Get-FirstLine $Ps
    if ($Ps.Code -ne 0 -or -not $Id) { return $null }
    $Format = "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"
    $Inspect = Invoke-Native "docker" @("inspect", "-f", $Format, $Id) -Quiet
    $Parts = @((Get-FirstLine $Inspect) -split '\s+')
    if ($Inspect.Code -ne 0 -or $Parts.Count -lt 2) { return $null }
    return [pscustomobject]@{ Id = $Id; Status = $Parts[0]; Health = $Parts[1] }
}

# Polls $Test every $PollSeconds, a dot per poll, up to $Seconds. True when the test passed in time.
function Wait-Until([scriptblock]$Test, [double]$Seconds) {
    $Deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        if (& $Test) { Write-Host ""; return $true }
        if ((Get-Date) -ge $Deadline) { Write-Host ""; return $false }
        Write-Host -NoNewline "."
        Start-Sleep -Milliseconds ([int][Math]::Max(10, $PollSeconds * 1000))
    }
}

# README step 3 is the release notes: the person reads them here, once, before anything is changed. stdin is read with
# [Console]::In.ReadLine(), never Read-Host: it works on a console, on a pipe and under -NonInteractive, and a closed stdin is $null.
function Confirm-Continue {
    Say "Read the release notes for these changes and do the pre-checks they name before you continue."
    Write-Host -NoNewline "Continue? (y/N) "
    $Answer = [Console]::In.ReadLine()
    if ($null -eq $Answer) {
        Add-LogLine "Continue? (y/N) (no answer: input closed)"
        Say ""
        Stop-Update 1 @("No answer was given. Run it in a window you can type in, or add -Yes.", "Nothing was changed.")
    }
    Add-LogLine "Continue? (y/N) $($Answer.Trim())"
    if ($Answer.Trim() -notmatch '^(?i:y|yes)$') {
        Stop-Update 1 @("Stopped at your request. Nothing was changed.")
    }
}

# TASK-1B: replaces this stub with the step 7 checks (every service runs the new image, the api build id, alembic current = heads, the
# collector is stable, web is healthy, the four web lines). They also run at the end of an update, and here for a site that is current.
function Test-SiteHealthy {
    Say "(the step 7 checks are not built yet)"
    return $false
}

# True when some migration file of $Sha declares revision $Rev. The quotes are matched by '.' so no quote has to cross the native
# argument boundary (Windows PowerShell 5.1 gets embedded double quotes wrong).
function Test-RevisionKnown([string]$Rev, [string]$Sha) {
    $Pattern = '^revision = .{0}.[[:space:]]*$' -f $Rev
    $Grep = Invoke-Git @("grep", "-l", "-E", $Pattern, $Sha, "--", "backend/migrations/versions") -Quiet
    return ($Grep.Code -eq 0 -and @($Grep.Out | Where-Object { "$_".Trim() }).Count -gt 0)
}

# ---- the run ------------------------------------------------------------------------------------------------------------------------
# This script is usually run in the user's own window: what it sets for the build must not stay there (as in setup.ps1).
$SessionVars = @("DCDASH_BUILD_ID", "DCDASH_BUILD_TIME", "BUILDX_NO_DEFAULT_ATTESTATIONS")
$SessionBefore = @{}
foreach ($VarName in $SessionVars) { $SessionBefore[$VarName] = [Environment]::GetEnvironmentVariable($VarName) }
$OutputBefore = $null
try { $OutputBefore = [Console]::OutputEncoding } catch { }
# step -> exit code of an unexpected error in it (decision 17)
$StepExit = @{ 1 = 1; 2 = 1; 3 = 3; 4 = 2; 5 = 3; 6 = 4; 7 = 4 }

Push-Location (Join-Path $PSScriptRoot "..")
try {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
    $Root = (Get-Location).ProviderPath
    $LogDir = Join-Path $Root "logs"
    $Stamp = Get-Date -Format yyyyMMdd-HHmmss
    $LogProblem = ""
    try {
        [void](New-Item -ItemType Directory -Force -Path $LogDir)
        $script:LogPath = Join-Path $LogDir "update-$Stamp.log"
        [IO.File]::AppendAllText($script:LogPath, "", $Utf8)
    } catch {
        $LogProblem = $_.Exception.Message
        $script:LogPath = ""
    }
    Say "DC Dashboard update"

    # One update at a time, from before the first look at the tree: a second run must not be confused by the first one's changes.
    try {
        $script:Lock = [IO.File]::Open((Join-Path $LogDir ".update.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        $Reason = $_.Exception
        if ($Reason.InnerException) { $Reason = $Reason.InnerException }
        if ($Reason -is [System.IO.IOException] -and ($Reason.HResult -band 0xFFFF) -eq 32) {
            Refuse "another update is already running in this folder." "Wait until it has finished, then run this again."
        }
        Refuse "could not take the update lock in ${LogDir} ($($Reason.Message))." "Check that the logs folder can be written, then run this again."
    }

    $HaveGit = [bool](Get-Command git -CommandType Application -ErrorAction SilentlyContinue)
    $HaveDocker = [bool](Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)
    $ProjectName = "unknown"
    if ($HaveDocker) {
        $Config = Invoke-Compose @("config", "--no-interpolate") -Quiet
        foreach ($Line in $Config.Out) { if ($Config.Code -eq 0 -and $Line -match '^name:\s*(\S+)') { $ProjectName = $Matches[1]; break } }
    }
    Say "Compose project: $ProjectName"
    if ($script:LogPath) { Say "Log: $($script:LogPath)" } else { Say "Log: not written ($LogProblem)" }
    if ($DryRun) { Say "Dry run: the checks, the fetch and the lists are real; every other step is only printed. Nothing is asked or changed." }

    # ======== 1/7 ====================================================================================================================
    Start-Step 1 "Checking this computer"
    if ($Root.Contains("%")) {
        Refuse "this folder's path contains a % ($Root), which cmd.exe would expand inside the backup." "Move the whole install to a folder without a % in its path (for example C:\dcdash)."
    }
    if (-not $HaveGit) { Refuse "git is not installed (or not on PATH)." "Install Git for Windows, open a new window and run this again." }
    if (-not $HaveDocker) { Refuse "Docker is not installed (or not on PATH)." "Install and start Docker Desktop, open a new window and run this again." }
    $Inside = Invoke-Git @("rev-parse", "--is-inside-work-tree", "--absolute-git-dir") -Quiet
    if ($Inside.Code -ne 0 -or (Get-FirstLine $Inside) -ne "true" -or $Inside.Out.Count -lt 2) {
        Refuse "this folder is not a git checkout ($Root)." "Update only works on an install made with git clone. Ask whoever installed this for help." @($Inside.Lines | Select-Object -First 4 | ForEach-Object { "  git said: $_" })
    }
    $GitDir = "$($Inside.Out[1])".Trim()
    $Info = Invoke-Native "docker" @("info") -Quiet
    if ($Info.Code -ne 0) { Refuse "Docker is not running." "Start Docker Desktop, wait until it says it is running, then run this again." }
    $ComposeVersion = Invoke-Native "docker" @("compose", "version") -Quiet
    if ($ComposeVersion.Code -ne 0) { Refuse "'docker compose' is not available." "Update Docker Desktop to a version that includes Compose v2, then run this again." }
    if (-not (Test-Path -LiteralPath ".env" -PathType Leaf)) {
        Refuse ".env is missing." "On a new install run scripts\setup.ps1. If .env was lost, put the original back (README, 'What the backup does not contain'); never make a new one over an existing database."
    }
    if (-not (Select-String -Path ".env" -Pattern '^DCDASH_DB_PASSWORD=.' -Quiet)) {
        Refuse ".env has no DCDASH_DB_PASSWORD." "Restore the original .env (README, 'What the backup does not contain'); this script does not edit it."
    }
    # Nothing installed yet would make 'start only the database' create an empty database and 'back it up'.
    $Volumes = Invoke-Native "docker" @("volume", "ls", "-q", "--filter", "label=com.docker.compose.project=$ProjectName", "--filter", "label=com.docker.compose.volume=dbdata") -Quiet
    if ($Volumes.Code -ne 0) { Refuse "Docker could not list its volumes." "Check that Docker Desktop is running properly, then run this again." }
    $DbContainer = Invoke-Compose @("ps", "-a", "-q", "db") -Quiet
    if (-not (Get-FirstLine $Volumes) -and -not (Get-FirstLine $DbContainer)) {
        Refuse "nothing is installed yet (no containers and no database volume for the Compose project '$ProjectName')." "Run scripts\setup.ps1 first."
    }
    foreach ($Marker in @("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply")) {
        if ($GitDir -and (Test-Path -LiteralPath (Join-Path $GitDir $Marker))) {
            Refuse "a merge, rebase or cherry-pick is in progress in this folder." "Finish or cancel it first (git merge --abort, git rebase --abort or git cherry-pick --abort), then run this again."
        }
    }
    $Status = Invoke-Git @("status", "--porcelain", "--untracked-files=no") -Quiet
    if ($Status.Code -ne 0) { Refuse "git could not read the state of this folder." "Run 'git status' to see why." @($Status.Lines) }
    $Dirty = @($Status.Out | Where-Object { "$_".Trim() })
    if ($Dirty.Count -gt 0) {
        Refuse "these tracked files were changed on this computer, and an update must not mix with them:" "Keep a copy of each file if you still need it, then undo the change with: git restore <file>. Untracked files, .env and backups\ do not matter." @($Dirty | Select-Object -First 20 | ForEach-Object { "  $_" })
    }
    $CurrentBranch = Get-FirstLine (Invoke-Git @("branch", "--show-current") -Quiet)
    if (-not $NoPull) {
        if (-not $CurrentBranch) {
            Refuse "this checkout is not on any branch (a detached HEAD)." "Use -NoPull to build exactly what is checked out, or go back to the branch with: git switch $Branch"
        }
        if ($CurrentBranch -cne $Branch) {
            Refuse "this checkout is on branch '$CurrentBranch', not '$Branch'." "Switch with: git switch $Branch   (or add -Branch $CurrentBranch to follow that branch instead)."
        }
    }
    $DriveRoot = [IO.Path]::GetPathRoot($Root)
    if ($DriveRoot -and -not $DriveRoot.StartsWith("\\")) {
        $FreeBytes = -1
        try { $FreeBytes = (New-Object System.IO.DriveInfo $DriveRoot).AvailableFreeSpace } catch { }
        if ($FreeBytes -lt 0) {
            Say "WARNING: the free space on $DriveRoot could not be read; continuing."
        } elseif ($FreeBytes / 1GB -lt $MinFreeGb) {
            $FreeGb = [Math]::Round($FreeBytes / 1GB, 1)
            Refuse "only $FreeGb GB are free on drive $DriveRoot (an update needs at least $MinFreeGb GB for the backup and the new images)." "Free some space (Docker Desktop: Settings > Resources, or remove old files), then run this again."
        }
    } else {
        Say "WARNING: the free disk space of $Root cannot be checked (a network path); continuing."
    }
    # .env (the database password, the key that decrypts stored source credentials) and the backups must not sync to a cloud.
    $InOneDrive = $Root -match 'OneDrive'
    foreach ($SyncRoot in @($env:OneDrive, $env:OneDriveCommercial)) {
        if ($SyncRoot -and ($Root.TrimEnd('\') + '\').StartsWith($SyncRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $InOneDrive = $true }
    }
    if ($InOneDrive) {
        Say "WARNING: this folder is inside OneDrive ($Root). .env (the database password and the key that decrypts stored source credentials) and the backups would be synced to the cloud, and bind mounts on synced paths can be slow or locked. Install outside any synced folder, for example C:\dcdash."
    }
    Say "ok: Docker answers, .env is there, no tracked file is changed, $Root has room."

    # ======== 2/7 ====================================================================================================================
    Start-Step 2 "Where you are now"
    $HeadInfo = Get-FirstLine (Invoke-Git @("log", "-1", "--format=%H %h %cs %s") -Quiet)
    if ($HeadInfo -notmatch '^([0-9a-f]{40,64}) (\S+) (\S+ .*)$') { Refuse "git could not read the current commit." "Run 'git log -1' to see why." }
    $HeadFull = $Matches[1]
    $HeadShort = $Matches[2]
    $HeadLine = "$HeadShort $($Matches[3])"
    Say "Commit: $HeadLine"
    if ($CurrentBranch) { Say "Branch: $CurrentBranch" } else { Say "Branch: (none: detached HEAD)" }
    # An old checkout has no simulator service: the call then fails, which means "none" (and its error text is not an id).
    $Simulator = Invoke-Native "docker" @("compose", "--profile", "dev", "ps", "-a", "-q", "simulator") -Quiet
    if ($Simulator.Code -eq 0 -and (Get-FirstLine $Simulator)) {
        $script:ProfileArgs = @("--profile", "dev")
        Say "The SCADA simulator is installed here, so every Compose command below uses --profile dev."
    }
    # From the db container, so it works with the api down (as backup.ps1 does).
    $OldRevision = "not running"
    $DbState = Get-ServiceState "db"
    if ($DbState -and $DbState.Status -eq "running") {
        $Psql = Invoke-Compose @("exec", "-T", "db", "psql", "-U", "dcdash", "-d", "dcdash", "-tAc", "SELECT version_num FROM alembic_version") -Quiet
        $OldRevision = Get-FirstLine $Psql
        if ($Psql.Code -ne 0 -or -not $OldRevision) { $OldRevision = "unknown (the database did not say)" }
        elseif ($OldRevision -notmatch '^[A-Za-z0-9_]+$') {
            Refuse "the database reports the revision '$OldRevision', which does not look like a revision." "Look at the database by hand (README, Upgrading and going back), then run this again."
        }
    }
    Say "Database revision: $OldRevision"
    $RunningId = ""
    $ApiState = Get-ServiceState "api"
    if ($ApiState -and $ApiState.Status -eq "running") {
        $RunningId = Get-FirstLine (Invoke-Compose @("exec", "-T", "api", "printenv", "DCDASH_BUILD_ID") -Quiet)
        if (-not $RunningId) { $RunningId = "unknown" }
        Say "Running build: $RunningId"
    } else {
        Say "Running build: not running"
    }
    # The going-back anchor is the code the site RUNS, not what is on disk: someone may have pulled by hand and never rebuilt.
    $OldCommit = $HeadShort
    $OldCommitIsGuess = $false
    $RunningCommit = ""
    if ($RunningId) {
        $Clean = $RunningId -replace '-dirty$', ''
        if ($Clean -match '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -and $Clean -notin @("dev", "unknown")) {
            $RunningCommit = Get-FirstLine (Invoke-Git @("rev-parse", "--verify", "--quiet", "$Clean^{commit}") -Quiet)
        }
        if ($RunningCommit) {
            $OldCommit = $RunningId
            if ($RunningCommit -ne $HeadFull) { Say "The site runs $RunningId; the code on disk is already at $HeadShort." }
        } else {
            $OldCommitIsGuess = $true
            Say "The running site was built by hand, so its commit is not recorded: $HeadShort is the best guess. The backup's database revision is the firm anchor."
        }
    }
    $OldCommitText = $OldCommit
    if ($OldCommitIsGuess) { $OldCommitText = "$OldCommit (best guess: the running site was built by hand; its commit is not recorded)" }

    # ======== 3/7 ====================================================================================================================
    Start-Step 3 "What is coming"
    $Incoming = 0
    $TargetSha = $HeadFull
    if ($NoPull) {
        Say "-NoPull: not fetching. The code on disk ($HeadShort) is what will be built."
    } else {
        Say "Fetching the newest code from origin (git fetch; it changes no file of yours, only git's copy of origin)..."
        $Fetch = Invoke-Git @("fetch", "origin") -Quiet
        if ($Fetch.Code -ne 0) {
            Refuse "the new code could not be fetched from origin." "Check the network and that 'git remote -v' shows the right address, then run this again." @($Fetch.Lines | Select-Object -First 8 | ForEach-Object { "  git said: $_" }) -Code 3
        }
        $Fetched = Get-FirstLine (Invoke-Git @("rev-parse", "--verify", "--quiet", "refs/remotes/origin/$Branch") -Quiet)
        if (-not $Fetched) {
            Refuse "origin has no branch '$Branch'." "Check the branch name (-Branch), then run this again." -Code 3
        }
        # "<only here> <only on origin>": a count that cannot be read is an unexpected error, never "nothing incoming".
        $Counts = Invoke-Git @("rev-list", "--left-right", "--count", "HEAD...$Fetched") -Quiet
        if ($Counts.Code -ne 0 -or (Get-FirstLine $Counts) -notmatch '^(\d+)\s+(\d+)$') {
            throw "git could not compare this checkout with origin/${Branch}: $(Get-FirstLine $Counts)"
        }
        $LocalOnly = [int]$Matches[1]
        $Incoming = [int]$Matches[2]
        if ($Incoming -gt 0 -and $LocalOnly -gt 0) {
            Refuse "this checkout has $LocalOnly commit(s) that origin/$Branch does not have, and origin/$Branch has $Incoming new one(s): the two have diverged, so the code cannot be brought up to date by a plain fast-forward." "Ask whoever looks after this install; do not merge by hand here." (Invoke-Git @("log", "--format=  local only: %h %s", "$Fetched..HEAD", "--max-count=10") -Quiet).Out -Code 3
        }
        if ($LocalOnly -gt 0) {
            Say "WARNING: this checkout has $LocalOnly commit(s) that origin/$Branch does not have. They will be built as they are."
        }
        if ($Incoming -gt 0) { $TargetSha = $Fetched }
        if ($Incoming -gt 0) {
            # A person who copied a new script in by hand before pulling would have the merge fail halfway: catch it here.
            $Added = Invoke-Git @("-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", "HEAD..$TargetSha") -Quiet
            $Blocking = @($Added.Out | Where-Object { "$_".Trim() -and (Test-Path -LiteralPath "$_".Trim()) })
            if ($Blocking.Count -gt 0) {
                Refuse "the update adds files that already exist here as untracked files:" "Move each file away (for example rename it to name.old), then run this again. Do not copy update scripts in by hand: the README's first update uses three commands." @($Blocking | ForEach-Object { "  $_" })
            }
            Say "Incoming: $Incoming new commit(s) on origin/${Branch}:"
            $Shown = Invoke-Git @("log", "--format=  %h %s", "HEAD..$TargetSha", "--max-count=30") -Quiet
            foreach ($Line in $Shown.Out) { Say $Line }
            if ($Incoming -gt 30) { Say "  ... and $($Incoming - 30) more" }
        } else {
            Say "No new commits on origin/${Branch}."
        }
    }
    # The migrations the new code carries beyond what the site RUNS (not beyond the disk, see step 2).
    $MigrationBase = $HeadFull
    if ($RunningCommit) { $MigrationBase = $RunningCommit }
    $Pending = @((Invoke-Git @("diff", "--name-only", "$MigrationBase..$TargetSha", "--", "backend/migrations/versions") -Quiet).Out | Where-Object { "$_".Trim() })
    if ($Pending.Count -gt 0) {
        Say "Database migrations this update will apply:"
        foreach ($File in $Pending) { Say "  $File" }
        Say "This update changes the database: the backup is taken first, and going back needs both the dump and the commit shown above."
    } elseif ($RunningId -and -not $RunningCommit) {
        Say "The running site's commit is unknown, so the pending migrations cannot be listed; the backup records the database revision."
    }
    # The code that will be built must know the database it is going to open (README, Upgrading and going back, step 6).
    $RevisionChecked = $false
    if ($OldRevision -match '^[A-Za-z0-9_]+$') {
        $RevisionChecked = $true
        if (-not (Test-RevisionKnown $OldRevision $TargetSha)) {
            Refuse "the code you are about to run does not know database revision $OldRevision (it is older than the database); see README, Upgrading and going back, step 6." "Update to a newer commit of the branch (do not use -NoPull on old code), or go back as the README describes."
        }
    }
    $RunningIsCurrent = ($RunningCommit -and $RunningCommit -eq $HeadFull)
    if ($Incoming -eq 0 -and $RunningIsCurrent -and -not $Force) {
        Say "Already up to date at $HeadLine"
        # A1: "current" is a health verdict, not a label. Exit 0 only when every check passes; never rebuild by itself (-Force does).
        if (Test-SiteHealthy) { Say "DONE"; exit 0 }
        Stop-Update 4 @("The site is current but not reported as healthy (the step 7 checks are not built yet).")
    }
    if ($Incoming -eq 0) {
        if ($Force -and $RunningIsCurrent) { Say "Nothing new, but -Force was given: the site will be rebuilt." }
        elseif ($RunningId) { Say "Nothing new on origin, but the running site is not built from the code on disk: it will be rebuilt from $HeadShort." }
        else { Say "Nothing new on origin, and the site is not running: it will be built from $HeadShort and started." }
    }
    $NotesFile = "README.md, section ""Release notes"""
    if ($TargetSha -ne $HeadFull -and (Invoke-Git @("cat-file", "-e", "${TargetSha}:CHANGELOG.md") -Quiet).Code -eq 0) { $NotesFile = "CHANGELOG.md" }
    Say "Release notes: $NotesFile"
    if ($DryRun) {
        Say "Dry run: not asking."
    } elseif ($Yes) {
        Say "-Yes was given: not asking."
    } else {
        Confirm-Continue
    }

    # ======== 4/7 ====================================================================================================================
    Start-Step 4 "Backing up the database"
    $DbStartedByUs = $false
    $BackupPath = ""
    $BackupSchema = ""
    $HostExe = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path -LiteralPath $HostExe)) { $HostExe = Join-Path $PSHOME "pwsh.exe" }
    $BackupScript = Join-Path $Root "scripts\backup.ps1"
    $BackupArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $BackupScript)
    if ($CopyTo) { $BackupArgs += @("-CopyTo", $CopyTo) }
    if ($DryRun) {
        Say "Would run: docker compose up -d db   (only if the database container is not running; it starts nothing else)"
        Say "Would run: scripts\backup.ps1$(if ($CopyTo) { ' -CopyTo ' + $CopyTo })"
    } else {
        $DbNow = Get-ServiceState "db"
        $DbReady = ($DbNow -and $DbNow.Status -eq "running" -and $DbNow.Health -in @("healthy", "none"))
        if (-not $DbReady) {
            if (-not $DbNow -or $DbNow.Status -ne "running") {
                Say "The database container is not running: starting only the database (docker compose up -d db)."
                $Up = Invoke-Compose @("up", "-d", "db")
                if ($Up.Code -ne 0) {
                    Refuse "the database container could not be started (docker compose up -d db exited $($Up.Code))." "Read the lines above, fix the cause, then run this again." -Changed "Nothing else was changed." -Code 2
                }
                $DbStartedByUs = $true
            } else {
                Say "The database container is running but not healthy yet: waiting for it."
            }
            Say "Waiting for the database (up to $([int]$DbWaitSeconds) seconds)..."
            $DbUp = Wait-Until { $S = Get-ServiceState "db"; [bool]($S -and $S.Status -eq "running" -and $S.Health -in @("healthy", "none")) } $DbWaitSeconds
            if (-not $DbUp) {
                $Changed = "Nothing was changed."
                if ($DbStartedByUs) { $Changed = "Only the database container was started (it keeps running); nothing else was changed." }
                Refuse "the database did not become healthy in time, so no backup could be made." "Look at 'docker compose logs --tail 80 db', fix the cause, then run this again." -Changed $Changed -Code 2
            }
        }
        $Backup = Invoke-Native $HostExe $BackupArgs
        $Wrote = $null
        foreach ($Line in $Backup.Out) { if ($Line -match '^wrote (.+) \(schema ([A-Za-z0-9_]+)\)\s*$') { $Wrote = $Matches } }
        $Changed = "Nothing was changed."
        if ($DbStartedByUs) { $Changed = "Only the database container was started (it keeps running); nothing else was changed." }
        if ($Backup.Code -eq 5) {
            $Local = "the local copy is not usable"
            if ($Wrote) { $Local = "the local backup was made: $($Wrote[1])" }
            Refuse "the backup was made on this computer but could NOT be copied to $CopyTo; $Local." "Fix the copy folder (README, 'Scheduled backups': the folder needs a .dcdash-backup-target file) or run update without -CopyTo, then run it again." -Changed $Changed -Code 2
        }
        if ($Backup.Code -ne 0 -or -not $Wrote) {
            Refuse "the backup failed (exit $($Backup.Code)), so nothing was updated." "Read the lines above, fix the cause, then run this again. No old backup was touched." -Changed $Changed -Code 2
        }
        $BackupPath = $Wrote[1]
        $BackupSchema = $Wrote[2]
        if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf) -or -not (Test-Path -LiteralPath "$BackupPath.version" -PathType Leaf)) {
            Refuse "the backup script said it wrote $BackupPath, but the dump or its .version file is not there." "Run scripts\backup.ps1 by hand and look at its messages, then run this again." -Changed $Changed -Code 2
        }
        Say "Backup written: $BackupPath (schema $BackupSchema)"
        # The database was not running at step 2, so its revision was not known until now: the same check, before anything changes.
        if (-not $RevisionChecked -and -not (Test-RevisionKnown $BackupSchema $TargetSha)) {
            Refuse "the code you are about to run does not know database revision $BackupSchema (it is older than the database); see README, Upgrading and going back, step 6." "Update to a newer commit of the branch, then run this again. The backup above is complete." -Changed $Changed
        }
        # Printed now, before the code moves, so that they survive a closed window.
        Say ""
        Say "Write these down (they are also in the log):"
        Say "  Old commit: $OldCommitText"
        Say "  Old database revision: $BackupSchema"
        Say "  Backup: $BackupPath"
    }

    # TASK-1B: steps 5 to 7 continue here
    Say ""
    Stop-Update 4 @("steps 5 to 7 are not built yet")
} catch {
    $ErrorExit = 1
    if ($StepExit.ContainsKey($script:StepNo)) { $ErrorExit = $StepExit[$script:StepNo] }
    Say "UNEXPECTED ERROR in step $($script:StepNo) ($($script:StepTitle)): $($_.Exception.Message)" -Err
    Add-LogLine "At: $($_.InvocationInfo.PositionMessage)"
    if ($script:StepNo -le 3) { Say "Nothing was changed." -Err }
    if ($script:StepNo -eq 4) { Say "The database container may have been started and a backup may be in backups\ (it is complete only if 'Backup written' was shown above). Nothing else was changed." -Err }
    Say "FAILED (exit $ErrorExit)" -Err
    exit $ErrorExit
} finally {
    foreach ($VarName in $SessionVars) { [Environment]::SetEnvironmentVariable($VarName, $SessionBefore[$VarName]) }
    if ($script:Lock) { $script:Lock.Dispose() }
    if ($OutputBefore) { try { [Console]::OutputEncoding = $OutputBefore } catch { } }
    Pop-Location
}
