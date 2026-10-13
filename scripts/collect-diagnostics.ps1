# Host facts for field debugging when the web app itself is down: one text file to copy and paste to whoever helps.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-diagnostics.ps1 [host:port ...] [-OutDir DIR] [-ProjectDir DIR] [-RawLogs] [-Mask]
# Prints the report and saves dcdash-diag-<yyyyMMdd-HHmmss>.txt in -OutDir (default: the logs folder inside the project folder, else
# inside the current folder; created if missing). Each host:port gets a DNS lookup and a TCP connect (3 s timeout).
# Sections: HOST DISKS NETWORK CLOCK TARGETS LOCAL PORTS TOOLS ON PATH SERVICES DOCKER CLOCK DATABASE API LOGS.
# -ProjectDir is the folder with compose.yaml and .env (default: the current folder, else the script's parent folder, if one of them has
# a compose.yaml). With docker and a compose.yaml it reads container status, the database and the service logs, and ALSO saves
# dcdash-diag-<same time>-logs.txt (the last 300 kept lines per service; saved, never printed). Without them those sections say so.
# DOCKER CLOCK compares the clock inside the db container with this computer's (a Docker/WSL2 VM that slept drifts; that is not the SCADA).
# Per service the last 2000 log lines are read and the ROUTINE ones are dropped (2xx/3xx uvicorn access lines, Caddy admin API requests,
# TimescaleDB refresh and checkpoint chatter; a line with error, warn, fatal, traceback, exception or panic is never dropped), the count
# of dropped lines is printed, then the last 300 (file) / 30 (screen) remain. -RawLogs keeps every line. Colour codes are removed from the log
# text first; a block whose last 300 kept lines hold the Timescale image's first-start noise gets one "known benign" line.
# -Mask replaces addresses, host names (this computer, the targets, the domain, the DNS and gateway hosts, the time source, a host seen in a URL),
# the user name and the project and output folders by HOST-n, USER-1 and PATH-n in the files AND on the screen; loopback addresses (127.x,
# ::1, 0.0.0.0), localhost and the compose service names (db, api, web, collector, simulator) stay as they are. The legend (alias = original) is printed on the screen after the "saved:" lines and never written
# to a file. Hosts the script cannot know (in a log line that is no URL and no address) stay: read before pasting.
# Every line is cut at 64 KB, scrubbed (URL credentials "://user:pass@" and the secret values of the project's .env become [hidden]) and
# clipped; the report only says HOW MANY .env values it hides. Every external command has a time limit, so a hung docker cannot hang this.
# Read-only, needs no internet and none of the application. PowerShell 5.1 compatible.
# Files are UTF-8 without BOM with LF line breaks. The last line is `END OF DIAGNOSTICS <12 hex>`: the first 12 hex characters of the
# SHA-256 of every line before it, joined by LF (UTF-8 bytes, no trailing LF), so a paste can be verified.
# Other modes (they exit before any collection): -ScrubSelfTest <scrub_cases.tsv> checks the scrubber against the shared fixture
# (backend\tests\fixtures\scrub_cases.tsv) and exits 0 only when every case passes; -ScrubFile <file> [-EnvFile <.env>] [-Mask] prints that file
# scrubbed (and masked) with the same rules (default .env: the project's), to check a text before pasting it: the screen IS the output there,
# so no legend is printed (stderr says so). -DockerPath <docker.exe> overrides the docker found on the PATH.
# Exit codes: 0 report written, 1 a file could not be saved (the report was still printed).
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)][string[]]$Targets,
  [string]$OutDir,   # empty: <project folder>\logs, resolved once the project folder is known
  [string]$ProjectDir,
  [string]$ScrubSelfTest,
  [string]$ScrubFile,
  [string]$EnvFile,
  [string]$DockerPath,
  [switch]$RawLogs,   # keep the routine log lines too
  [switch]$Mask,   # HOST-n, USER-1, PATH-n instead of addresses, host names, the user name and folders
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
$KeepAlways = 'error|warn|fatal|traceback|exception|panic'   # a log line with one of these words is never routine
$RoutinePg = '^\S+ \S+ \S+ \[\d+\] LOG:\s+(continuous aggregate refresh|deleted \d+ row\(s\) from materialization table|inserted \d+ row\(s\) into materialization table|checkpoint (starting|complete):)'
$BootNoise = 'no usable system locales were found|background worker.*trying to connect to template database, exiting'   # the Timescale image's first start
$BootNote = 'known benign on a first start (Timescale image): "no usable system locales were found", "background worker ... trying to connect to template database, exiting"'
$TailLines = 2000   # docker compose logs --tail: read this many, drop the routine ones, keep the last 300
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
# ---- masking (-Mask): the idea of redact.Masker. Names this machine and this run know are registered up front; addresses and URL hosts are aliased where they appear ----
$MaskOn = $Mask.IsPresent
$MaskCount = @{ HOST = 0; USER = 0; PATH = 0 }
$MaskByKey = @{}   # kind + normalised value -> alias
$MaskKnown = @{}   # a registered text in lower case -> alias
$MaskSeen = @{}   # a text aliased on sight -> its alias (the same address comes back thousands of times in a log)
$MaskLegend = [ordered]@{}   # alias -> the first spelling seen
$MaskUsed = New-Object 'System.Collections.Generic.HashSet[string]'   # the aliases that reached a line: only those go into the legend
$MaskEntries = New-Object 'System.Collections.Generic.List[object]'   # the alternatives of the one regex, rebuilt after a name was added
$MaskRx = $null
$RxOpts = [Text.RegularExpressions.RegexOptions]"IgnoreCase, CultureInvariant"
$RxAlias = New-Object Text.RegularExpressions.Regex('^(HOST|USER|PATH)-[0-9]+$', $RxOpts)
$RxV4Whole = New-Object Text.RegularExpressions.Regex('^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$', $RxOpts)
$RxV4 = New-Object Text.RegularExpressions.Regex('(?<![0-9.])([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(?![0-9]|\.[0-9])', $RxOpts)
$RxUrl = New-Object Text.RegularExpressions.Regex('(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*://)((?:[^\s/@?#]*@)?)(\[[^\]\s]*\]|[\w.~%-]+)', $RxOpts)
$RxV6Bracket = New-Object Text.RegularExpressions.Regex('\[([0-9A-Fa-f:.]{2,64}(?:%[A-Za-z0-9_.-]{1,20})?)\]', $RxOpts)
# a bare IPv6 address: a run of hex digits, colons and dots, not glued to a word, ":" "." ";" "%" "/" "[" "-" before it; the "s=" of an OPC UA node id (ns=6;s=::Var) is a name
$RxV6Run = New-Object Text.RegularExpressions.Regex('(?<![\w:.;%/\[-])(?<!(?:^|[\s"''(,{;])(?:ns|[isgb])=)[0-9A-Fa-f:.]{3,64}(?:%[A-Za-z0-9_.-]{1,20})?(?![\w:])', $RxOpts)
function ConvertTo-IPv4([string[]]$Octets) {   # "a.b.c.d" without leading zeros, or $null when an octet is above 255
  $n = @()
  foreach ($o in $Octets) { $v = [int]$o; if ($v -gt 255) { return $null }; $n += $v }
  return $n -join "."
}
function Test-IPv6([string]$S, [bool]$Bracketed = $false) {   # outside brackets only a form with "::" or eight groups counts: a time or a thumbprint is no address
  $a = $S.Split([char]37)[0]   # without the %scope
  $ip = $null
  if ($a.IndexOf([char]58) -lt 0 -or -not [Net.IPAddress]::TryParse($a, [ref]$ip) -or $ip.AddressFamily -ne "InterNetworkV6") { return $false }
  if ($Bracketed) { return $true }
  $colons = $a.Length - $a.Replace(":", "").Length
  return ($a.Contains("::") -or $colons -eq 7 -or ($colons -eq 6 -and $a.Contains("."))) -and @($a.Split([char]58) | Where-Object { $_ }).Count -ge 2
}
function Test-Loopback([string]$V) {   # 127.0.0.0/8, ::1, 0.0.0.0, ::, localhost and the compose service names say nothing about the site: never masked
  $b = $V.Trim().Trim([char[]]"[]")
  if ($b -ieq "localhost" -or @("db", "api", "web", "collector", "simulator") -contains $b.ToLowerInvariant()) { return $true }   # a masked "== HOST-3 ==" would not say WHICH container failed
  $m = $RxV4Whole.Match($b)
  if ($m.Success) { $n = ConvertTo-IPv4 @($m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value, $m.Groups[4].Value); return [bool]($n -and ($n.StartsWith("127.") -or $n -eq "0.0.0.0")) }
  if (-not (Test-IPv6 $b $true)) { return $false }
  $ip = $null; [void][Net.IPAddress]::TryParse($b.Split([char]37)[0], [ref]$ip)
  return $ip.Equals([Net.IPAddress]::IPv6Loopback) -or $ip.Equals([Net.IPAddress]::IPv6Any)
}
function Get-MaskKey([string]$V) {   # what makes two spellings one name: IPv4 without leading zeros, IPv6 compressed, the rest in lower case without a final dot
  $V = $V.Trim()
  $m = $RxV4Whole.Match($V)
  if ($m.Success) { $n = ConvertTo-IPv4 @($m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value, $m.Groups[4].Value); if ($n) { return $n } }
  $b = $V.Trim([char[]]"[]")
  if (Test-IPv6 $b $true) { $ip = $null; [void][Net.IPAddress]::TryParse($b.Split([char]37)[0], [ref]$ip); return $ip.ToString() }
  return $V.ToLowerInvariant().TrimEnd(".")
}
function Get-MaskAlias([string]$Value, [string]$Kind) {   # Kind HOST, USER or PATH; numbered in order of birth, so a run gives the same aliases as the one before
  $key = $Kind + ":" + (Get-MaskKey $Value)
  $a = $script:MaskByKey[$key]
  if (-not $a) {
    $script:MaskCount[$Kind] = $script:MaskCount[$Kind] + 1
    $a = "$Kind-$($script:MaskCount[$Kind])"
    $script:MaskByKey[$key] = $a; $script:MaskLegend[$a] = $Value
  }
  return $a
}
function Use-Mask([string]$Value) {
  $a = $script:MaskSeen[$Value]
  if (-not $a) { $a = Get-MaskAlias $Value "HOST"; $script:MaskSeen[$Value] = $a }
  [void]$script:MaskUsed.Add($a); return $a
}
function Add-MaskName([string]$Name, [string]$Kind) {   # Kind: host (also covers the labels after it), domain (and the labels before it), user or path
  if (-not $Name) { return }
  $Name = $Name.Trim(); $low = $Name.ToLowerInvariant()
  # too short (2 is enough for a user name: whole words only), an alias, loopback, known already, or a one-label domain (local, lan: ordinary words in a report) is not registered
  if ($Name.Length -lt $(if ($Kind -eq "user") { 2 } else { 3 }) -or $RxAlias.IsMatch($Name) -or (Test-Loopback $Name) -or $script:MaskKnown.ContainsKey($low) -or ($Kind -eq "domain" -and -not $Name.Contains("."))) { return }
  $esc = [regex]::Escape($Name)
  $pat = switch ($Kind) {   # every alternative carries its own boundaries: whole words only
    "domain" { '(?<![\w.-])(?:[A-Za-z0-9_-]+\.)*' + $esc + '(?![\w-])' }
    "host" {
      if ($RxV4Whole.IsMatch($Name)) { '(?<![\w.-])' + $esc + '(?![\w-]|\.[0-9])' }
      elseif (Test-IPv6 $Name $true) { '(?<![\w:.;%/\[-])' + $esc + '(?:%[A-Za-z0-9_.-]{1,20})?(?![\w:])' }
      else { '(?<![\w.-])' + $esc + '(?:\.[A-Za-z0-9-]+)*(?![\w-])' }
    }
    default { '(?<![\w.-])' + $esc + '(?![\w-])' }
  }
  $script:MaskKnown[$low] = Get-MaskAlias $Name $(if ($Kind -eq "user") { "USER" } elseif ($Kind -eq "path") { "PATH" } else { "HOST" })
  $script:MaskEntries.Add([pscustomobject]@{ Len = $Name.Length; Pat = $pat })
  $script:MaskRx = $null
}
$RxRefId = New-Object Text.RegularExpressions.Regex('^(\s*Reference\s*Id\s*:\s*)0x([0-9A-F]{8})(?=\s*\(\w+ IP:)', $RxOpts)   # w32tm /query /status
$RxClockSource = New-Object Text.RegularExpressions.Regex('^\s*Source\s*:\s*([^\s,/@]+)(?:,0x[0-9A-F]+)?\s*$', $RxOpts)   # a source with spaces (Local CMOS Clock) is no host
$MaskEvalRefId = [Text.RegularExpressions.MatchEvaluator]{ param($m)   # the refid IS the source's IPv4 address as 0xAABBCCDD: the same alias as the address printed after it
  $x = $m.Groups[2].Value
  $ip = (0, 2, 4, 6 | ForEach-Object { [Convert]::ToInt32($x.Substring($_, 2), 16) }) -join "."
  if (Test-Loopback $ip) { return $m.Value }
  return $m.Groups[1].Value + (Use-Mask $ip)
}
$MaskEvalName = [Text.RegularExpressions.MatchEvaluator]{ param($m)   # a registered name, or one with more labels around it: that whole name gets an alias of its own
  $f = $m.Value; $a = $script:MaskKnown[$f.ToLowerInvariant()]
  if (-not $a) { $a = Get-MaskAlias $f "HOST" }
  [void]$script:MaskUsed.Add($a); return $a
}
$MaskEvalUrl = [Text.RegularExpressions.MatchEvaluator]{ param($m)   # scheme://[user@]host: nothing before the "@" survives, the host becomes an alias
  $pre = $m.Groups[1].Value + $(if ($m.Groups[2].Value) { "[hidden]@" } else { "" })
  $h = $m.Groups[3].Value
  if ($h.StartsWith("[")) { $inner = $h.Substring(1, $h.Length - 2); if ((Test-IPv6 $inner $true) -and -not (Test-Loopback $inner)) { return $pre + (Use-Mask $inner) }; return $pre + $h }
  $n = $h.TrimEnd(".")
  if (-not $n -or $RxAlias.IsMatch($n) -or (Test-Loopback $n)) { return $pre + $h }
  $r = $pre + (Use-Mask $n) + $h.Substring($n.Length)
  if (-not $RxV4Whole.IsMatch($n)) { Add-MaskName $n "host" }   # a name from now on: a bare mention of it later (or later on this line) is masked too
  return $r
}
$MaskEvalBracket = [Text.RegularExpressions.MatchEvaluator]{ param($m) $v = $m.Groups[1].Value; if ((Test-IPv6 $v $true) -and -not (Test-Loopback $v)) { return (Use-Mask $v) }; return $m.Value }
$MaskEvalV6 = [Text.RegularExpressions.MatchEvaluator]{ param($m)
  $run = $m.Value; $t = $run.TrimEnd(".")   # a sentence may end right after an address
  foreach ($c in $(if ($run.Contains("%")) { @($run) } else { @($run, $t, $t.TrimEnd(":")) })) { if ($c -and (Test-IPv6 $c)) { if (Test-Loopback $c) { return $run }; return (Use-Mask $c) + $run.Substring($c.Length) } }
  return $run
}
$MaskEvalV4 = [Text.RegularExpressions.MatchEvaluator]{ param($m)
  if (Test-Loopback $m.Value) { return $m.Value }
  if ($script:MaskSeen.ContainsKey($m.Value) -or (ConvertTo-IPv4 @($m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value, $m.Groups[4].Value))) { return (Use-Mask $m.Value) }
  return $m.Value
}
function Get-NameMasked([string]$Text) {
  if ($script:MaskEntries.Count -gt 0 -and -not $script:MaskRx) {   # one compiled alternation, longest name first
    $pats = @($script:MaskEntries | Sort-Object Len -Descending | ForEach-Object { $_.Pat })
    $script:MaskRx = New-Object Text.RegularExpressions.Regex(($pats -join "|"), ([Text.RegularExpressions.RegexOptions]"IgnoreCase, CultureInvariant, Compiled"))
  }
  if ($script:MaskRx) { return $script:MaskRx.Replace($Text, $MaskEvalName) }
  return $Text
}
function Get-Masked([string]$Text) {
  $Text = $RxRefId.Replace($Text, $MaskEvalRefId)
  $src = $RxClockSource.Match($Text)
  if ($src.Success) { Add-MaskName $src.Groups[1].Value "host" }   # the NTP source named by w32tm, whatever its domain
  $Text = Get-NameMasked $Text
  $Text = $RxUrl.Replace($Text, $MaskEvalUrl)
  if (-not $script:MaskRx) { $Text = Get-NameMasked $Text }   # the URL pass registered a host: its bare mentions on this line too
  $Text = $RxV6Bracket.Replace($Text, $MaskEvalBracket)
  $Text = $RxV6Run.Replace($Text, $MaskEvalV6)
  return $RxV4.Replace($Text, $MaskEvalV4)
}
function Write-MaskLegend {   # screen only: it holds every original
  if (-not $MaskOn) { return }
  Write-Host "MASK LEGEND (screen only; do not paste)"
  foreach ($a in @($MaskLegend.Keys | Where-Object { $MaskUsed.Contains($_) } | Sort-Object { $_.Split("-")[0] }, { [int]$_.Split("-")[1] })) { Write-Host "$a = $($MaskLegend[$a])" }
}

