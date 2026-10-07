# Generates .env on first run, then starts the stack. Extra arguments go to
# docker compose, e.g. scripts\setup.ps1 --profile dev
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path .env)) {
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
