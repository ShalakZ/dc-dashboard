# Dump the running database to <Out>\dcdash-<stamp>.dump (pg_dump custom format) and record the Alembic schema revision next to it in
# <dump>.version. Usage: scripts\backup.ps1 [Out=.\backups] [-Keep N] [-CopyTo DIR]
# Same contract and exit codes as scripts/backup.sh (1 failed, 2 usage, 5 backup made but NOT copied); -CopyTo needs a file
# .dcdash-backup-target in DIR whose first line is the Compose project name. Rotation (a folder that holds a dump named later than
# this backup is left alone), the one-backup-at-a-time lock (here a file .dcdash-backup.lock in Out) and a removal that fails (reported
# on stderr, exit code unchanged) behave as in backup.sh.
# Run it with powershell.exe -File: the exit code 5 does not reach the caller under -Command. PowerShell's own parameter-binding errors
# (a missing value, a duplicate parameter) exit 1, not 2.
param([string]$Out = ".\backups", [string]$Keep = "", [string]$CopyTo = "")
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Usage = "usage: backup.ps1 [Out] [-Keep N] [-CopyTo DIR]"
# Unknown named arguments land in $args and a bash-style --keep binds to $Out: refuse both. -Keep is a string checked by hand because an
# [int] parameter fails binding with exit 1 (verified on PowerShell 5.1), the contract says exit 2.
if ($args.Count -gt 0 -or $Out -like "-*" -or $CopyTo -like "-*") { [Console]::Error.WriteLine($Usage); exit 2 }
if ($PSBoundParameters.ContainsKey('CopyTo') -and -not $CopyTo) { [Console]::Error.WriteLine("$Usage (-CopyTo needs a folder)"); exit 2 }
$KeepN = 0
if ($Keep -ne "") {
  if ($Keep -notmatch '^[1-9][0-9]{0,4}$') { [Console]::Error.WriteLine("$Usage (-Keep takes a whole number from 1 to 99999)"); exit 2 }
  $KeepN = [int]$Keep
}
$Project = ""
try {
  $Line = docker compose config --no-interpolate | Select-String -Pattern '^name:\s*(\S+)' | Select-Object -First 1
  if ($Line) { $Project = $Line.Matches[0].Groups[1].Value }
} catch { }
$ProjectShown = if ($Project) { $Project } else { "unknown" }
Write-Host "backing up Compose project: $ProjectShown"

# An absolute Out: cmd /c below starts in the PowerShell location only when that is a drive path, and cmd expands a % in the path.
$Out = (New-Item -ItemType Directory -Force -Path $Out).FullName
if ($Out.Contains("%")) { [Console]::Error.WriteLine("the output folder '$Out' contains a % that cmd would expand; use another folder"); exit 2 }

