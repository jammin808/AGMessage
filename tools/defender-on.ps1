<#
  The Windows evidence lane's step before the readings that need Defender (the 0.6.0 plan's Part 6, unit U7), and the
  Defender canary's: GitHub's Windows images turn Defender's real-time monitoring off and exclude C:\ and D:\
  (actions/runner-images, images/windows/scripts/build/Configure-WindowsDefender.ps1). This turns the monitoring back on,
  removes every exclusion it finds (of paths, processes and extensions: the image's C:\ and D:\ among them), excludes
  again only the runner's own processes and the folder they run from, and records it all, read back from Defender itself
  (Get-MpComputerStatus, Get-MpPreference), so each reading taken with it on says whether Defender scanned what it
  measured. tools/defender-off.ps1 puts the image's state back from this record right after the readings that need it.
  The image's other settings (archive, download and script scanning, behaviour monitoring, cloud protection) stay as it
  left them: the runner's Defender is narrower than a laptop's, which lab 3 is for.

    powershell -File tools\defender-on.ps1 -Out <defender.json> [-ScanRunner]

  Why the runner's own are excluded again: in CI runs 105 and 109 every runner that ran more than about 10 minutes after
  this turned the monitoring on with the image's exclusions removed was lost (seven jobs, a job that did nothing else
  among them; derived, not seen: some 10 to 11 minutes after, from when the hosted service failed them less the 45
  minutes it was reported to wait), while one left as the image made it kept its runner for its hour (run 109) and run
  101's lane, done about 8 minutes after this, was not lost. Excluding them did not keep the runners of
  run 110 either (seen: silent about ten minutes after this turned the monitoring on, failed about 45 minutes after their
  last report), which is why the lane now puts Defender back right after the readings that need it
  (tools/defender-off.ps1). How is not known. They are found from the running processes (Runner.*), never named here;
  the folder is never a drive root and never one that holds or lies in what the readings measure or AGMessage's own
  folders (`kept`). -ScanRunner leaves them scanned as before: run 110 answered the question it was for (scanned, the
  runner was lost alike) and no job passes it now; it is kept for a question to come.

  On means real-time monitoring and scanning on access on, in Defender's Normal mode, and no exclusion but those this
  made for the runner (tools/readings.js judges the record alike). It never fails the job for Defender: a monitoring
  that does not come on is written down ("took": false, with why), and each reading that needs it says so. It fails only
  when it cannot write its record.
