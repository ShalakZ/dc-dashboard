# Host facts for field debugging when the web app itself is down: one text file to copy and paste to whoever helps.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1 [host:port ...] [-OutDir DIR]
# Prints the report and saves dcdash-diag-<yyyyMMdd-HHmmss>.txt in -OutDir (default: the current folder). Each host:port gets a DNS
# lookup and a TCP connect (3 s timeout). Read-only, needs no internet and none of the application. PowerShell 5.1 compatible.
# The file is UTF-8 without BOM with LF line breaks. Its last line is `END OF DIAGNOSTICS <12 hex>`: the first 12 hex characters of the
# SHA-256 of every line before it, joined by LF (UTF-8 bytes, no trailing LF), so a paste can be verified.
# Exit codes: 0 report written, 1 the file could not be saved (the report was still printed).
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Targets,
  [string]$OutDir = (Get-Location).Path
)
$ErrorActionPreference = "Stop"
$Version = "1"
$Inv = [Globalization.CultureInfo]::InvariantCulture   # Gregorian dates and Latin digits whatever the regional settings
$Lines = New-Object 'System.Collections.Generic.List[string]'

function Add-Line([string]$Text) {
  foreach ($l in ($Text -replace "`r", "" -split "`n")) { $Lines.Add($l) }
}
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

try {
  $now = Get-Date
  Add-Line "DCDASH-DIAG v$Version | collect-diagnostics.ps1 | PowerShell $($PSVersionTable.PSVersion)"
  Add-Line ("local time: " + $now.ToString("yyyy-MM-dd HH:mm:ss zzz", $Inv) + " (" + [TimeZoneInfo]::Local.Id + ")")
  Add-Line ("utc time:   " + $now.ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss", $Inv))
} catch { Add-Line "header failed: $($_.Exception.Message)" }

Section "HOST" {
  $os = Get-CimInstance Win32_OperatingSystem
  Add-Line "os: $($os.Caption) $($os.Version) $($os.OSArchitecture)"
  Add-Line "computer: $env:COMPUTERNAME  user: $env:USERNAME  cpus: $([Environment]::ProcessorCount)"
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
  try {
    $ErrorActionPreference = "Continue"   # w32tm writes errors to stderr; keep them as text
    $out = @(& w32tm /query /status 2>&1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    Add-Line "w32tm /query /status (exit code $LASTEXITCODE):"
    foreach ($l in ($out | Select-Object -First 14)) { Add-Line "  $l" }
  } catch { Add-Line "w32tm not available: $($_.Exception.Message)" }
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
        $c = New-Object Net.Sockets.TcpClient -ArgumentList $a.AddressFamily
        $ep = $(if ($a.AddressFamily -eq "InterNetworkV6") { "[$a]" } else { "$a" }) + ":$port"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        try {
          $ar = $c.BeginConnect($a, $port, $null, $null)
          if ($ar.AsyncWaitHandle.WaitOne(3000, $false)) {
            $c.EndConnect($ar)
            Add-Line "  tcp ${ep} OK in $($sw.ElapsedMilliseconds) ms"
          } else {
            Add-Line "  tcp ${ep} FAILED in $($sw.ElapsedMilliseconds) ms: timeout (no answer within 3000 ms)"
          }
        } catch {
          Add-Line "  tcp ${ep} FAILED in $($sw.ElapsedMilliseconds) ms: $(Format-Err $_)"
        } finally { $c.Close() }
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
    $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    Add-Line ("{0}: {1}" -f $name, $(if ($c) { $c.Source } else { "not found" }))
  }
}

$Utf8 = New-Object Text.UTF8Encoding $false
$body = $Lines -join "`n"
$sha = [Security.Cryptography.SHA256]::Create()
$sum = ([BitConverter]::ToString($sha.ComputeHash($Utf8.GetBytes($body))) -replace "-", "").ToLower().Substring(0, 12)
$text = $body + "`n" + "END OF DIAGNOSTICS $sum" + "`n"
Write-Host $text

try {
  $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $file = Join-Path $dir ("dcdash-diag-" + (Get-Date).ToString("yyyyMMdd-HHmmss", $Inv) + ".txt")
  [IO.File]::WriteAllText($file, $text, $Utf8)   # never Out-File or >: they write UTF-16 on PowerShell 5.1
  Write-Host "saved: $file"
} catch {
  [Console]::Error.WriteLine("could not save the report: $($_.Exception.Message)")
  exit 1
}
exit 0
