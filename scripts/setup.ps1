# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts\setup.ps1 --profile dev
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

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
} else {
    # No .env but the database volume exists: it belongs to the .env that is gone (see scripts/setup.sh). .env belongs to the
    # directory, so the project this command line selects and the one compose.yaml names are both checked. Fail closed.
    $projects = @(Get-ComposeProject @args)
    if ($env:COMPOSE_PROJECT_NAME) {
        $saved = $env:COMPOSE_PROJECT_NAME
        Remove-Item Env:COMPOSE_PROJECT_NAME
        try { $projects += Get-ComposeProject @args } finally { $env:COMPOSE_PROJECT_NAME = $saved }
    }
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
    Set-Content -Path .env -Encoding ascii -Value @(
        "DCDASH_DB_PASSWORD=$dbPassword",
        "DCDASH_SECRET_KEY=$secretKey",
        "DCDASH_TIMEZONE=UTC"
    )
    Write-Host "Created .env"
}
docker compose @args up -d --build