function Initialize-Mask {   # before any output, in a fixed order, so the numbers repeat from run to run
  Add-MaskName $env:COMPUTERNAME "host"; Add-MaskName $env:USERNAME "user"; Add-MaskName $env:USERDOMAIN "host"; Add-MaskName $env:USERDNSDOMAIN "domain"
  try { Add-MaskName ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().DomainName) "domain" } catch { }
  try { Add-MaskName ([Net.Dns]::GetHostName()) "host" } catch { }   # COMPUTERNAME is cut at 15 characters
  try { Add-MaskName (Split-Path $env:USERPROFILE -Leaf) "user" } catch { }   # often user.DOMAIN
  Add-MaskName $Root "path"; Add-MaskName $OutFull "path"
  try {
    foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($n.NetworkInterfaceType -eq "Loopback" -or $n.OperationalStatus -ne "Up") { continue }
      $p = $n.GetIPProperties()
      Add-MaskName $p.DnsSuffix "domain"
      foreach ($u in $p.UnicastAddresses) { Add-MaskName "$($u.Address)" "host" }
      foreach ($g in $p.GatewayAddresses) { Add-MaskName "$($g.Address)" "host" }
      foreach ($d in $p.DnsAddresses) { Add-MaskName "$d" "host" }
    }
  } catch { }
  foreach ($raw in $Targets) {
    foreach ($t in @($raw -split "[,;\s]+" | Where-Object { $_ })) {   # every token that is no bare number: "scada01" and "scada01 4840" (a typed space) leak as well
      $h = $t
      if ($t -match '^\[([^\]]+)\]' -or $t -match '^([^:\[\]]+):[0-9]{1,5}$') { $h = $Matches[1] }
      if ($h -notmatch '^[0-9]+$') { Add-MaskName $h "host" }
    }
  }
}
function Format-Line([string]$Raw, [int]$Clip, [int]$Cap = 65536) {   # cap the raw line, THEN scrub, THEN mask, THEN clip (a clipped URL would leak half a password)
  $cut = $Cap -gt 0 -and $Raw.Length -gt $Cap
  if ($cut) { $Raw = $Raw.Substring(0, $Cap) }
  $s = Get-Scrubbed $Raw $Known
  if ($MaskOn) { $s = Get-Masked $s }
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
$OutBase = $(if ($OutDir) { $OutDir } elseif ($Root -and (Test-Path -LiteralPath $Root -PathType Container)) { Join-Path $Root "logs" } else { Join-Path (Get-Location).Path "logs" })   # a mistyped -ProjectDir must not create the typo folder
$OutFull = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutBase)
if ($MaskOn) { Initialize-Mask }
if ($ScrubFile) {
  try { foreach ($l in [IO.File]::ReadAllLines($ScrubFile, [Text.Encoding]::UTF8)) { Write-Host (Format-Line $l 0 0) } }
  catch { [Console]::Error.WriteLine("cannot read ${ScrubFile}: $($_.Exception.Message)"); Stop-Script 1 }
  if ($MaskOn) { [Console]::Error.WriteLine("masking is ON; the legend (alias = original) is not shown in this mode") }
  Stop-Script 0
}
$Docker = $null
if ($DockerPath) { if (Test-Path -LiteralPath $DockerPath -PathType Leaf) { $Docker = $DockerPath } }
else { $c = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $Docker = $c.Source } }
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
function Remove-Ansi([string]$Line) {   # colour codes: ESC [ 37;1 m, and the same without the ESC byte when it was lost on the way; it needs a digit, so [5m] and cfg[mode] in running text are no code
  return $Line -creplace '\x1b\[[0-9;]*m', '' -creplace '\[[0-9]{1,3}(?:;[0-9]{1,3})*m(?!\])', ''
}
function Test-Routine([string]$Line) {   # a log line nobody needs to read (Decision 1 of the W8c plan); anything that could be a failure is kept
  if ($Line -match $KeepAlways) { return $false }
  $t = $Line -replace '^[A-Za-z0-9][A-Za-z0-9_.-]*\s*\|\s?', ''   # the "api-1  | " docker compose puts in front of every line
  if ($t -match '^\s*INFO:\s+\S+ - "[A-Z]+ \S+ HTTP/\d(\.\d)?" [23]\d\d\b') { return $true }   # a uvicorn access line that went well
  if ($t.Contains('"logger":"admin.api"') -and $t.Contains('"msg":"received request"')) { return $true }   # Caddy: the healthcheck asking its admin API
  return [bool]($t -match $RoutinePg)
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
  Add-Line $(if ($RawLogs) { "service logs: the last $TailLines lines per service, unfiltered (-RawLogs), then the last 300" } else { "service logs: the last $TailLines lines per service; routine lines are dropped (see -RawLogs), then the last 300 kept" }) -To $LogLines
  if ($MaskOn) {
    $note = "masking: ON (addresses, host names, user and folder names appear as HOST-n, USER-1, PATH-n)"
    Add-Line $note; Add-Line $note -To $LogLines
  }
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
  # Every address comes from .NET (CIM lists a dual-stack socket once, as ::). CIM only says which process id owns "address|port", and it runs as a
  # job so that a stuck WMI cannot stall the report. Names, never command lines, paths or users.
  $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  $FixedPorts = 80, 443, 8000   # the ports this product cares about get a line each; the others go into the block below
  $owners = @{}; $portOwner = @{}; $names = @{}; $job = $null; $why = $null
  try {
    $job = Get-NetTCPConnection -State Listen -AsJob
    if (Wait-Job $job -Timeout 5) {
      foreach ($c in @(Receive-Job $job -ErrorAction Stop)) {
        $n = [int]$c.LocalPort; $o = [int]$c.OwningProcess   # ints on both sides: a hashtable key of another type does not match
        $owners["$($c.LocalAddress)|$n"] = $o
        if (-not $portOwner.ContainsKey($n)) { $portOwner[$n] = $o } elseif ($portOwner[$n] -ne $o) { $portOwner[$n] = -1 }   # -1: more than one process on this port
      }
    } else { Stop-Job $job; $why = "the lookup did not answer in 5 s" }
  } catch { $why = "the lookup was refused" } finally { if ($job) { Remove-Job $job -Force -ErrorAction SilentlyContinue } }
  if (-not $why) { $why = "the lookup did not list it" }   # only read for a listener the lookup did not list
  if ($owners.Count -gt 0) { try { foreach ($p in Get-Process) { $names[[int]$p.Id] = $p.ProcessName } } catch { } }
  $rows = @{}   # "port|owner" -> one row per owner process (-1: unknown), the addresses it listens on
  foreach ($l in $listeners) {
    $port = [int]$l.Port; $addr = "$($l.Address)"
    $o = $owners["$addr|$port"]
    if ($null -eq $o) { $o = $owners["::|$port"] }
    if ($null -eq $o -and $portOwner.ContainsKey($port) -and $portOwner[$port] -ge 0) { $o = $portOwner[$port] }
    if ($null -eq $o) { $o = -1 }
    if (-not $rows.ContainsKey("$port|$o")) { $rows["$port|$o"] = [pscustomobject]@{ Port = $port; Owner = $o; Addrs = (New-Object 'System.Collections.Generic.List[string]') } }
    if (-not $rows["$port|$o"].Addrs.Contains($addr)) { $rows["$port|$o"].Addrs.Add($addr) }
  }
  foreach ($r in $rows.Values) { $r.Addrs.Sort([StringComparer]::Ordinal) }
  $name = { param($r) $(if ($names.ContainsKey($r.Owner)) { $names[$r.Owner] } else { "unknown" }) }
  foreach ($port in $FixedPorts) {
    $mine = @($rows.Values | Where-Object { $_.Port -eq $port } | Sort-Object @{ Expression = { $_.Owner -lt 0 } }, Owner)
    if ($mine.Count -eq 0) { Add-Line "port ${port}: nothing is listening"; continue }
    $on = @($listeners | Where-Object { $_.Port -eq $port } | ForEach-Object { "$($_.Address)" })
    $who = @($mine | ForEach-Object { if ($_.Owner -ge 0) { "$(& $name $_), pid $($_.Owner)" } else { "owner hidden: $why" } })
    Add-Line ("port ${port}: something is listening on " + ($on -join ", ") + " (" + $(if ($mine[0].Owner -ge 0) { "owner: " }) + ($who -join "; ") + ")")
  }
  $other = @($rows.Values | Where-Object { $FixedPorts -notcontains $_.Port } | Sort-Object Port, @{ Expression = { $_.Owner -lt 0 } }, Owner)
  if ($other.Count -eq 0) { Add-Line "other listening ports: none"; return }
  Add-Line "other listening ports (up to 40):"
  foreach ($r in @($other | Select-Object -First 40)) {
    Add-Line ("  {0}  {1}  {2}" -f $r.Port, ($r.Addrs -join ", "), $(if ($r.Owner -ge 0) { "$(& $name $r) (pid $($r.Owner))" } else { "owner hidden ($why)" }))
  }
  if ($other.Count -gt 40) { Add-Line "  ... and $($other.Count - 40) more" }
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

Section "DOCKER CLOCK" {   # after SERVICES (it needs to know there are containers); the app report cannot see the host clock
  if (-not $script:Containers) { Add-Line "skipped (no containers)"; return }
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $r = Invoke-Docker @("compose", "exec", "-T", "db", "date", "-u", "+%s") $CommandTimeoutSeconds
  $t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (-not $r) { return }
  $answer = $r.Out.Trim()
  if ($r.ExitCode -ne 0 -or $answer -notmatch '^\d{9,11}$') {
    $first = @(Get-TextLines ($r.Err + "`n" + $r.Out) | Where-Object { $_.Trim() } | Select-Object -First 1)
    Add-Line "could not read the Docker VM clock (exit code $($r.ExitCode)): $(if ($first.Count -gt 0) { $first[0].Trim() })" -Clip 300
    return
  }
  $drift = [int][math]::Round([int64]$answer - ($t0 + $t1) / 2000.0)   # the VM answered somewhere between the two readings: take the middle
  $line = "docker VM minus host = $(if ($drift -lt 0) { '-' } else { '+' })$([math]::Abs($drift)) s (host utc $([DateTimeOffset]::FromUnixTimeMilliseconds($t0).ToString('HH:mm:ss', $Inv)), the docker call took $($t1 - $t0) ms)"
  if ([math]::Abs($drift) -gt 30) { $line += ": Docker/WSL2 clock drift (typical after the host slept), a local cause, not the SCADA" }
  Add-Line $line
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
    $r = Invoke-Docker @("compose", "logs", "--no-color", "--tail", "$TailLines", $svc) ($CommandTimeoutSeconds * 3)
    if (-not $r) { break }
    $got = @(Get-TextLines $r.Out | ForEach-Object { Remove-Ansi $_ } | Where-Object { $_.Trim() })   # codes off first: the filter and the counts see the plain text
    if ($r.ExitCode -ne 0 -and $got.Count -eq 0) { Add-Line "-- ${svc}: docker compose logs failed (exit code $($r.ExitCode)): $($r.Err.Trim())" -Clip 300; continue }
    $kept = $(if ($RawLogs) { $got } else { @(foreach ($l in $got) { if (-not (Test-Routine $l)) { $l } }) })
    $tail = @($kept | Select-Object -Last 300)
    $show = @($tail | Select-Object -Last 30)
    $what = $(if ($RawLogs) { "lines read; unfiltered)" } else { "kept lines; dropped $($got.Count - $kept.Count) routine lines of $($got.Count) read)" })
    Add-Line "-- $svc (last $($show.Count) of $($kept.Count) $what$(if ($got.Count -ge $TailLines) { ' (tail limit reached; older lines not read)' })"
    if (@($tail | Where-Object { $_ -match $BootNoise }).Count -gt 0) { Add-Line $BootNote -Prefix "  " }
    foreach ($l in $show) { Add-Line $l -Clip 240 -Prefix "  " }
    Add-Line "== $svc ==" -To $LogLines
    foreach ($l in $tail) { Add-Line $l -Clip 1000 -To $LogLines }
    $script:LogServices++
  }
  Add-Line $(if ($script:LogServices -gt 0) { "logs file (the last 300 kept lines per service, saved next to this report): $LogsFile" } else { "no logs read, no logs file" })
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
  Write-MaskLegend
  Stop-Script 1
}
Write-MaskLegend
Stop-Script 0
