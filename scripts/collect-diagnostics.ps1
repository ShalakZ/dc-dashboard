# Host facts for field debugging when the web app itself is down: one text file to copy and paste to whoever helps.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1 [host:port ...] [-OutDir DIR] [-ProjectDir DIR]
# Prints the report and saves dcdash-diag-<yyyyMMdd-HHmmss>.txt in -OutDir (default: the logs folder inside the project folder, else
# inside the current folder; created if missing). Each host:port gets a DNS lookup and a TCP connect (3 s timeout).
# Sections: HOST DISKS NETWORK CLOCK TARGETS LOCAL PORTS TOOLS ON PATH SERVICES DATABASE API LOGS.
# -ProjectDir is the folder with compose.yaml and .env (default: the current folder, else the script's parent folder, if one of them has
# a compose.yaml). With docker and a compose.yaml it reads container status, the database and the service logs, and ALSO saves
# dcdash-diag-<same time>-logs.txt (the last 300 lines per service; saved, never printed). Without them those sections say so.
# Every line is cut at 64 KB, scrubbed (URL credentials "://user:pass@" and the secret values of the project's .env become [hidden]) and
# clipped; the report only says HOW MANY .env values it hides. Every external command has a time limit, so a hung docker cannot hang this.
# Read-only, needs no internet and none of the application. PowerShell 5.1 compatible.
# Files are UTF-8 without BOM with LF line breaks. The last line is `END OF DIAGNOSTICS <12 hex>`: the first 12 hex characters of the
# SHA-256 of every line before it, joined by LF (UTF-8 bytes, no trailing LF), so a paste can be verified.
# Other modes (they exit before any collection): -ScrubSelfTest <scrub_cases.tsv> checks the scrubber against the shared fixture
# (backend\tests\fixtures\scrub_cases.tsv) and exits 0 only when every case passes; -ScrubFile <file> [-EnvFile <.env>] prints that file
# scrubbed with the same rules (default .env: the project's), to check a text before pasting it. -DockerPath <docker.exe> overrides the docker found on the PATH.
# Exit codes: 0 report written, 1 a file could not be saved (the report was still printed).
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Targets,
  [string]$OutDir,   # empty: <project folder>\logs, resolved once the project folder is known
  [string]$ProjectDir,
  [string]$ScrubSelfTest,
  [string]$ScrubFile,
  [string]$EnvFile,
  [string]$DockerPath,
  [int]$CommandTimeoutSeconds = 10   # the limit of one external command (docker compose logs: three times as long); tests shorten it
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Version = "1"
$Inv = [Globalization.CultureInfo]::InvariantCulture   # Gregorian dates and Latin digits whatever the regional settings
$Utf8 = New-Object Text.UTF8Encoding $false
$Ellipsis = [string][char]0x2026
$Ws = [char[]](32, 9, 10, 11, 12, 13)   # ASCII whitespace only: a no-break space inside a password must not split a run
$Lines = New-Object 'System.Collections.Generic.List[string]'
$LogLines = New-Object 'System.Collections.Generic.List[string]'
$Known = @()   # the values to hide, longest first (Get-KnownValues)
$DockerDown = $false
$Containers = $false
$LogServices = 0
$OldEnc = $null
try { if ([Console]::IsOutputRedirected) { $OldEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = $Utf8 } } catch { }   # piped output is UTF-8
function Stop-Script([int]$Code) {   # every way out: puts the console code page back
  if ($OldEnc) { try { [Console]::OutputEncoding = $OldEnc } catch { } }
  exit $Code
}

