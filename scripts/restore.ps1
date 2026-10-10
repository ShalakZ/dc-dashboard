# Restore a dump made by scripts\backup.ps1 into the running stack.
# Usage: scripts\restore.ps1 <dump> [--force] [--apply-retention]
# Exits 3 when the dump's Alembic revision differs from the running schema unless --force
# is given; after a forced restore the api container migrates on start.
# Retention: see scripts/restore.sh. Between pg_restore and timescaledb_post_restore() the script runs
# scripts\restore_retention.sql, which prints what the restored retention policies would delete and, when that is more than
# nothing, pauses the retention jobs (saving the Storage page starts them again). --apply-retention leaves them scheduled.
# Exit 4: the restore worked but the retention check failed (every retention job was paused to be safe unless --apply-retention
# was given; read the messages).
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Usage = "usage: restore.ps1 <dump> [--force] [--apply-retention]"
if ($args.Count -lt 1) { [Console]::Error.WriteLine($Usage); exit 2 }
$Dump = $args[0]
$Force = ""
$ApplyRetention = 0
foreach ($arg in ($args | Select-Object -Skip 1)) {
  if ($arg -eq "--force") { $Force = "--force" }
  elseif ($arg -eq "--apply-retention") { $ApplyRetention = 1 }
  else { [Console]::Error.WriteLine($Usage); exit 2 }
}
$RetentionSql = Join-Path $PSScriptRoot "restore_retention.sql"
$Current = ""
try { $Current = (docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version").Trim() } catch { }
$Wanted = if (Test-Path "$Dump.version") { (Get-Content -Raw "$Dump.version").Trim() } else { "unknown" }
if ($Current -ne $Wanted -and $Force -ne "--force") {
  [Console]::Error.WriteLine("refusing: dump schema '$Wanted' differs from running schema '$Current' (use --force to restore then migrate)")
  exit 3
}
docker compose stop api collector
docker compose exec -T db psql -U dcdash -d postgres -c "DROP DATABASE IF EXISTS dcdash WITH (FORCE)" -c "CREATE DATABASE dcdash OWNER dcdash"
docker compose exec -T db psql -U dcdash -d dcdash -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
# Whatever happens from here on, run timescaledb_post_restore() and start api/collector again
# so a failed restore never leaves the database stranded.
$Log = Join-Path ([IO.Path]::GetTempPath()) ("dcdash-restore-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$Failed = $true
$RetentionFailed = $false
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
  # Before the background workers come back: print what retention would delete and pause it if that is data.
  try {
    cmd /c "docker compose exec -T db psql -U dcdash -d dcdash -q -v apply_retention=$ApplyRetention < `"$RetentionSql`""
    if ($LASTEXITCODE -ne 0) { throw "psql exit $LASTEXITCODE" }
  } catch {
    $RetentionFailed = $true
    if ($ApplyRetention -eq 0) {
      # Fail safe: pausing loses nothing (the Storage page shows a banner and a Save starts retention again).
      docker compose exec -T db psql -U dcdash -d dcdash -qtAc "SELECT count(*) FROM (SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention') paused" | Out-Null
      Write-Host "could not check retention ($_): paused every retention job to be safe (see scripts\restore_retention.sql)"
    } else {
      Write-Host "could not check or pause retention ($_): data older than the restored limits may be deleted now"
    }
  }
  docker compose exec -T db psql -U dcdash -d dcdash -c "SELECT timescaledb_post_restore()" | Out-Null
  docker compose start api collector | Out-Null   # api runs `alembic upgrade head`, a no-op unless --force restored an older schema
  if ($Failed) { Write-Host "restore failed: ran timescaledb_post_restore() and started api/collector; log: $Log" }
}
Write-Host "restored $Dump"
if ($RetentionFailed) { exit 4 }
