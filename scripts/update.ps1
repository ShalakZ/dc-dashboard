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
# After a backup that comes before a change, the old commit, old revision and backup path are also kept in logs\update-anchor.txt, so that
# a later run can show what to go back to when this update fails.
# Environment overrides (a value that is not a positive number is ignored): DCDASH_UPDATE_POLL_SECONDS (5, seconds between checks),
# DCDASH_UPDATE_WAIT_SECONDS (600, how long to wait for the api), DCDASH_UPDATE_DB_WAIT_SECONDS (120, how long to wait for the
# database before the backup), DCDASH_UPDATE_MIN_FREE_GB (5, free disk space below which it refuses), DCDASH_UPDATE_REPORT_SECONDS
# (60, how often the wait for the api says how long it has been waiting).
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
$ProfileText = ""
$script:Services = @("api", "collector", "web")
$script:BackupPath = ""
$script:OldCommitText = ""
$script:OldRevisionText = ""
$script:AfterBuild = $false
$script:StartedByUp = $false
$script:CollectorBefore = ""
$GoBack = 'README, "Upgrading and going back", step 6'

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
$ReportSeconds = Get-PositiveNumber "DCDASH_UPDATE_REPORT_SECONDS" 60

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
    # One call, one consistent snapshot: state, health ("none" without a healthcheck) and how often Docker restarted it.
    $Format = "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}"
    $Inspect = Invoke-Native "docker" @("inspect", "-f", $Format, $Id) -Quiet
    $Parts = @((Get-FirstLine $Inspect) -split '\s+')
    if ($Inspect.Code -ne 0 -or $Parts.Count -lt 2) { return $null }
    $Restarts = 0
    if ($Parts.Count -ge 3) { [void][int]::TryParse($Parts[2], [ref]$Restarts) }
    return [pscustomobject]@{ Id = $Id; Status = $Parts[0]; Health = $Parts[1]; Restarts = $Restarts }
}