# ---- the scrubber: a second copy of core/audit.py scrub_url_credentials, tested against the shared fixture ----
function Get-KnownValues([string[]]$Values) {
  $set = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($v in $Values) {
    $colon = $v.IndexOf([char]58)
    if ($v.Length -ge 4) { [void]$set.Add($v) }
    if ($colon -ge 0 -and $v.Length - $colon - 1 -ge 4) { [void]$set.Add($v.Substring($colon + 1)) }
  }
  $list = New-Object 'System.Collections.Generic.List[string]'
  $list.AddRange($set)
  $list.Sort([Comparison[string]]{ param($a, $b) if ($a.Length -ne $b.Length) { return $b.Length - $a.Length }; return [string]::CompareOrdinal($a, $b) })
  return ,$list.ToArray()
}
function Get-Scrubbed([string]$Text, [string[]]$Hide) {
  foreach ($k in $Hide) { $Text = $Text.Replace($k, "[hidden]") }   # ordinal and case-sensitive; never a pattern
  $ord = [StringComparison]::Ordinal
  if ($Text.IndexOf("://", $ord) -lt 0 -or $Text.IndexOf([char]64) -lt 0) { return $Text }
  # One left-to-right pass over the runs of non-space text: in each, the first "://" up to the last "@" becomes "://[hidden]@".
  # Every search is bounded to its run and the unchanged text is copied once, so the time stays linear however long the line is.
  $out = New-Object Text.StringBuilder
  $n = $Text.Length; $at = [char]64; $from = 0; $i = 0
  while ($i -lt $n) {
    $j = $Text.IndexOfAny($Ws, $i)
    if ($j -lt 0) { $j = $n }
    $len = $j - $i
    if ($len -ge 4) {
      $s = $Text.IndexOf("://", $i, $len, $ord)
      if ($s -ge 0) {
        $e = $Text.LastIndexOf($at, $j - 1, $len)
        if ($e -ge $s + 3) { [void]$out.Append($Text, $from, $s - $from).Append("://[hidden]@"); $from = $e + 1 }
      }
    }
    $i = $j + 1
  }
  [void]$out.Append($Text, $from, $n - $from)
  return $out.ToString()
}
function Format-Line([string]$Raw, [int]$Clip, [int]$Cap = 65536) {   # cap the raw line, THEN scrub, THEN clip (a clipped URL would leak half a password)
  $cut = $Cap -gt 0 -and $Raw.Length -gt $Cap
  if ($cut) { $Raw = $Raw.Substring(0, $Cap) }
  $s = Get-Scrubbed $Raw $Known
  if ($Clip -gt 0 -and $s.Length -gt $Clip) { return $s.Substring(0, $Clip - 1) + $Ellipsis }
  if ($cut) { return $s + $Ellipsis }
  return $s
}
function Add-Line([string]$Text, [int]$Clip = 0, [string]$Prefix = "", [Collections.Generic.List[string]]$To = $Lines) {   # the one way a line enters a file
  foreach ($l in $Text.Replace("`r", "").Split([char]10)) { $To.Add($Prefix + (Format-Line $l $Clip)) }
}
function Read-EnvSecrets([string]$Path) {   # the twin of load_env in collect-diagnostics.sh (backend/tests/fixtures/env_cases.tsv pins both)
  # Values of PASSWORD/SECRET/TOKEN/KEY variables: Found counts them, Hide also holds the unescaped form of a double-quoted one (the form
  # compose hands to a container and a log quotes). Parsed, never sourced; like the sh copy it does NOT expand $VAR the way compose does.
  $r = @{ Found = (New-Object 'System.Collections.Generic.List[string]'); Hide = (New-Object 'System.Collections.Generic.List[string]') }
  if (-not ($Path -and (Test-Path -LiteralPath $Path -PathType Leaf))) { return $r }
  $blank = [char[]](32, 9)
  foreach ($raw in [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).Split([char]10)) {   # lines end at LF only, as awk reads them
    $l = ($raw -creplace '\r$', '').TrimStart($blank)
    if ($l.Length -eq 0 -or $l[0] -ceq '#') { continue }
    $l = $l -creplace '^export[ \t]+', ''
    $eq = $l.IndexOf([char]61)
    if ($eq -lt 1 -or $l.Substring(0, $eq) -notmatch 'PASSWORD|SECRET|TOKEN|KEY') { continue }
    $v = $l.Substring($eq + 1).TrimStart($blank)
    $dq = $v.Length -gt 0 -and $v[0] -ceq '"'
    if ($v.Length -gt 0 -and $v[0] -ceq "'") { $end = $v.IndexOf([char]39, 1); $v = $(if ($end -gt 0) { $v.Substring(1, $end - 1) } else { $v.Substring(1) }) }
    elseif ($dq) { $v = [regex]::Match($v, '^"((?:[^"\\]|\\.|\\$)*)').Groups[1].Value }   # up to the first unescaped quote
    else { $m = [regex]::Match($v, '[ \t]#'); if ($m.Success) { $v = $v.Substring(0, $m.Index) }; $v = $v.TrimEnd($blank) }
    if ($v.Length -lt 4) { continue }
    $r.Found.Add($v); $r.Hide.Add($v)
    if ($dq) { $u = [regex]::Replace($v, '\\(["\\])', '$1'); if ($u -cne $v) { $r.Hide.Add($u) } }
  }
  return $r
}
function ConvertFrom-Escapes([string]$S) {   # the fixture's escapes, decoded in ONE left-to-right pass
  if ($S -ceq "(empty)") { return "" }
  $sb = New-Object Text.StringBuilder
  for ($i = 0; $i -lt $S.Length; $i++) {
    if ($S[$i] -cne [char]92) { [void]$sb.Append($S[$i]); continue }
    $i++
    $c = $(if ($i -lt $S.Length) { [string]$S[$i] } else { "" })
    if ($c -ceq "t") { [void]$sb.Append("`t") } elseif ($c -ceq "r") { [void]$sb.Append("`r") } elseif ($c -ceq "\") { [void]$sb.Append("\") } else { throw "bad escape in the fixture: \$c" }
  }
  return $sb.ToString()
}
function ConvertTo-Escapes([string]$S) {
  if ($S.Length -eq 0) { return "(empty)" }
  return $S.Replace("\", "\\").Replace("`t", "\t").Replace("`r", "\r").Replace("`n", "\n")
}

if ($ScrubSelfTest) {   # before any collection: no docker, no files written
  $ok = 0; $bad = 0; $no = 0
  try { $rows = [IO.File]::ReadAllLines($ScrubSelfTest, [Text.Encoding]::UTF8) } catch { [Console]::Error.WriteLine("cannot read the fixture: $($_.Exception.Message)"); Stop-Script 1 }
  foreach ($row in $rows) {
    $no++
    if ($row.Length -eq 0 -or $row[0] -ceq '#') { continue }
    $c = $row.Split([char]9)
    if ($c.Count -ne 4) { Write-Host "case line$no FAIL expected 4 tab-separated columns, got $($c.Count)"; $bad++; continue }
    try {
      $hide = $(if ($c[1] -ceq "-") { @() } else { $c[1].Split([char]124) })
      $want = ConvertFrom-Escapes $c[3]
      $got = Get-Scrubbed (ConvertFrom-Escapes $c[2]) (Get-KnownValues $hide)
      if ([string]::Equals($got, $want, [StringComparison]::Ordinal)) { Write-Host "case $($c[0]) OK"; $ok++ }
      else { Write-Host "case $($c[0]) FAIL expected=<$(ConvertTo-Escapes $want)> got=<$(ConvertTo-Escapes $got)>"; $bad++ }
    } catch { Write-Host "case $($c[0]) FAIL $($_.Exception.Message)"; $bad++ }
  }
  Write-Host "SCRUB SELF-TEST $ok OK $bad FAILED"
  Stop-Script $(if ($bad -eq 0) { 0 } else { 1 })
}

# ---- where things are ----
$Root = $null
if ($ProjectDir) { $Root = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ProjectDir) }   # explicit: never fall back
else {
  foreach ($c in (Get-Location).Path, $(if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent })) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c "compose.yaml") -PathType Leaf)) { $Root = $c; break }
  }
}
$HasCompose = [bool]($Root -and (Test-Path -LiteralPath (Join-Path $Root "compose.yaml") -PathType Leaf))
$EnvPath = $(if ($EnvFile) { $EnvFile } elseif ($Root) { Join-Path $Root ".env" })
$EnvRead = Read-EnvSecrets $EnvPath
$Known = Get-KnownValues $EnvRead.Hide
if ($ScrubFile) {
  try { foreach ($l in [IO.File]::ReadAllLines($ScrubFile, [Text.Encoding]::UTF8)) { Write-Host (Format-Line $l 0 0) } }
  catch { [Console]::Error.WriteLine("cannot read ${ScrubFile}: $($_.Exception.Message)"); Stop-Script 1 }
  Stop-Script 0
}
$Docker = $null
if ($DockerPath) { if (Test-Path -LiteralPath $DockerPath -PathType Leaf) { $Docker = $DockerPath } }
else { $c = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $Docker = $c.Source } }
$OutBase = $(if ($OutDir) { $OutDir } elseif ($Root) { Join-Path $Root "logs" } else { Join-Path (Get-Location).Path "logs" })
$OutFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutBase)
$Stamp = (Get-Date).ToString("yyyyMMdd-HHmmss", $Inv)
$MainFile = Join-Path $OutFull "dcdash-diag-$Stamp.txt"
$LogsFile = Join-Path $OutFull "dcdash-diag-$Stamp-logs.txt"

function Section([string]$Name, [scriptblock]$Body) {
  Add-Line ""
  Add-Line "== $Name =="
  try { & $Body } catch { Add-Line "section failed: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
}
function Join-Or([object[]]$Items, [string]$Empty = "-") {
  if ($Items.Count -gt 0) { return ($Items -join ", ") }
  return $Empty
}
function Format-Err($Err) {
  if ($Err -is [Management.Automation.ErrorRecord]) { $Err = $Err.Exception }   # `$_` in a catch block
  $b = $Err.GetBaseException()
  $code = ""
  if ($b -is [Net.Sockets.SocketException]) { $code = " (" + $b.SocketErrorCode + ")" }
  return $b.GetType().Name + $code + ": " + $b.Message
}
function Get-TextLines([string]$Text) { return $Text.Replace("`r", "").Split([char]10) }
function Read-Text([string]$Path, [Text.Encoding]$Enc) {   # shared read access: a child that outlived its kill may still hold the file
  $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try { return (New-Object IO.StreamReader($fs, $Enc, $true)).ReadToEnd() } finally { $fs.Dispose() }
}
function Test-InsideOneDrive([string]$Path) {   # the folder name says OneDrive, or the folder lies under the sync root Windows publishes
  if ($Path -match 'OneDrive') { return $true }
  foreach ($base in $env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer) {
    if ($base -and ($Path.TrimEnd('\') + '\').StartsWith($base.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
function Test-Tcp([Net.IPAddress]$Addr, [int]$Port, [int]$Ms = 3000) {
  $c = New-Object Net.Sockets.TcpClient -ArgumentList $Addr.AddressFamily
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $ar = $c.BeginConnect($Addr, $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($Ms, $false)) { return "FAILED in $($sw.ElapsedMilliseconds) ms: timeout (no answer within $Ms ms)" }
    $c.EndConnect($ar)
    return "OK in $($sw.ElapsedMilliseconds) ms"
  } catch { return "FAILED in $($sw.ElapsedMilliseconds) ms: $(Format-Err $_)" } finally { $c.Close() }
}
function Invoke-Limited([string]$File, [string[]]$ArgList, [int]$Seconds, [string]$WorkDir, [Text.Encoding]$Enc = $Utf8) {   # output to temp files, never through a shell
  $r = [pscustomobject]@{ TimedOut = $false; Failed = $null; ExitCode = $null; Out = ""; Err = "" }
  $o = [IO.Path]::GetTempFileName(); $e = [IO.Path]::GetTempFileName()
  try {
    $sp = @{ FilePath = $File; NoNewWindow = $true; PassThru = $true; RedirectStandardOutput = $o; RedirectStandardError = $e }
    $text = (@($ArgList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })) -join " "   # 5.1 does not quote array items
    if ($text) { $sp.ArgumentList = $text }
    if ($WorkDir) { $sp.WorkingDirectory = $WorkDir }
    $p = Start-Process @sp
    $null = $p.Handle   # without it ExitCode can come back empty on 5.1
    if ($p.WaitForExit($Seconds * 1000)) { $r.ExitCode = $p.ExitCode; $r.Out = Read-Text $o $Enc; $r.Err = Read-Text $e $Enc }
    else {
      $r.TimedOut = $true
      try { Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID $($p.Id) /T /F" -WindowStyle Hidden -Wait } catch { }   # the whole tree
      try { if (-not $p.HasExited) { $p.Kill() } } catch { }
    }
  } catch { $r.Failed = Format-Err $_ }
  finally {
    Remove-Item -LiteralPath $o, $e -ErrorAction SilentlyContinue
    if ($r.TimedOut -and ((Test-Path -LiteralPath $o) -or (Test-Path -LiteralPath $e))) {   # a child that outlived the kill may still hold them
      Start-Sleep -Milliseconds 500
      Remove-Item -LiteralPath $o, $e -ErrorAction SilentlyContinue
      $left = @($o, $e | Where-Object { Test-Path -LiteralPath $_ })
      if ($left.Count -gt 0) { [Console]::Error.WriteLine("raw, unscrubbed command output is still in " + ($left -join " and ") + ": delete it by hand") }
    }
  }
  return $r
}
function Invoke-Docker([string[]]$ArgList, [int]$Seconds) {   # $null when docker gave no answer; after the first such failure no more calls
  if ($script:DockerDown) { return $null }
  $r = Invoke-Limited $Docker $ArgList $Seconds $Root
  if ($r.TimedOut) { $script:DockerDown = $true; Add-Line "docker did not answer within $Seconds s; container sections skipped"; return $null }
  if ($r.Failed) { $script:DockerDown = $true; Add-Line "docker could not be run ($($r.Failed)); container sections skipped"; return $null }
  return $r
}

try {
  $now = Get-Date
  Add-Line "DCDASH-DIAG v$Version | collect-diagnostics.ps1 | PowerShell $($PSVersionTable.PSVersion)"
  Add-Line ("local time: " + $now.ToString("yyyy-MM-dd HH:mm:ss zzz", $Inv) + " (" + [TimeZoneInfo]::Local.Id + ")")
  Add-Line ("utc time:   " + $now.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss", $Inv))
  $hides = "scrubbing: URL credentials, and $($EnvRead.Found.Count) secret value(s) read from .env ($(if ($EnvPath -and (Test-Path -LiteralPath $EnvPath)) { 'found' } else { 'not found' }))"
  Add-Line $hides
  Add-Line "DCDASH-DIAG-LOGS v$Version | collect-diagnostics.ps1 | PowerShell $($PSVersionTable.PSVersion)" -To $LogLines
  Add-Line ("local time: " + $now.ToString("yyyy-MM-dd HH:mm:ss zzz", $Inv)) -To $LogLines
  Add-Line "$hides; each line is cut at 1000 characters" -To $LogLines
} catch { Add-Line "header failed: $($_.Exception.Message)" }

Section "HOST" {
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Line "os: $($os.Caption) $($os.Version) $($os.OSArchitecture)"
  Add-Line "computer: $env:COMPUTERNAME  user: $env:USERNAME  cpus: $([Environment]::ProcessorCount)"
  Add-Line "project folder: $(if ($Root) { $Root } else { 'none found' })"
  if ($Root -and (Test-InsideOneDrive $Root)) {
    Add-Line "WARNING: inside OneDrive: .env (the database password and the key that decrypts stored credentials) and these files sync to the cloud; install outside synced folders (docs/field-debugging.md)"
  }
  $up = (Get-Date) - $os.LastBootUpTime
  Add-Line ("uptime: {0}d {1}h {2}m (booted {3})" -f $up.Days, $up.Hours, $up.Minutes, $os.LastBootUpTime.ToString("yyyy-MM-dd HH:mm", $Inv))
  Add-Line ("memory: {0} MB free of {1} MB" -f [int]($os.FreePhysicalMemory / 1KB), [int]($os.TotalVisibleMemorySize / 1KB))
}

Section "DISKS" {
  foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
    Add-Line ("{0} {1} GB free of {2} GB" -f $d.DeviceID, [math]::Round($d.FreeSpace / 1GB, 1), [math]::Round($d.Size / 1GB, 1))
  }
}

Section "NETWORK" {
  $down = @()
  foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.NetworkInterfaceType -eq "Loopback") { continue }
    if ($n.OperationalStatus -ne "Up") { $down += $n.Name; continue }
    $p = $n.GetIPProperties()
    $v4 = @($p.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq "InterNetwork" } | ForEach-Object { "$($_.Address)/$($_.PrefixLength)" })
    $gw = @($p.GatewayAddresses | ForEach-Object { "$($_.Address)" })
    $dns = @($p.DnsAddresses | ForEach-Object { "$_" })
    Add-Line ("adapter {0}: ipv4 {1}; gateway {2}; dns {3}" -f $n.Name, (Join-Or $v4), (Join-Or $gw), (Join-Or $dns))
  }
  Add-Line ("adapters not up: " + (Join-Or $down "none"))
}

Section "CLOCK" {
  Add-Line ("system clock (utc): " + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss", $Inv))
  try { $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) } catch { $oem = $Utf8 }   # w32tm speaks the console code page
  $r = Invoke-Limited "w32tm.exe" @("/query", "/status") $CommandTimeoutSeconds "" $oem
  if ($r.TimedOut) { Add-Line "w32tm /query /status did not answer within $CommandTimeoutSeconds s" }
  elseif ($r.Failed) { Add-Line "w32tm not available: $($r.Failed)" }   # its errors go to stderr: keep them as text
  else {
    Add-Line "w32tm /query /status (exit code $($r.ExitCode)):"
    foreach ($l in @(Get-TextLines ($r.Out + "`n" + $r.Err) | Where-Object { $_.Trim() } | Select-Object -First 14)) { Add-Line "  $($l.Trim())" }
  }
}

Section "TARGETS (DNS lookup, then TCP connect with a 3 s timeout)" {
  $items = @()
  foreach ($raw in $Targets) { $items += @($raw -split "[,;\s]+" | Where-Object { $_ }) }
  if ($items.Count -eq 0) { Add-Line "none given (pass host:port pairs, for example 10.0.0.5:4840)" }
  foreach ($t in $items) {
    try {
      Add-Line "target ${t}"
      if (-not ($t -match '^\[(.+)\]:(\d{1,5})$' -or $t -match '^([^:\[\]]+):(\d{1,5})$') -or [int]$Matches[2] -lt 1 -or [int]$Matches[2] -gt 65535) {
        Add-Line "  invalid (expected host:port)"
        continue
      }
      $h = $Matches[1]; $port = [int]$Matches[2]
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $task = [Net.Dns]::GetHostAddressesAsync($h)   # async so a dead DNS server cannot stall the script
      try { $done = $task.Wait(5000) } catch { $done = $true }
      $ms = $sw.ElapsedMilliseconds
      if (-not $done) { Add-Line "  dns FAILED in ${ms} ms: no answer within 5000 ms"; Add-Line "  tcp skipped (no address)"; continue }
      if ($task.IsFaulted) { Add-Line "  dns FAILED in ${ms} ms: $(Format-Err $task.Exception)"; Add-Line "  tcp skipped (no address)"; continue }
      $addrs = @($task.Result | Select-Object -First 3)
      Add-Line "  dns OK in ${ms} ms: $(Join-Or $addrs)"
      foreach ($a in $addrs) {
        $ep = $(if ($a.AddressFamily -eq "InterNetworkV6") { "[$a]" } else { "$a" }) + ":$port"
        Add-Line "  tcp ${ep} $(Test-Tcp $a $port)"
      }
    } catch { Add-Line "  target failed: $(Format-Err $_)" }
  }
}

Section "LOCAL PORTS" {
  $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  foreach ($port in 80, 443, 8000) {
    $on = @($listeners | Where-Object { $_.Port -eq $port } | ForEach-Object { "$($_.Address)" })
    Add-Line ("port ${port}: " + $(if ($on.Count -gt 0) { "something is listening on " + ($on -join ", ") } else { "nothing is listening" }))
  }
}

Section "TOOLS ON PATH" {
  foreach ($name in "docker", "wsl", "python") {
    $path = $Docker
    if ($name -ne "docker") { $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1; $path = $(if ($c) { $c.Source }) }
    Add-Line ("{0}: {1}" -f $name, $(if ($path) { $path } else { "not found" }))
  }
}

Section "SERVICES" {
  if (-not $Docker) { Add-Line "container sections skipped (docker not found)" }
  elseif (-not $HasCompose) { Add-Line "container sections skipped (no compose.yaml in $(if ($Root) { $Root } else { 'the current or the script folder; pass -ProjectDir' }))" }
  else {
    $r = Invoke-Docker @("compose", "ps", "-a") $CommandTimeoutSeconds
    if ($r) {
      Add-Line "docker compose ps -a in ${Root} (exit code $($r.ExitCode)):"
      $rows = @(Get-TextLines ($r.Out + "`n" + $r.Err) | Where-Object { $_.Trim() })
      foreach ($l in $rows) { Add-Line $l -Clip 300 -Prefix "  " }
      $script:Containers = $r.ExitCode -eq 0 -and @(Get-TextLines $r.Out | Where-Object { $_.Trim() }).Count -gt 1   # a header and at least one row
    }
  }
  if (-not $script:Containers) {
    $svc = @(Get-Service -Name "dcdash*", "postgres*" -ErrorAction SilentlyContinue)
    Add-Line ("windows services dcdash*, postgres*:" + $(if ($svc.Count -eq 0) { " none found" } else { "" }))
    foreach ($s in $svc) { Add-Line ("  {0}  {1}  start type {2}" -f $s.Name, $s.Status, $s.StartType) }
  }
}

Section "DATABASE" {
  $done = $false
  if ($script:Containers) {
    # the user and database compose.yaml gives db (its own healthcheck uses the same); a bare pg_isready makes the server log a FATAL for "root"
    $r = Invoke-Docker @("compose", "exec", "-T", "db", "pg_isready", "-U", "dcdash", "-d", "dcdash") $CommandTimeoutSeconds
    if ($r) {
      Add-Line "docker compose exec -T db pg_isready -U dcdash -d dcdash (exit code $($r.ExitCode)):"
      foreach ($l in @(Get-TextLines ($r.Out + "`n" + $r.Err) | Where-Object { $_.Trim() })) { Add-Line $l -Clip 300 -Prefix "  " }
      $done = $true
    }
  }
  if (-not $done) { Add-Line "tcp 127.0.0.1:5432 $(Test-Tcp ([Net.IPAddress]::Loopback) 5432)" }
}

Section "API" {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  foreach ($url in "http://127.0.0.1/api/health", "http://127.0.0.1:8000/api/health") {
    $native = $url -match ':8000'
    if ($native -and $script:Containers) {   # SERVICES ran first: under Docker only the web container publishes a port
      Add-Line "GET $url"
      Add-Line "  n/a (Docker install: the api is not published on the host)"
      continue
    }
    $note = $(if ($native) { " (native install only)" } else { "" })
    $sw = [Diagnostics.Stopwatch]::StartNew(); $code = $null; $body = ""; $err = $null
    try {
      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 3
      $code = [int]$resp.StatusCode; $body = [string]$resp.Content
    } catch {
      $r = $_.Exception.Response   # an HTTP error status (or a redirect) still has an answer
      if ($r) {
        $code = [int]$r.StatusCode
        try { $body = (New-Object IO.StreamReader($r.GetResponseStream(), $Utf8)).ReadToEnd() } catch { }
      } else { $err = Format-Err $_ }
    }
    Add-Line "GET ${url}${note}"
    if ($err) { Add-Line "  FAILED in $($sw.ElapsedMilliseconds) ms: $err" }
    else {
      Add-Line "  HTTP $code in $($sw.ElapsedMilliseconds) ms"
      Add-Line ("body: " + ($body.Substring(0, [Math]::Min($body.Length, 65536)) -creplace '[ \t\n\v\f\r]+', ' ')) -Clip 306 -Prefix "  "
    }
  }
}

Section "LOGS" {
  if (-not $Docker -or -not $HasCompose) { Add-Line "container sections skipped (see SERVICES); no logs file"; return }
  $r = Invoke-Docker @("compose", "config", "--services") $CommandTimeoutSeconds
  if (-not $r) { Add-Line "no logs read, no logs file"; return }
  $names = @(Get-TextLines $r.Out | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z0-9][A-Za-z0-9_.-]*$' } | Select-Object -First 30)
  Add-Line "services: $(Join-Or $names 'none')"
  foreach ($svc in $names) {
    $r = Invoke-Docker @("compose", "logs", "--no-color", "--tail", "300", $svc) ($CommandTimeoutSeconds * 3)
    if (-not $r) { break }
    $tail = @(Get-TextLines $r.Out | Where-Object { $_.Trim() } | Select-Object -Last 300)
    if ($r.ExitCode -ne 0 -and $tail.Count -eq 0) { Add-Line "-- ${svc}: docker compose logs failed (exit code $($r.ExitCode)): $($r.Err.Trim())" -Clip 300; continue }
    $show = @($tail | Select-Object -Last 30)
    Add-Line "-- $svc (last $($show.Count) of $($tail.Count) lines read)"
    foreach ($l in $show) { Add-Line $l -Clip 240 -Prefix "  " }
    Add-Line "== $svc ==" -To $LogLines
    foreach ($l in $tail) { Add-Line $l -Clip 1000 -To $LogLines }
    $script:LogServices++
  }
  Add-Line $(if ($script:LogServices -gt 0) { "logs file (the last 300 lines per service, saved next to this report): $LogsFile" } else { "no logs read, no logs file" })
}

function Get-Report($List) {
  $body = $List -join "`n"
  $sha = [Security.Cryptography.SHA256]::Create()
  $sum = ([BitConverter]::ToString($sha.ComputeHash($Utf8.GetBytes($body))) -replace "-", "").ToLower().Substring(0, 12)
  return $body + "`n" + "END OF DIAGNOSTICS $sum" + "`n"
}
$text = Get-Report $Lines
Write-Host $text

try {
  if (-not (Test-Path -LiteralPath $OutFull)) { New-Item -ItemType Directory -Path $OutFull -Force | Out-Null }
  if ($LogServices -gt 0) { [IO.File]::WriteAllText($LogsFile, (Get-Report $LogLines), $Utf8); Write-Host "saved: $LogsFile" }
  [IO.File]::WriteAllText($MainFile, $text, $Utf8)   # never Out-File or >: they write UTF-16 on PowerShell 5.1
  Write-Host "saved: $MainFile"
} catch {
  [Console]::Error.WriteLine("could not save the report: $($_.Exception.Message)")
  Stop-Script 1
}
Stop-Script 0
