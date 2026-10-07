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
# Feed the binary dump through cmd's redirection so PowerShell never text-decodes it.
cmd /c "docker compose exec -T db pg_restore -U dcdash -d dcdash --no-owner < `"$Dump`""
if ($LASTEXITCODE -ne 0) { throw "pg_restore failed" }
docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()"
docker compose start api collector      # api runs `alembic upgrade head`, a no-op unless --force restored an older schema
Write-Host "restored $Dump"
