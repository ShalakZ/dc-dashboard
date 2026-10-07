# Restore a dump made by scripts\backup.ps1 into the running stack.
# Usage: scripts\restore.ps1 <dump> [--force]
# Exits 3 when the dump's Alembic revision differs from the running schema unless --force
# is given; after a forced restore the api container migrates on start.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if ($args.Count -lt 1) { Write-Error "usage: restore.ps1 <dump> [--force]"; exit 2 }
$Dump = $args[0]
$Force = if ($args.Count -ge 2) { $args[1] } else { "" }
$Current = ""
try { $Current = (docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version").Trim() } catch { }
$Wanted = if (Test-Path "$Dump.version") { (Get-Content -Raw "$Dump.version").Trim() } else { "unknown" }
if ($Current -ne $Wanted -and $Force -ne "--force") {
  Write-Error "refusing: dump schema '$Wanted' differs from running schema '$Current' (use --force to restore then migrate)"
  exit 3
}
docker compose stop api collector
docker compose exec -T db psql -U dcdash -d postgres -c "DROP DATABASE IF EXISTS dcdash WITH (FORCE)" -c "CREATE DATABASE dcdash OWNER dcdash"
docker compose exec -T db psql -U dcdash -d dcdash -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
# Whatever happens from here on, run timescaledb_post_restore() and start api/collector again
# so a failed restore never leaves the database stranded.
$Log = Join-Path ([IO.Path]::GetTempPath()) ("dcdash-restore-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$Failed = $true
try {
  # Feed the binary dump through cmd's redirection so PowerShell never text-decodes it.
  cmd /c "docker compose exec -T db pg_restore -U dcdash -d dcdash --no-owner < `"$Dump`" 2> `"$Log`""
  $Rc = $LASTEXITCODE
  # pg_restore exits 1 for ignorable warnings (e.g. ownership with --no-owner) as well as real errors.
  $HasError = (Test-Path $Log) -and ((Select-String -Path $Log -Pattern "error" -Quiet) -eq $true)
  if ($Rc -gt 1 -or ($Rc -eq 1 -and $HasError)) { throw "pg_restore failed (exit $Rc); see $Log" }
  if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 0) { Write-Host "pg_restore warnings in $Log" }
  $Failed = $false
} finally {
  docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()" | Out-Null
  docker compose start api collector | Out-Null   # api runs `alembic upgrade head`, a no-op unless --force restored an older schema
  if ($Failed) { Write-Host "restore failed: ran timescaledb_post_restore() and started api/collector; log: $Log" }
}
Write-Host "restored $Dump"
