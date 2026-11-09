<#
  The Windows evidence lane's step after the readings that need Defender (the 0.6.0 plan's Part 6, unit U7), and the
  Defender canary's: Defender put back as GitHub's Windows images leave it, real-time monitoring off and C:\ and D:\
  excluded (actions/runner-images, images/windows/scripts/build/Configure-WindowsDefender.ps1), after
  tools/defender-on.ps1 turned the monitoring back on for those readings.

    powershell -File tools\defender-off.ps1 -Record <defender-on's defender.json> -Out <defender-off.json>

  Why it exists. Seen in CI run 110: its four jobs that ran tools/defender-on.ps1 (the life cycle, the lane, and two
  canaries that did no AGMessage work; three of the four with the runner's own processes and folder excluded again, one
  canary with them scanned) went silent within a second or two of 15:00:28, Defender's real-time protection having come
  on at 14:50:13 to 14:50:27, and the hosted service failed them at 15:45:57 to about 15:47, about 45 minutes after their
  last report. Only the two canaries kept evidence: uploaded at 15:00:27, it shows healthy machines up to their last
  heartbeat at 15:00:12 (Defender's CPU low, 13 GB free, the runner listener's connections established, no detection or
  scan in Defender's log). Seen in run 109: a job left as the image made it lived its hour beside three that were lost;
  and run 101's lane, which ended about 8 minutes after turning Defender on, was not lost. Derived, not seen: in runs 105
  and 109 every job that ran tools/defender-on.ps1 was lost some 10 to 11 minutes after Defender came on, from when the
  service failed them less the 45 minutes it was reported to wait. Tried and lost: nothing excluded (runs 105 and 109,
  run 110's scanned canary) and only the runner's own excluded (run 110). Never tried: the monitoring on with the image's
  C:\ and D:\ exclusions kept (the monitoring-only canary asks it). Not known: how Defender's coming on ends a hosted
  runner, which cannot be seen from inside the machine. So the lane has the monitoring on only for the readings that need
  it and this puts it back right after them: about 3.5 minutes at run 109's times (not measured with this order), though
  a slow reading or a slow take can keep it on past ten minutes. Whether that keeps the runner is the next runs' to say.

  What it does, each act on its own and recorded as it goes: real-time monitoring off, first; the runner's own processes
  and folder tools/defender-on.ps1 excluded removed from the exclusions (its record's runner.paths and runner.processes);
  then every exclusion it removed added back (its record's removed paths, processes and extensions; C:\ and D:\ when its
  record cannot be read); then Defender read back as tools/defender-on.ps1 reads it, for up to 30 s, the monitoring asked
  off again at each read that still says it is on (a refusal of that recorded once). Off means real-time monitoring off
  and C:\ and D:\ excluded again, as the image leaves them. It never fails the job for Defender: what did not take is
  written down ("off": false, with why). It fails only when it cannot write its record.
#>
param([Parameter(Mandatory = $true)][string]$Record, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# As tools/defender-on.ps1 reads it.
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
# A list as ConvertTo-Json may have written it (an array, one value, or an array wrapped as {value, Count}), as text.
function Get-List($v) {
  if ($null -eq $v) { return @() }
  if ($v -is [System.Management.Automation.PSCustomObject] -and $v.PSObject.Properties['value']) { $v = $v.value }
  return @(@($v) | Where-Object { $_ } | ForEach-Object { [string]$_ })
}
# Whether `$list` names the drive `$drive` (C:\ or D:\), with or without its backslash, in any case.
function Test-Names($list, [string]$drive) {
  foreach ($x in @($list)) { if ($x -and ([string]$x).TrimEnd('\') -ieq $drive.TrimEnd('\')) { return $true } }
  return $false
}
# Off as the image leaves it: real-time monitoring off, and C:\ and D:\ excluded.
function Test-Off($d) {
  if (-not $d -or $d.realtime) { return $false }
  return (Test-Names $d.exclusions 'C:\') -and (Test-Names $d.exclusions 'D:\')
}

# $Record and $Out are the parameters; PowerShell's names know no case, so what this writes is $result.
$result = [ordered]@{ v = 1; at = (Get-Date).ToUniversalTime().ToString('o'); record = $null; after = $null; off = $false; errors = @()
  unexcluded = [ordered]@{ paths = @(); processes = @() }
  restored = [ordered]@{ paths = @(); processes = @(); extensions = @() } }

# The act this step is for, before anything that could fail.
try { Set-MpPreference -DisableRealtimeMonitoring $true } catch { $result.errors += ('real-time monitoring: ' + $_.Exception.Message) }

# What tools/defender-on.ps1 recorded: what it removed, and what it excluded for the runner.
$on = $null
try { $on = Get-Content -LiteralPath $Record -Raw | ConvertFrom-Json } catch { $result.errors += ('the record of tools/defender-on.ps1: ' + $_.Exception.Message) }
$result.record = $on
$removed = [ordered]@{ paths = @('C:\', 'D:\'); processes = @(); extensions = @() }
$own = [ordered]@{ paths = @(); processes = @() }
if ($on -and $on.removed) {
  $removed = [ordered]@{ paths = @(Get-List $on.removed.paths); processes = @(Get-List $on.removed.processes); extensions = @(Get-List $on.removed.extensions) }
  if ($on.runner) { $own = [ordered]@{ paths = @(Get-List $on.runner.paths); processes = @(Get-List $on.runner.processes) } }
} elseif ($on) { $result.errors += 'the record of tools/defender-on.ps1 names nothing it removed: C:\ and D:\ put back' }

# The runner's own first, then the image's: a path in both stays excluded, as the image had it.
foreach ($p in $own.paths) {
  try { Remove-MpPreference -ExclusionPath $p; $result.unexcluded.paths += $p } catch { $result.errors += ('the runner''s folder ' + $p + ': ' + $_.Exception.Message) }
}
foreach ($e in $own.processes) {
  try { Remove-MpPreference -ExclusionProcess $e; $result.unexcluded.processes += $e } catch { $result.errors += ('the runner''s process ' + $e + ': ' + $_.Exception.Message) }
}
foreach ($x in $removed.paths) {
  try { Add-MpPreference -ExclusionPath $x; $result.restored.paths += $x } catch { $result.errors += ('exclusion ' + $x + ': ' + $_.Exception.Message) }
}
foreach ($x in $removed.processes) {
  try { Add-MpPreference -ExclusionProcess $x; $result.restored.processes += $x } catch { $result.errors += ('process exclusion ' + $x + ': ' + $_.Exception.Message) }
}
foreach ($x in $removed.extensions) {
  try { Add-MpPreference -ExclusionExtension $x; $result.restored.extensions += $x } catch { $result.errors += ('extension exclusion ' + $x + ': ' + $_.Exception.Message) }
}

# Defender takes a moment to say its monitoring is off: read it back for up to 30 s. While a read says the real-time
# monitoring is still on, it is asked off again, each time on its own; a read that fails and a refusal of the ask are each
# recorded once, not at every pass.
$deadline = (Get-Date).AddSeconds(30)
$againSaid = $false
$readSaid = $false
do {
  try { $result.after = Read-Defender } catch {
    $result.after = $null
    if (-not $readSaid) { $result.errors += ('read after: ' + $_.Exception.Message) }
    $readSaid = $true
  }
  if (Test-Off $result.after) { break }
  if ($result.after -and $result.after.realtime) {
    try { Set-MpPreference -DisableRealtimeMonitoring $true } catch {
      if (-not $againSaid) { $result.errors += ('real-time monitoring, asked again: ' + $_.Exception.Message) }
      $againSaid = $true
    }
  }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
$result.off = [bool](Test-Off $result.after)

$dir = Split-Path -Parent $Out
if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out -Encoding utf8
$back = 'put back: ' + ((@($result.restored.paths) + @($result.restored.processes) + @($result.restored.extensions)) -join ', ') + '; no longer excluded: ' + ((@($result.unexcluded.paths) + @($result.unexcluded.processes)) -join ', ')
if ($result.off) { Write-Host ('Defender: as the image left it, real-time monitoring off, C:\ and D:\ excluded (' + $back + ')') }
else { Write-Host ('Defender: not back as the image left it (' + $back + '; ' + ($result.errors -join '; ') + ')') }
exit 0