# A bad copy folder does not stop the local backup: it is remembered and ends in exit 5.
$CopyProblem = ""
if ($CopyTo) {
  $Marker = Join-Path $CopyTo ".dcdash-backup-target"
  if (-not (Test-Path -LiteralPath $CopyTo -PathType Container)) {
    $CopyProblem = "'$CopyTo' is not an existing folder (is the drive connected?)"
  } elseif ((Resolve-Path -LiteralPath $CopyTo).ProviderPath.TrimEnd('\') -ieq $Out.TrimEnd('\')) {
    $CopyProblem = "'$CopyTo' is the output folder itself (the copy folder is the output folder; -CopyTo must be another folder, on the backup drive)"
  } elseif (-not $Project) {
    $CopyProblem = "cannot tell which Compose project this is (docker compose config failed), so the marker in '$CopyTo' cannot be checked"
  } elseif (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
    $CopyProblem = "'$CopyTo' has no .dcdash-backup-target file (not the backup drive, or not set up yet; create it once on the drive: Set-Content -Encoding ascii '$Marker' $Project)"
  } else {
    $First = (Get-Content -LiteralPath $Marker -TotalCount 1)
    if ("$First".Trim() -ne $Project) { $CopyProblem = "'$CopyTo' belongs to another installation (its .dcdash-backup-target names '$First', this is '$Project')" }
  }
  if ($CopyProblem) { Write-Host "-CopyTo: $CopyProblem. The local backup will still be attempted; it will NOT be copied." }
}

# One backup at a time per Out: two runs started in the same second would share one partial file. The lock is taken before the
# same-second check and released in the finally below, also when the script is run from a console that stays open.
try {
  $Lock = [IO.File]::Open((Join-Path $Out ".dcdash-backup.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  $Reason = $_.Exception
  if ($Reason.InnerException) { $Reason = $Reason.InnerException }
  if ($Reason -is [System.IO.IOException] -and ($Reason.HResult -band 0xFFFF) -eq 32) {
    [Console]::Error.WriteLine("another backup is running in $Out; nothing was changed")
  } else {
    [Console]::Error.WriteLine("could not take the lock in ${Out}: $($Reason.Message); nothing was changed")
  }
  exit 1
}
try {
  $Stamp = Get-Date -Format yyyyMMdd-HHmmss
  $Name = "dcdash-$Stamp.dump"
  $File = Join-Path $Out $Name
  $Partial = Join-Path $Out ".dcdash-$Stamp.partial"
  if (Test-Path -LiteralPath $File) {
    [Console]::Error.WriteLine("a backup named $Name already exists (two backups in the same second); wait a second and run again. Nothing was changed."); exit 1
  }
  try {
    # Custom-format dumps are binary: capture raw bytes through cmd, never text-decode them.
    cmd /c "docker compose exec -T db pg_dump -U dcdash -d dcdash -Fc > `"$Partial`""
    if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
    if (-not (Test-Path -LiteralPath $Partial) -or (Get-Item -LiteralPath $Partial).Length -eq 0) { throw "pg_dump wrote nothing" }
    # A full read, not --list (which reads only the table of contents). /dev/null is the path INSIDE the container.
    cmd /c "docker compose exec -T db pg_restore -f /dev/null < `"$Partial`""
    if ($LASTEXITCODE -ne 0) { throw "the new dump cannot be read back" }
    $Raw = docker compose exec -T db psql -U dcdash -d dcdash -tAc "SELECT version_num FROM alembic_version"
    if ($LASTEXITCODE -ne 0 -or -not $Raw) { throw "could not read the schema revision" }
    $Version = "$Raw".Trim()
    Move-Item -LiteralPath $Partial -Destination $File
    Set-Content -LiteralPath "$File.version.partial" -Encoding ascii -NoNewline -Value $Version
    Move-Item -LiteralPath "$File.version.partial" -Destination "$File.version"
  } catch {
    [Console]::Error.WriteLine("$_; no backup was made and no old backup was touched")
    exit 1
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Partial, "$File.version.partial"
  }
  Write-Host "wrote $File (schema $Version)"
  Write-Host "note: .env and certs/ are NOT in this dump. .env holds DCDASH_SECRET_KEY, the key that encrypts the stored source secrets: keep a copy of both with the dump, or the secrets cannot be decrypted after a restore."

  if ($CopyTo -and -not $CopyProblem) {
    $p = Join-Path $CopyTo ".$Name.partial"; $v = Join-Path $CopyTo ".$Name.version.partial"
    try {
      if (Test-Path -LiteralPath (Join-Path $CopyTo $Name)) { throw "$Name already exists there" }
      Copy-Item -LiteralPath $File -Destination $p
      Copy-Item -LiteralPath "$File.version" -Destination $v
      if ((Get-FileHash -LiteralPath $File).Hash -ne (Get-FileHash -LiteralPath $p).Hash -or
          (Get-FileHash -LiteralPath "$File.version").Hash -ne (Get-FileHash -LiteralPath $v).Hash) { throw "the copy differs from the original" }
      Move-Item -LiteralPath $v -Destination (Join-Path $CopyTo "$Name.version")
      Move-Item -LiteralPath $p -Destination (Join-Path $CopyTo $Name)
      Write-Host "copied to $CopyTo"
    } catch {
      Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $p, $v
      $CopyProblem = "the copy to '$CopyTo' failed ($_)"
      [Console]::Error.WriteLine($CopyProblem)
    }
  }

  # Oldest first by name (the stamp sorts like time). The dump written by this run is never deleted. When a dump sorts after it
  # (the clock went back, or a file was misnamed) the folder is left alone: oldest first would eat the previous nights' backups.
  function Invoke-Rotate([string]$Dir) {
    $all = @(Get-ChildItem -LiteralPath $Dir -File |
      Where-Object { $_.Name -cmatch '^dcdash-[0-9]{8}-[0-9]{6}\.dump$' -and (Test-Path -LiteralPath ($_.FullName + ".version")) } |
      Sort-Object Name)
    if ($all.Count -gt 0 -and $all[$all.Count - 1].Name -ne $Name) {
      [Console]::Error.WriteLine("not rotating ${Dir}: $($all[$all.Count - 1].Name) is named later than this backup (is the clock right?)")
      return
    }
    for ($i = 0; $i -lt ($all.Count - $KeepN); $i++) {
      if ($all[$i].Name -eq $Name) { continue }
      # the dump first, its .version after; a failed removal is reported and does not stop the rest (exit code unchanged)
      try {
        Remove-Item -Force -ErrorAction Stop -LiteralPath $all[$i].FullName
      } catch {
        [Console]::Error.WriteLine("could not remove $($all[$i].FullName); the new backup is fine")
        continue
      }
      try {
        Remove-Item -Force -ErrorAction Stop -LiteralPath ($all[$i].FullName + ".version")
      } catch {
        [Console]::Error.WriteLine("could not remove $($all[$i].FullName).version; the new backup is fine")
      }
      Write-Host "removed old backup $($all[$i].FullName)"
    }
  }
  if ($KeepN -gt 0 -and -not $CopyProblem) {
    Invoke-Rotate $Out
    if ($CopyTo) { Invoke-Rotate $CopyTo }
  }
  if ($CopyProblem) {
    [Console]::Error.WriteLine("local backup made, NOT copied; nothing was rotated (exit 5)")
    exit 5
  }
} finally {
  $Lock.Dispose()
}
