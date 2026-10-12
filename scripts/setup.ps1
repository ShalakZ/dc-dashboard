# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts\setup.ps1 --profile dev
# -Timezone <zone> (or the DCDASH_TIMEZONE environment variable) sets the site timezone of the NEW .env, e.g.
# scripts\setup.ps1 -Timezone Africa/Cairo; the flag wins. It only seeds the first start; Settings changes it later.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# .env (the database password, the key that decrypts stored source credentials) and the backups must not sync to a cloud.
$HereFolder = (Get-Location).ProviderPath
$InOneDrive = $HereFolder -match 'OneDrive'
foreach ($SyncRoot in @($env:OneDrive, $env:OneDriveCommercial)) {
    if ($SyncRoot -and ($HereFolder.TrimEnd('\') + '\').StartsWith($SyncRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $InOneDrive = $true }
}
if ($InOneDrive) {
    Write-Warning "this folder is inside OneDrive ($HereFolder). .env (the database password and the key that decrypts stored source credentials) and the backups would be synced to the cloud, and bind mounts on synced paths can be slow or locked. Install outside any synced folder, for example C:\dcdash."
}

# -Timezone is ours; every other argument goes to docker compose. There is no param block: it would make PowerShell reject docker's
# own -p. -Timezone:Africa/Cairo arrives as the two elements "-Timezone:" and "Africa/Cairo" when the script is called with & from a
# PowerShell, and as "-Timezone" and "Africa/Cairo" under -File; a single "-Timezone:Africa/Cairo" element is accepted as well.
$ComposeArgs = @()
$TimezoneGiven = $false
$TimezoneFlag = ""
for ($i = 0; $i -lt $args.Count; $i++) {
    $Arg = [string]$args[$i]
    if ($Arg -match '^-timezone:?$') {
        if ($i + 1 -ge $args.Count) { throw "-Timezone needs a value (a zone name like Africa/Cairo)" }
        $i++
        $TimezoneGiven = $true
        $TimezoneFlag = [string]$args[$i]
    } elseif ($Arg -match '^-timezone:(.+)$') {
        $TimezoneGiven = $true
        $TimezoneFlag = $Matches[1]
    } else {
        $ComposeArgs += $Arg
    }
}

# The zone has to be on the allowlist (scripts/timezones.txt: the names Settings accepts) BEFORE anything is started: the api and the
# collector read DCDASH_TIMEZONE at import, and a name they refuse crash-loops both on the first start.
function Assert-ZoneName([string]$Zone, [string]$Origin) {
    if (-not $Zone) { throw "$Origin is empty: give a zone name like Africa/Cairo, or leave it out to start with UTC" }
    $listFile = Join-Path $PSScriptRoot "timezones.txt"
    if (-not (Test-Path -LiteralPath $listFile)) { throw "Cannot read $listFile (the list of accepted timezones)." }
    $known = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($line in [IO.File]::ReadAllLines($listFile)) { if ($line.Trim()) { [void]$known.Add($line.Trim()) } }
    if ($known.Contains($Zone)) { return }
    $shown = $Zone -replace '[\r\n]+', ' '
    if ($shown -match '\s' -or $shown -match 'Standard Time') {
        throw "${Origin}: '$shown' is not an IANA zone name (use a name like Africa/Cairo, not a Windows name like `"Egypt Standard Time`"). Leave it out to start with UTC and change it on the Settings page after the first start."
    }
    throw "${Origin}: timezone '$shown' is unknown to this release or refused by Settings (the UTC offset must be a whole number of hours in January and July, and the name must be spelled exactly as in the IANA list, for example Africa/Cairo). Leave it out to start with UTC and change it on the Settings page after the first start."
}
$RequestedZone = ""
if ($TimezoneGiven) {
    Assert-ZoneName $TimezoneFlag "-Timezone"
    $RequestedZone = $TimezoneFlag
} elseif ($env:DCDASH_TIMEZONE) {
    Assert-ZoneName $env:DCDASH_TIMEZONE "DCDASH_TIMEZONE"
    $RequestedZone = $env:DCDASH_TIMEZONE
}

# The Compose project name that the given `docker compose ...` command line acts on. Native stderr is not redirected
# (`2>$null` turns stderr output into a terminating error under $ErrorActionPreference = "Stop" in Windows PowerShell 5.1);
# --no-interpolate is what keeps `compose config` quiet.
function Get-ComposeProject {
    $config = docker compose @args config --no-interpolate
    if ($LASTEXITCODE -ne 0) { throw "Cannot read the Compose configuration. .env was not created." }
    $nameLine = $config | Select-String -Pattern '^name:\s*(\S+)' | Select-Object -First 1
    if (-not $nameLine) { throw "Cannot tell the Compose project name. .env was not created." }
    return $nameLine.Matches[0].Groups[1].Value
}

if (Test-Path .env) {
    # An .env without a database password can start nothing and cannot open an existing volume: leave it as it is and stop.
    if (-not (Select-String -Path .env -Pattern '^DCDASH_DB_PASSWORD=.' -Quiet)) {
        throw ".env exists but has no DCDASH_DB_PASSWORD; it was not changed. Restore or fix it, then run this script again."
    }
    if ($TimezoneGiven) {
        Write-Host "note: .env already exists, so -Timezone changes nothing: the zone only seeds the first start. Change it on the Settings page."
    }
    # Compose reads a shell variable before .env, so a stale one wins for this start.
    $EnvZone = "UTC"
    $ZoneLine = Select-String -Path .env -Pattern '^DCDASH_TIMEZONE=(.*)$' | Select-Object -First 1
    if ($ZoneLine -and $ZoneLine.Matches[0].Groups[1].Value.Trim()) { $EnvZone = $ZoneLine.Matches[0].Groups[1].Value.Trim() }
    if ($env:DCDASH_TIMEZONE -and $env:DCDASH_TIMEZONE -cne $EnvZone) {
        Write-Warning "the DCDASH_TIMEZONE variable in this shell ($($env:DCDASH_TIMEZONE)) overrides .env ($EnvZone) for this start."
    }
} else {
    # No .env but the database volume exists: it belongs to the .env that is gone (see scripts/setup.sh). .env belongs to the
    # directory, so two projects are checked: the one this command line selects (looked up with the same arguments, so -p and
    # COMPOSE_PROJECT_NAME count) and the one compose.yaml names (looked up without the arguments and with COMPOSE_PROJECT_NAME
    # unset). Fail closed.
    $projects = @(Get-ComposeProject @ComposeArgs)
    $saved = $env:COMPOSE_PROJECT_NAME
    if ($saved) { Remove-Item Env:COMPOSE_PROJECT_NAME }
    try { $projects += Get-ComposeProject } finally { if ($saved) { $env:COMPOSE_PROJECT_NAME = $saved } }
    foreach ($project in ($projects | Select-Object -Unique)) {
        $volumes = docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=dbdata"
        if ($LASTEXITCODE -ne 0) { throw "Cannot list Docker volumes (is Docker running?). .env was not created." }
        if ($volumes) {
            throw "Refusing to create .env: the database volume of Compose project '$project' already exists, and it belongs to the .env that is missing. Put the original .env back (keep a copy with every backup), then run this script again. No copy of it? The data is still in the volume: back it up first (README, Backup and restore, 'What the backup does not contain'). Never use down -v."
        }
    }
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $pw = New-Object byte[] 24
    $key = New-Object byte[] 32
    $rng.GetBytes($pw)
    $rng.GetBytes($key)
    $dbPassword = -join ($pw | ForEach-Object { $_.ToString("x2") })
    $secretKey = [Convert]::ToBase64String($key).Replace("+", "-").Replace("/", "_")
    $SiteZone = "UTC"
    if ($RequestedZone) { $SiteZone = $RequestedZone }
    Set-Content -Path .env -Encoding ascii -Value @(
        "DCDASH_DB_PASSWORD=$dbPassword",
        "DCDASH_SECRET_KEY=$secretKey",
        "DCDASH_TIMEZONE=$SiteZone"
    )
    Write-Host "Created .env"
    # A shell variable beats .env in Compose, so the chosen zone wins over a stale one for this first start.
    $env:DCDASH_TIMEZONE = $SiteZone
    Write-Host "timezone: $SiteZone (it seeds Settings on the first start only; change it there later)"
}
# Not $Project: PowerShell variable names ignore case, and $project is the loop variable above.
$ProjectName = "unknown"
try { $ProjectName = Get-ComposeProject @ComposeArgs } catch { }
Write-Host "starting Compose project: $ProjectName"
# The build id the backend images carry (Settings, GET /api/version and every diagnostics report show it): the commit and that commit's
# time, never the clock of this run, so an unchanged tree builds the same image and nothing is recreated. Without git, or outside a
# repository, it stays dev / unknown. Native stderr is not redirected here (see Get-ComposeProject); a failing git changes nothing.
$env:DCDASH_BUILD_ID = "dev"
$env:DCDASH_BUILD_TIME = "unknown"
try {
    if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path .git)) {
        $commit = git describe --always --dirty
        if ($LASTEXITCODE -eq 0 -and $commit) { $env:DCDASH_BUILD_ID = "$commit".Trim() }
        $committed = git log -1 --format=%cI
        if ($LASTEXITCODE -eq 0 -and $committed) { $env:DCDASH_BUILD_TIME = "$committed".Trim() }
    }
} catch { }
# Without this, re-running on an unchanged tree recreates api, collector, web and simulator: default attestations change the image id on every build.
$env:BUILDX_NO_DEFAULT_ATTESTATIONS = '1'
docker compose @ComposeArgs up -d --build