# Polls $Test every $PollSeconds, a dot per poll, up to $Seconds; with $ReportEvery a line of elapsed time every that many seconds.
# True when the test passed in time.
function Wait-Until([scriptblock]$Test, [double]$Seconds, [double]$ReportEvery = 0) {
    $Start = Get-Date
    $Deadline = $Start.AddSeconds($Seconds)
    $Reports = 0
    $Dots = $false
    while ($true) {
        if (& $Test) { if ($Dots) { Write-Host "" }; return $true }
        $Now = Get-Date
        if ($Now -ge $Deadline) { if ($Dots) { Write-Host "" }; return $false }
        if ($ReportEvery -gt 0 -and ($Now - $Start).TotalSeconds -ge ($Reports + 1) * $ReportEvery) {
            $Reports++
            if ($Dots) { Write-Host "" }
            $Dots = $false
            Say "  still waiting: $([int]($Now - $Start).TotalSeconds) seconds so far"
        }
        Write-Host -NoNewline "."
        $Dots = $true
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

# Every failure after the backup ends here: what is wrong ($Before), where the data is, what Docker shows (docker compose ps -a and the
# tail of the log of each service in $Logs; read-only), what to do ($After) and, with -GoingBack, the way back with its anchors.
function Stop-AfterBackup([int]$Code, [string[]]$Before, [string[]]$After, [string[]]$Logs = @("api"), [switch]$GoingBack) {
    foreach ($Line in $Before) { Say $Line -Err }
    if ($script:BackupPath) { Say "Backup: $($script:BackupPath)" -Err }
    elseif ($script:StartedByUp) { Say "This run made no backup. It ran docker compose up -d once to start the services that were not running, and changed nothing else." -Err }
    else { Say "This run made no backup and changed nothing." -Err }
    Say ""
    Say "docker compose ps -a:"
    foreach ($Line in (Invoke-Compose @("ps", "-a") -Quiet).Lines) { Say "  $Line" }
    foreach ($Service in $Logs) {
        Say ""
        Say "docker compose logs --tail 80 ${Service}:"
        foreach ($Line in (Invoke-Compose @("logs", "--tail", "80", $Service) -Quiet).Lines) { Say "  $Line" }
    }
    Say ""
    foreach ($Line in $After) { Say $Line -Err }
    # No backup, no way back to point at: a run that backed nothing up changed nothing that a backup could undo.
    if ($GoingBack -and $script:BackupPath) {
        Say "To go back: $GoBack. You need commit $($script:OldCommitText) and revision $($script:OldRevisionText), and the backup above." -Err
    }
    if ($script:BackupPath) { Say "Nothing further was changed. The data is safe in the backup above." -Err }
    Stop-Update $Code
}
# A step 7 check failed: exit 4 (a service or the web) or 5 (the database revision). Which advice fits depends on whether this run built.
# -MigrationHint: the api is not healthy, which on a run that built nothing may only mean that a migration is still running.
function Stop-Check([int]$Code, [string]$What, [string[]]$Logs = @("api"), [switch]$GoingBack, [switch]$MigrationHint) {
    $Fix = "Fix: this run rebuilt nothing. Read the lines above; update.ps1 -Force rebuilds the site from the code on disk."
    if ($MigrationHint -and -not $script:AfterBuild) {
        $Fix = "Fix: If docker compose logs api shows a migration still running, wait for it first. Otherwise this run rebuilt nothing. Read the lines above; update.ps1 -Force rebuilds the site from the code on disk."
    }
    if ($script:AfterBuild) { $Fix = "Fix: read the lines above and the log, fix the cause, then run update again: it checks the site once more." }
    if ($Code -eq 5) {
        $Fix = "Fix: do not start or stop anything by hand. The database and the code disagree; follow the way back below, or ask whoever looks after this install."
        if (-not $script:BackupPath) {
            # Typically a dump restored into a running stack, or an api that was never started again: going back is not the fix.
            $Changed = "This run changed nothing."
            if ($script:StartedByUp) { $Changed = "This run only started services that were not running (docker compose up -d)." }
            $Fix = "Fix: do not start or stop anything by hand. The database and the code disagree. $Changed Make a backup (scripts\backup.ps1), then ask whoever looks after this install. Do not run alembic by hand."
        }
    }
    Stop-AfterBackup $Code @("STOPPED: $What") @($Fix) $Logs -GoingBack:$GoingBack
}

# "" when the container of $Service runs the image its tag points to NOW (the build moves the tag); else the sentence for the failure.
function Get-ImageProblem([string]$Service) {
    $Ps = Invoke-Compose @("ps", "-a", "-q", $Service) -Quiet
    $Id = Get-FirstLine $Ps
    if ($Ps.Code -ne 0 -or -not $Id) { return "$Service is not running (it has no container)." }
    $Container = Invoke-Native "docker" @("inspect", "-f", "{{.Image}} {{.Config.Image}}", $Id) -Quiet
    $Parts = @((Get-FirstLine $Container) -split '\s+')
    if ($Container.Code -ne 0 -or $Parts.Count -ne 2 -or $Parts[1] -notmatch '^[A-Za-z0-9][A-Za-z0-9._/:@-]*$') { return "Docker could not say which image $Service runs." }
    $Tag = Invoke-Native "docker" @("image", "inspect", "-f", "{{.Id}}", $Parts[1]) -Quiet
    $TagId = Get-FirstLine $Tag
    if ($Tag.Code -ne 0 -or -not $TagId) { return "Docker could not find the image $($Parts[1]) that $Service was made from." }
    if ($Parts[0] -ne $TagId) { return "$Service still runs the old version (its container was made from an image older than $($Parts[1]) is now)." }
    return ""
}

# One GET through [Net.HttpWebRequest] (never Invoke-WebRequest or curl): no proxy, no redirects, 10 seconds, 4xx/5xx read from the
# WebException's response. Windows PowerShell 5.1 hides the WebException inside a MethodInvocationException. Every response is closed:
# the default is two connections per host, so one that stays open would make the third request wait for its timeout.
function Get-HttpAnswerOnce([string]$Url, [switch]$NoBody) {
    $Answer = [pscustomobject]@{ Status = 0; Body = ""; Location = ""; Problem = "" }
    $Response = $null
    try {
        $Request = [Net.HttpWebRequest]::Create($Url)
        $Request.Proxy = $null
        $Request.AllowAutoRedirect = $false
        $Request.KeepAlive = $false
        $Request.Timeout = 10000
        $Request.ReadWriteTimeout = 10000
        try {
            $Response = $Request.GetResponse()
        } catch {
            $Failure = $_.Exception
            if ($Failure -isnot [Net.WebException] -and $Failure.InnerException) { $Failure = $Failure.InnerException }
            if ($Failure -is [Net.WebException] -and $Failure.Response) { $Response = $Failure.Response } else { throw }
        }
        $Answer.Status = [int]$Response.StatusCode
        $Answer.Location = "$($Response.Headers['Location'])"
        if (-not $NoBody) {
            $Reader = New-Object IO.StreamReader($Response.GetResponseStream())
            try { $Answer.Body = $Reader.ReadToEnd() } finally { $Reader.Dispose() }
        }
    } catch {
        $Answer.Problem = $_.Exception.Message
    } finally {
        if ($Response) { $Response.Close() }
    }
    return $Answer
}
# Three tries while nothing answers at all (Status 0): Caddy may have been healthy for a second only.
function Get-HttpAnswer([string]$Url, [switch]$NoBody) {
    for ($Try = 1; $Try -le 3; $Try++) {
        $Answer = Get-HttpAnswerOnce $Url -NoBody:$NoBody
        if ($Answer.Status -ne 0) { break }
        Start-Sleep -Milliseconds ([int][Math]::Max(10, $PollSeconds * 1000))
    }
    return $Answer
}
# The revision of the first bare line (`0010` or `0010 (head)`) of alembic's stdout; INFO lines never match.
function Get-AlembicRevision([string[]]$Lines) {
    foreach ($Line in $Lines) { if ("$Line".Trim() -match '^([A-Za-z0-9_]+)( \(head\))?$') { return $Matches[1] } }
    return ""
}

# The step 7 checks, in one place: the end of an update and "already up to date" both use them (A1: current is a health verdict, not a
# label). Read-only. A failure ends the run (4: a service or the web; 5: the database revision); returns the database revision otherwise.
# $ExpectedCommit is the commit just built (after a build only): the api must report it, compared as commits.
function Confirm-SiteHealthy([string]$ExpectedCommit = "", [string]$ExpectedId = "") {
    $Api = Get-ServiceState "api"
    if (-not $Api -or $Api.Status -ne "running" -or $Api.Health -ne "healthy") {
        $Seen = "it has no container"
        if ($Api) { $Seen = "state $($Api.Status), health $($Api.Health)" }
        Stop-Check 4 "the api is not healthy ($Seen)." -MigrationHint
    }
    foreach ($Service in $script:Services) {
        $Problem = Get-ImageProblem $Service
        $ServiceLogs = @("api")
        if ($Service -ne "api") { $ServiceLogs += $Service }
        if ($Problem) { Stop-Check 4 $Problem $ServiceLogs }
    }
    Say "ok: $($script:Services -join ', ') run the newest images."
    if ($ExpectedCommit) {
        $Running = Get-FirstLine (Invoke-Compose @("exec", "-T", "api", "printenv", "DCDASH_BUILD_ID") -Quiet)
        $Clean = $Running -replace '-dirty$', ''
        $Resolved = ""
        if ($Clean -match '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -and $Clean -notin @("dev", "unknown")) {
            $Resolved = Get-FirstLine (Invoke-Git @("rev-parse", "--verify", "--quiet", "$Clean^{commit}") -Quiet)
        }
        if ($Resolved -ne $ExpectedCommit) {
            if (-not $Running) { $Running = "(nothing)" }
            Stop-Check 4 "the api reports build $Running, not the build just made ($ExpectedId): it still runs the old version."
        }
        Say "ok: the api runs build $Running."
    }
    $Current = Invoke-Compose @("exec", "-T", "api", "alembic", "current") -Quiet
    $Heads = Invoke-Compose @("exec", "-T", "api", "alembic", "heads") -Quiet
    if ($Current.Code -ne 0 -or $Heads.Code -ne 0) { Stop-Check 4 "alembic could not be run inside the api container, so the database revision is unknown." }
    $CurrentRev = Get-AlembicRevision $Current.Out
    $HeadRev = Get-AlembicRevision $Heads.Out
    if (-not $CurrentRev -or -not $HeadRev -or $CurrentRev -ne $HeadRev) {
        $Shown = $CurrentRev
        if (-not $Shown) { $Shown = "none" }
        Stop-Check 5 "the database is at revision $Shown but this code's newest revision is '$HeadRev': they must be equal." -GoingBack
    }
    Say "ok: the database is at revision $CurrentRev, the newest this code knows."
    # A collector that crashes on start is restarted by Docker; two looks one poll apart catch it going round. The two looks can both fall
    # after the first crash, so a container that THIS run made (after a build, with an id step 2 did not see) must also be at 0 restarts.
    # One that was kept (-Force on an unchanged tree recreates nothing) may have restarted long before this run.
    $First = Get-ServiceState "collector"
    if ($First -and $First.Status -eq "running") {
        Start-Sleep -Milliseconds ([int][Math]::Max(10, $PollSeconds * 1000))
        $Second = Get-ServiceState "collector"
    }
    $MadeByThisRun = [bool]($script:AfterBuild -and $First -and $First.Id -ne $script:CollectorBefore)
    if (-not $First -or $First.Status -ne "running" -or -not $Second -or $Second.Status -ne "running" -or $Second.Id -ne $First.Id -or $Second.Restarts -ne $First.Restarts -or
        ($MadeByThisRun -and $First.Restarts -ne 0)) {
        Stop-Check 4 "the collector is not running steadily (readings are not being collected)." @("api", "collector")
    }
    Say "ok: the collector is running."
    # web has its own healthcheck (10 s start period, 10 s interval): it is 'starting' for a while after the build.
    $script:WebNow = $null
    [void](Wait-Until {
        $script:WebNow = Get-ServiceState "web"
        [bool]($script:WebNow -and (($script:WebNow.Status -eq "running" -and $script:WebNow.Health -eq "healthy") -or $script:WebNow.Status -in @("exited", "dead")))
    } ([Math]::Min($WaitSeconds, 120)))
    if (-not $script:WebNow -or $script:WebNow.Status -ne "running" -or $script:WebNow.Health -ne "healthy") {
        $Seen = "it has no container"
        if ($script:WebNow) { $Seen = "state $($script:WebNow.Status), health $($script:WebNow.Health)" }
        Stop-Check 4 "web is not healthy ($Seen)." @("api", "web")
    }
    Say "ok: web is healthy."
    # The four lines of README step 5, from this computer through the published port. `compose port` says 0.0.0.0:80 or [::]:80 for "every
    # interface" (this computer is then 127.0.0.1); a Compose override that binds web to ONE address (192.168.1.5:80) is checked there.
    $Port = Invoke-Compose @("port", "web", "80") -Quiet
    if ($Port.Code -ne 0 -or (Get-FirstLine $Port) -notmatch '^(.*):(\d+)\s*$') { Stop-Check 4 "Docker did not say on which port web listens." @("api", "web") }
    $WebHost = $Matches[1].Trim()
    $WebPort = $Matches[2]
    if (-not $WebHost -or $WebHost -in @("0.0.0.0", "[::]") -or $WebHost -notmatch '^[A-Za-z0-9.:\[\]-]+$') { $WebHost = "127.0.0.1" }
    $Base = "http://${WebHost}:$WebPort"
    Say "The site is checked at $Base (the address Docker publishes for web)."
    $Index = Get-HttpAnswer "$Base/"
    if ($Index.Status -in @(301, 302, 307, 308) -and $Index.Location -like "https://*") {
        Say "The site redirects to https (TLS is on). The four web checks are skipped here; web's own health check stands in for them."
        return $CurrentRev
    }
    $Checks = @(
        @{ Name = "index"; Path = "/"; Status = 200; Has = '<div id="root">'; Is = "" },
        @{ Name = "spa fallback"; Path = "/assets"; Status = 200; Has = '<div id="root">'; Is = "" },
        @{ Name = "api proxy"; Path = "/api/health"; Status = 200; Has = ""; Is = '{"status":"ok"}' },
        @{ Name = "stream route"; Path = "/api/stream"; Status = 401; Has = ""; Is = "" }
    )
    foreach ($Check in $Checks) {
        $Answer = $Index
        if ($Check.Path -ne "/") { $Answer = Get-HttpAnswer "$Base$($Check.Path)" -NoBody:($Check.Path -eq "/api/stream") }
        $Wrong = ""
        if ($Answer.Status -eq 0) { $Wrong = "no answer ($($Answer.Problem))" }
        elseif ($Answer.Status -ne $Check.Status) { $Wrong = "status $($Answer.Status), expected $($Check.Status)" }
        elseif ($Check.Has -and -not $Answer.Body.Contains($Check.Has)) { $Wrong = "the page does not contain $($Check.Has)" }
        elseif ($Check.Is -and $Answer.Body.Trim() -ne $Check.Is) { $Wrong = "the answer is not $($Check.Is)" }
        if ($Wrong) { Stop-Check 4 "web check '$($Check.Name)' failed: GET $($Check.Path) gave $Wrong." @("api", "web") }
        Say "ok: $($Check.Name)"
    }
    return $CurrentRev
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

# -LiteralPath, and inside the try: a folder name with [ ] is a wildcard pattern for -Path, and a failure here must still end in FAILED.
$Pushed = $false
$script:StepTitle = "Starting"
try {
    Push-Location -LiteralPath (Join-Path $PSScriptRoot "..")
    $Pushed = $true
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
    $Root = (Get-Location).ProviderPath
    $LogDir = Join-Path $Root "logs"
    $AnchorFile = Join-Path $LogDir "update-anchor.txt"
    $EnvFile = Join-Path $Root ".env"
    $Stamp = Get-Date -Format yyyyMMdd-HHmmss
    $LogProblem = ""
    try {
        [void][IO.Directory]::CreateDirectory($LogDir)
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
    $LogLine = "Log: not written ($LogProblem)"
    if ($script:LogPath) { $LogLine = "Log: $($script:LogPath)" }
    Say $LogLine
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
    # Absolute paths from here on: Windows PowerShell 5.1 cannot resolve a RELATIVE -LiteralPath when the current folder has [ ] in its name.
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        Refuse ".env is missing." "On a new install run scripts\setup.ps1. If .env was lost, put the original back (README, 'What the backup does not contain'); never make a new one over an existing database."
    }
    if (-not (Select-String -LiteralPath $EnvFile -Pattern '^DCDASH_DB_PASSWORD=.' -Quiet)) {
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
        $ProfileText = " --profile dev"
        $script:Services = @("api", "collector", "web", "simulator")
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
    # The collector's container id now: after a build, a collector with another id was made by this run (see the collector check).
    $CollectorPs = Invoke-Compose @("ps", "-a", "-q", "collector") -Quiet
    if ($CollectorPs.Code -eq 0) { $script:CollectorBefore = Get-FirstLine $CollectorPs }
    # The going-back anchor is the code the site RUNS, not what is on disk: someone may have pulled by hand and never rebuilt. When no
    # api container runs (a failed update that was stopped, or one that is restarting), what it ran is unknown and the disk may already
    # hold the NEW code, so the commit is only a guess: it is never printed as a firm anchor.
    $OldCommit = $HeadShort
    $OldCommitIsGuess = $false
    $OldCommitWhy = ""
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
            $OldCommitWhy = "the running site was built by hand; its commit is not recorded"
            Say "The running site was built by hand, so its commit is not recorded: $HeadShort is the best guess. The backup's database revision is the firm anchor."
        }
    } else {
        $OldCommitIsGuess = $true
        $OldCommitWhy = "the site is not running, so its build is unknown"
        Say "The site is not running, so the code it was last built from is unknown: $HeadShort is the best guess. The backup's database revision is the firm anchor."
    }
    $OldCommitText = $OldCommit
    if ($OldCommitIsGuess) { $OldCommitText = "$OldCommit (best guess: $OldCommitWhy)" }
    $script:OldCommitText = $OldCommitText
    $script:OldRevisionText = $OldRevision
    # What an earlier update left (written right after its backup): shown whatever the state, so a rerun after a failure cannot lose it.
    try {
        if (Test-Path -LiteralPath $AnchorFile -PathType Leaf) {
            $Notes = @([IO.File]::ReadAllLines($AnchorFile, $Utf8) | ForEach-Object { "$_".Trim() })
            if ($Notes.Count -ge 4 -and $Notes[1] -and $Notes[2] -and $Notes[3]) {
                Say "Notes of an earlier update (logs\update-anchor.txt): old commit $($Notes[1]), old revision $($Notes[2]), backup $($Notes[3]) - if that update failed, this is what to go back to"
            }
        }
    } catch { }

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
            $Blocking = @($Added.Out | Where-Object { $Rel = "$_".Trim(); $Rel -and (Test-Path -LiteralPath (Join-Path $Root $Rel)) })
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
    # The migrations the new code carries beyond what the site RUNS (not beyond the disk, see step 2). Only ADDED files are migrations to
    # apply; a deleted or edited one prints nothing (and a rename counts as its new file).
    $MigrationBase = $HeadFull
    if ($RunningCommit) { $MigrationBase = $RunningCommit }
    $Pending = @((Invoke-Git @("-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", "--diff-filter=A", "$MigrationBase..$TargetSha", "--", "backend/migrations/versions") -Quiet).Out | Where-Object { "$_".Trim() })
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
        # A1: "current" is a health verdict, not a label. Exit 0 only when every check passes; never rebuild by itself (-Force does).
        # The checks are all read-only, so -DryRun runs them for real too.
        Start-Step 7 "Checking"
        Say "Nothing is incoming and the running site was built from ${HeadShort}: checking that it is healthy (nothing is rebuilt)."
        Say "If an earlier update of this install failed, what to go back to is in logs\update-anchor.txt and in that run's log."
        # An earlier update whose first `up -d` failed while the api migrated left web and collector created, never started. Once the api
        # is healthy on the current image, start them with the one plain `up -d` (no build, no recreate flags) and let the checks judge.
        $ApiNow = Get-ServiceState "api"
        if ($ApiNow -and $ApiNow.Status -eq "running" -and $ApiNow.Health -eq "healthy" -and -not (Get-ImageProblem "api")) {
            $NotStarted = @()
            foreach ($Service in $script:Services) {
                if ($Service -eq "api") { continue }
                $Look = Get-ServiceState $Service
                if ($Look -and $Look.Status -in @("created", "exited")) { $NotStarted += "$Service ($($Look.Status))" }
            }
            if ($NotStarted.Count -gt 0) {
                Say "The api is healthy, but these services were never started or have stopped: $($NotStarted -join ', '). Starting them with docker compose$ProfileText up -d (nothing is rebuilt)."
                if ($DryRun) {
                    Say "Would run: docker compose$ProfileText up -d"
                } else {
                    $script:StartedByUp = $true
                    $Up = Invoke-Compose @("up", "-d")
                    if ($Up.Code -ne 0) {
                        Stop-Check 4 "docker compose up -d exited $($Up.Code), so the rest of the site was not started." @("api", "web")
                    }
                }
            }
        }
        [void](Confirm-SiteHealthy)
        Say ""
        Say "Already up to date at $HeadLine"
        Say $LogLine
        Say "DONE"
        exit 0
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
        Say "Would run: docker compose up -d --no-recreate db   (only if the database container is not running; it starts nothing else)"
        Say "Would run: scripts\backup.ps1$(if ($CopyTo) { ' -CopyTo ' + $CopyTo })"
    } else {
        $DbNow = Get-ServiceState "db"
        $DbReady = ($DbNow -and $DbNow.Status -eq "running" -and $DbNow.Health -in @("healthy", "none"))
        if (-not $DbReady) {
            if (-not $DbNow -or $DbNow.Status -ne "running") {
                # --no-recreate: a stopped container starts exactly as it was. Without it, Compose recreates it from a compose.yaml or .env that
                # changed since (a pulled-by-hand update), before the backup exists.
                Say "The database container is not running: starting only the database (docker compose up -d --no-recreate db)."
                $Up = Invoke-Compose @("up", "-d", "--no-recreate", "db")
                if ($Up.Code -ne 0) {
                    Refuse "the database container could not be started (docker compose up -d --no-recreate db exited $($Up.Code))." "Read the lines above, fix the cause, then run this again." -Changed "Nothing else was changed." -Code 2
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
        # The .version file is what restore.ps1 and the README read to know what the dump holds: it must say what the backup script reported.
        $VersionText = ""
        try { $VersionText = ("" + (Get-Content -LiteralPath "$BackupPath.version" -Raw)).Trim() } catch { }
        if ($VersionText -ne $BackupSchema) {
            Refuse "the backup script said it wrote $BackupPath (schema $BackupSchema), but its .version file says '$VersionText'." "Run scripts\backup.ps1 by hand and look at its messages, then run this again." -Changed $Changed -Code 2
        }
        Say "Backup written: $BackupPath (schema $BackupSchema)"
        # The database was not running at step 2, so its revision was not known until now: the same check, before anything changes.
        if (-not $RevisionChecked -and -not (Test-RevisionKnown $BackupSchema $TargetSha)) {
            Refuse "the code you are about to run does not know database revision $BackupSchema (it is older than the database); see README, Upgrading and going back, step 6." "Update to a newer commit of the branch, then run this again. The backup above is complete." -Changed $Changed
        }
        # Printed now, before the code moves, so that they survive a closed window.
        $script:OldRevisionText = $BackupSchema
        Say ""
        Say "Write these down (they are also in the log):"
        Say "  Old commit: $OldCommitText"
        Say "  Old database revision: $BackupSchema"
        Say "  Backup: $BackupPath"
        # Kept in a file as well, for a LATER run: after a failed update the disk holds the new code and the log of this run is easy to
        # lose. A run whose commit is only a guess (no api was running) never replaces an earlier note, which may be the firm anchor.
        if ($OldCommitIsGuess -and (Test-Path -LiteralPath $AnchorFile -PathType Leaf)) {
            Say "The notes of the earlier update stay in logs\update-anchor.txt (this run only has a best guess, which must not replace them)."
        } else {
            try {
                $NoteTime = (Get-Date).ToString("yyyy-MM-dd HH':'mm':'ss", [Globalization.CultureInfo]::InvariantCulture)
                $NoteLines = @($NoteTime, $OldCommitText, $BackupSchema, $BackupPath)
                [IO.File]::WriteAllText($AnchorFile, (($NoteLines -join "`r`n") + "`r`n"), $Utf8)
                Say "These are also saved in logs\update-anchor.txt."
            } catch {
                Say "WARNING: logs\update-anchor.txt could not be written ($($_.Exception.Message)); the lines above and the log hold the same."
            }
        }
    }

    # ======== 5/7 ====================================================================================================================
    Start-Step 5 "Getting the new code"
    if ($NoPull) {
        Say "-NoPull: the code is not merged. $HeadShort stays as it is."
    } elseif ($Incoming -eq 0) {
        Say "Nothing is incoming: the code is already at $HeadShort."
    } elseif ($DryRun) {
        Say "Would run: git merge --ff-only $TargetSha"
    } else {
        # Only the commit the person saw and confirmed (recorded at the fetch), and only as a fast-forward: it can never create a merge.
        $Merge = Invoke-Git @("merge", "--ff-only", $TargetSha)
        $HeadNow = Get-FirstLine (Invoke-Git @("rev-parse", "HEAD") -Quiet)
        $TreeNow = @((Invoke-Git @("status", "--porcelain", "--untracked-files=no") -Quiet).Out | Where-Object { "$_".Trim() })
        $Kept = "The backup above is complete; nothing else was changed."
        if ($DbStartedByUs) { $Kept = "The backup above is complete; only the database container was started (it keeps running); nothing else was changed." }
        if ($Merge.Code -ne 0 -and $HeadNow -ne $HeadFull) {
            Refuse "the code was partly updated, HEAD is $HeadNow (git merge exited $($Merge.Code))." "Do not build. Ask whoever looks after this install; the old commit is in the lines above." -Changed "No image was built and no container was touched. $Kept" -Code 3
        }
        if ($Merge.Code -ne 0 -and $TreeNow.Count -gt 0) {
            # A file held open on Windows (an editor, an antivirus) makes git rewrite part of the tree and then give up with HEAD unmoved.
            $ChangedFiles = @($TreeNow | Select-Object -First 20 | ForEach-Object { ("$_" -replace '^.. ', '').Trim() })
            Refuse "git stopped part-way: these tracked files were changed: $($ChangedFiles -join ', '); HEAD is still $HeadShort; nothing was built." "Do not build. Undo each listed file with: git restore <file> (or ask whoever looks after this install), then run this again." -Changed "No image was built and no container was touched. $Kept" -Code 3
        }
        if ($Merge.Code -ne 0) {
            Refuse "the new code could not be applied (git merge --ff-only exited $($Merge.Code))." "Read the git message above (a file in the way is the usual reason), fix it, then run this again." -Changed "The code was not changed (HEAD is still $HeadShort). $Kept" -Code 3
        }
        if ($HeadNow -ne $TargetSha -or $TreeNow.Count -gt 0) {
            Refuse "git said the merge worked, but HEAD is $HeadNow instead of $TargetSha, or tracked files differ." "Do not build. Ask whoever looks after this install." -Changed "No image was built and no container was touched. $Kept" -Code 3
        }
        Say "The code is now at $($TargetSha.Substring(0, [Math]::Min(7, $TargetSha.Length)))."
    }

    # ======== 6/7 ====================================================================================================================
    Start-Step 6 "Building and starting"
    $BuildId = $HeadShort
    $ExpectedCommit = $HeadFull
    $WaitText = "$([int]$WaitSeconds) seconds"
    if ($WaitSeconds -ge 120) { $WaitText = "$([int][Math]::Round($WaitSeconds / 60)) minutes" }
    $Unavailable = "The site is unavailable while the database is migrated, and readings are not collected meanwhile."
    if ($DryRun) {
        Say "Would run: docker compose$ProfileText build api web   (DCDASH_BUILD_ID and DCDASH_BUILD_TIME set to the commit and its time, BUILDX_NO_DEFAULT_ATTESTATIONS=1)"
        Say "Would run: docker compose$ProfileText up -d   (then once more, only if the first one fails while the api is still migrating)"
        Say "Would wait up to $WaitText for the api to be healthy. $Unavailable"
    } else {
        # The build id is the commit and its own time (like setup.ps1), so an unchanged tree builds the same images.
        $Describe = Invoke-Git @("describe", "--always", "--dirty") -Quiet
        $Committed = Invoke-Git @("log", "-1", "--format=%cI") -Quiet
        $Full = Invoke-Git @("rev-parse", "HEAD") -Quiet
        $BuildId = Get-FirstLine $Describe
        $BuildTime = Get-FirstLine $Committed
        $ExpectedCommit = Get-FirstLine $Full
        if ($Describe.Code -ne 0 -or $Committed.Code -ne 0 -or $Full.Code -ne 0 -or -not $BuildId -or -not $BuildTime -or -not $ExpectedCommit) {
            throw "git could not say which commit is checked out"
        }
        $env:DCDASH_BUILD_ID = $BuildId
        $env:DCDASH_BUILD_TIME = $BuildTime
        $env:BUILDX_NO_DEFAULT_ATTESTATIONS = "1"
        $script:AfterBuild = $true
        Say "Build id: $BuildId (committed $BuildTime); Settings will show it."
        Say "Building the new images. The running site is not touched until they are built."
        $Build = Invoke-Compose @("build", "api", "web")
        if ($Build.Code -ne 0) {
            $Touched = "The running site and the database were not touched: the old containers still run the old version."
            if (-not $RunningId) { $Touched = "The database was not touched and nothing was started: no site was running before this update." }
            Stop-AfterBackup 4 @("STOPPED: the build failed (docker compose build exited $($Build.Code)).",
                "$Touched The code on disk is now at $BuildId (it was $HeadShort).") `
                @("Fix: read the build output above (a full disk or a network problem are the usual causes), fix it, then run update again: it builds again. Going back is not needed.")
        }
        Say "Starting the new version (docker compose up -d)."
        $Up = Invoke-Compose @("up", "-d")
        $UpFailed = ($Up.Code -ne 0)
        if ($UpFailed) { Say "docker compose up -d exited $($Up.Code). That is expected while the api is still migrating; the script waits for the api and then starts the rest." }
        Say "Waiting for the api to become healthy, up to $WaitText (a dot for every check). $Unavailable"
        $script:ApiSeen = @{}
        $script:ApiLast = $null
        $script:ApiVerdict = ""
        $ApiUp = Wait-Until {
            $Look = Get-ServiceState "api"
            $script:ApiLast = $Look
            if (-not $Look) { return $false }
            # A recreated container starts counting again: the baseline is the first count seen for each container id.
            if (-not $script:ApiSeen.ContainsKey($Look.Id)) { $script:ApiSeen[$Look.Id] = $Look.Restarts }
            if ($Look.Status -in @("exited", "dead")) { $script:ApiVerdict = "stopped"; return $true }
            if (($Look.Restarts - $script:ApiSeen[$Look.Id]) -ge 3) { $script:ApiVerdict = "restarting"; return $true }
            if ($Look.Status -eq "running" -and $Look.Health -eq "healthy") { $script:ApiVerdict = "healthy"; return $true }
            return $false
        } $WaitSeconds $ReportSeconds
        if ($script:ApiVerdict -ne "healthy") {
            $Last = $script:ApiLast
            if ($ApiUp -or -not $Last -or $Last.Status -ne "running") {
                $Now = "it has no container"
                if ($Last) { $Now = "it is $($Last.Status)" }
                # A verdict of 'restarting' can be reached while the container shows running between two restarts: 'it is running' would be odd.
                if ($script:ApiVerdict -eq "restarting") { $Now = "the api is restarting over and over" }
                Stop-AfterBackup 4 @("STOPPED: the api keeps restarting or has stopped ($Now), so the new version cannot start.",
                    "No readings are being collected. Docker keeps retrying the database migration because the container is set to restart (restart: unless-stopped).") `
                    @("If the log shows the migration starting again by itself and finishing, wait: some old installs restart once on their own (README, release notes of 0004).",
                      "Fix: First stop the retries (docker compose$ProfileText stop api collector), and only then think about going back.",
                      "Then read the api log above. Your data is in the backup; going back is explained in the README.") -GoingBack
            }
            Stop-AfterBackup 4 @("STOPPED: the api did not become healthy within $WaitText, but it is still running ($($Last.Status), health $($Last.Health)).",
                "A long database migration can outlast the wait (README, Upgrading and going back, step 4), so this may still be working.") `
                @("Do NOT restore the backup or go back yet.",
                  "Fix: watch it with: docker compose$ProfileText logs -f api   until Uvicorn prints 'Application startup complete', then run update again: it checks the site and tells you what is still wrong.")
        }
        if ($UpFailed) {
            Say "The api is healthy now: starting the rest (docker compose up -d once more)."
            $Up2 = Invoke-Compose @("up", "-d")
            if ($Up2.Code -ne 0) {
                Stop-AfterBackup 4 @("STOPPED: docker compose up -d failed again (exit $($Up2.Code)) although the api is healthy, so the rest of the site was not started.") `
                    @("Fix: read the messages above (a port that is already used is a common reason), fix it, then run update again.") @("api", "web")
            }
        }
    }

    # ======== 7/7 ====================================================================================================================
    Start-Step 7 "Checking"
    if ($DryRun) {
        Say "Would check: every service ($($script:Services -join ', ')) runs the image just built; the api reports the new build id; the database revision is the newest the code knows; the collector keeps running; web is healthy and answers index, spa fallback, api proxy and stream route."
        Say ""
        Say "Dry run finished: nothing was changed."
        Say "DONE"
        exit 0
    }
    $NewRevision = Confirm-SiteHealthy $ExpectedCommit $BuildId
    Say ""
    Say "Update finished."
    Say "Commit: $OldCommit -> $BuildId"
    Say "Database revision: $BackupSchema -> $NewRevision"
    Say "Backup: $BackupPath"
    Say "Settings now shows version: $BuildId"
    Say "To go back: $GoBack. You need commit $OldCommitText and revision $BackupSchema, and the backup above."
    Say $LogLine
    Say "DONE"
    exit 0
} catch {
    $ErrorExit = 1
    if ($StepExit.ContainsKey($script:StepNo)) { $ErrorExit = $StepExit[$script:StepNo] }
    Say "UNEXPECTED ERROR in step $($script:StepNo) ($($script:StepTitle)): $($_.Exception.Message)" -Err
    Add-LogLine "At: $($_.InvocationInfo.PositionMessage)"
    if ($script:StepNo -le 3) { Say "Nothing was changed." -Err }
    if ($script:StepNo -eq 4) { Say "The database container may have been started and a backup may be in backups\ (it is complete only if 'Backup written' was shown above). Nothing else was changed." -Err }
    if ($script:StepNo -ge 5 -and $script:BackupPath) {
        Say "The backup is $($script:BackupPath). The site may be partly updated: run 'docker compose ps' and read the lines above. HEAD is at $(Get-FirstLine (Invoke-Git @('rev-parse', 'HEAD') -Quiet))." -Err
        # An error while building, waiting or checking can land while the api still migrates: the warning comes before the way back.
        if ($script:StepNo -ge 6) {
            Say "Do NOT restore or go back while docker compose ps shows the api starting or restarting: a migration may still be running. Watch: docker compose logs -f api" -Err
        }
        Say "To go back: $GoBack. You need commit $($script:OldCommitText) and revision $($script:OldRevisionText), and the backup above." -Err
    } elseif ($script:StepNo -ge 5) {
        if ($script:StartedByUp) { Say "This run made no backup. It ran docker compose up -d once to start the services that were not running, and changed nothing else." -Err }
        else { Say "This run made no backup and changed nothing." -Err }
    }
    Say "FAILED (exit $ErrorExit)" -Err
    exit $ErrorExit
} finally {
    foreach ($VarName in $SessionVars) { [Environment]::SetEnvironmentVariable($VarName, $SessionBefore[$VarName]) }
    if ($script:Lock) { $script:Lock.Dispose() }
    if ($OutputBefore) { try { [Console]::OutputEncoding = $OutputBefore } catch { } }
    if ($Pushed) { Pop-Location }
}