#>
param([Parameter(Mandatory = $true)][string]$Out, [switch]$ScanRunner)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Read-Defender {
  $s = Get-MpComputerStatus
  $p = Get-MpPreference
  return [ordered]@{
    realtime   = [bool]$s.RealTimeProtectionEnabled
    onAccess   = [bool]$s.OnAccessProtectionEnabled
    antivirus  = [bool]$s.AntivirusEnabled
    service    = [bool]$s.AMServiceEnabled
    tamper     = [bool]$s.IsTamperProtected
    mode       = [string]$s.AMRunningMode
    exclusions = @($p.ExclusionPath | Where-Object { $_ })
    processes  = @($p.ExclusionProcess | Where-Object { $_ })
    extensions = @($p.ExclusionExtension | Where-Object { $_ })
  }
}
# Whether `$inner` is `$outer` or inside it, as Windows compares paths (any case, either slash).
function Test-Inside([string]$inner, [string]$outer) {
  $i = $inner.Replace('/', '\').TrimEnd('\') + '\'
  $o = $outer.Replace('/', '\').TrimEnd('\') + '\'
  return $i.StartsWith($o, [System.StringComparison]::OrdinalIgnoreCase)
}

$record = [ordered]@{ v = 1; at = (Get-Date).ToUniversalTime().ToString('o'); before = $null; after = $null; took = $false; errors = @()
  removed = [ordered]@{ paths = @(); processes = @(); extensions = @() }
  runner = [ordered]@{ scanned = [bool]$ScanRunner; processes = @(); paths = @(); kept = @() } }

# What the readings measure and AGMessage's own folders, which the runner's folder may neither hold nor lie in.
$kept = @()
try {
  $kept = @(@($env:GITHUB_WORKSPACE, $env:RUNNER_TEMP, $env:TEMP, $env:TMP, 'C:\agm-readings') +
    @(foreach ($base in @($env:ProgramFiles, $env:ProgramData, $env:LOCALAPPDATA)) { if ($base) { Join-Path $base 'AGMessage' } }) +
    @(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Temp' }) |
    Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') } | Sort-Object -Unique)
} catch { $record.errors += ('the places kept scanned: ' + $_.Exception.Message) }
$record.runner.kept = $kept
# A path the runner's exclusion may name: not a drive root, and neither holding nor inside anything of `kept`.
function Test-Excludable([string]$p) {
  if (-not $p -or $p -match '^[A-Za-z]:\\?$') { return $false }
  foreach ($k in $kept) { if ((Test-Inside $k $p) -or (Test-Inside $p $k)) { return $false } }
  return $true
}
# Whether `$list` names only what `$own` does (any case): the runner's own, and nothing else.
function Test-OnlyOwn($list, $own) {
  foreach ($x in @($list)) { if (-not (@($own) | Where-Object { $_ -ieq $x })) { return $false } }
  return $true
}
# On only as the readings need it: real-time monitoring and scanning on access on, in its Normal mode (in passive or EDR
# block mode it does no real-time scanning), and no exclusion but the runner's own this made.
function Is-On($d) {
  if (-not $d -or -not $d.realtime -or -not $d.onAccess -or $d.mode -ne 'Normal') { return $false }
  if (@($d.extensions).Count) { return $false }
  return (Test-OnlyOwn $d.exclusions $record.runner.paths) -and (Test-OnlyOwn $d.processes $record.runner.processes)
}

try { $record.before = Read-Defender } catch { $record.errors += ('read before: ' + $_.Exception.Message) }
try { Set-MpPreference -DisableRealtimeMonitoring $false } catch { $record.errors += ('real-time monitoring: ' + $_.Exception.Message) }
# Every exclusion there is, each removed on its own and recorded as it goes: the image's C:\ and D:\, and any other.
$found = $record.before
if (-not $found) { $found = [ordered]@{ exclusions = @('C:\', 'D:\'); processes = @(); extensions = @() } }
foreach ($x in @($found.exclusions)) {
  try { Remove-MpPreference -ExclusionPath $x; $record.removed.paths += $x } catch { $record.errors += ('exclusion ' + $x + ': ' + $_.Exception.Message) }
}
foreach ($x in @($found.processes)) {
  try { Remove-MpPreference -ExclusionProcess $x; $record.removed.processes += $x } catch { $record.errors += ('process exclusion ' + $x + ': ' + $_.Exception.Message) }
}
foreach ($x in @($found.extensions)) {
  try { Remove-MpPreference -ExclusionExtension $x; $record.removed.extensions += $x } catch { $record.errors += ('extension exclusion ' + $x + ': ' + $_.Exception.Message) }
}
if (-not $ScanRunner) {
  # The runner's processes (Runner.Listener, Runner.Worker, its plugin host), by their full paths, and the folder they run
  # from: its root (the binaries, its credentials, its diagnostics) where that is excludable, else its binaries' folder
  # and its _diag folder alone. Each added on its own and recorded once Defender took it.
  $exes = @()
  $paths = @()
  try {
    $exes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Runner.*' -and $_.Path } |
      ForEach-Object { $_.Path } | Sort-Object -Unique)
    foreach ($bin in @($exes | ForEach-Object { Split-Path -Parent $_ } | Sort-Object -Unique)) {
      $root = Split-Path -Parent $bin
      if (Test-Excludable $root) { $paths += $root } else { $paths += @($bin, (Join-Path $root '_diag')) }
    }
    $paths = @($paths | Where-Object { (Test-Excludable $_) -and (Test-Path -LiteralPath $_) } | Sort-Object -Unique)
  } catch { $record.errors += ('the runner''s own: ' + $_.Exception.Message) }
  if (-not $exes.Count) { $record.errors += 'the runner''s processes: none found (Runner.*), so none excluded' }
  foreach ($p in $paths) {
    try { Add-MpPreference -ExclusionPath $p; $record.runner.paths += $p } catch { $record.errors += ('the runner''s folder ' + $p + ': ' + $_.Exception.Message) }
  }
  foreach ($e in $exes) {
    try { Add-MpPreference -ExclusionProcess $e; $record.runner.processes += $e } catch { $record.errors += ('the runner''s process ' + $e + ': ' + $_.Exception.Message) }
  }
}
# Defender takes a moment to say it is on: read it back for up to 60 s.
$deadline = (Get-Date).AddSeconds(60)
do {
  try { $record.after = Read-Defender } catch { $record.after = $null; $record.errors += ('read after: ' + $_.Exception.Message) }
  if (Is-On $record.after) { break }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
$record.took = [bool](Is-On $record.after)

$dir = Split-Path -Parent $Out
if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
$record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Out -Encoding utf8
$runnerSaid = if ($ScanRunner) { 'the runner''s own files scanned too' } else { 'the runner''s own excluded (' + (@($record.runner.paths) + @($record.runner.processes) -join ', ') + ')' }
if ($record.took) { Write-Host ('Defender: real-time monitoring on, every exclusion removed, ' + $runnerSaid) }
else { Write-Host ('Defender: did not come on as the readings need it (' + ($record.errors -join '; ') + '): the readings say so') }
exit 0
