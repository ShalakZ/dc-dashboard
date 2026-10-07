# Dump the running database to <out_dir>\dcdash-<stamp>.dump (pg_dump custom format)
# and record the Alembic schema revision next to it in <dump>.version.
# Usage: scripts\backup.ps1 [out_dir=.\backups]
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Out = if ($args.Count -ge 1) { $args[0] } else { ".\backups" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Stamp = Get-Date -Format yyyyMMdd-HHmmss
$File = Join-Path $Out "dcdash-$Stamp.dump"
# Custom-format dumps are binary: capture raw bytes, never text-decode them.
cmd /c "docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > `"$File`""
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
$Version = (docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version").Trim()
if ($LASTEXITCODE -ne 0) { throw "could not read alembic_version" }
Set-Content -Path "$File.version" -Encoding ascii -NoNewline -Value $Version
Write-Host "wrote $File (schema $Version)"
