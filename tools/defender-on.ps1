<#
  The Windows evidence lane's first step (the 0.6.0 plan's Part 6, unit U7), and the installer's job's first step after it:
  GitHub's Windows images turn Defender's real-time monitoring off and exclude C:\ and D:\
  (actions/runner-images, images/windows/scripts/build/Configure-WindowsDefender.ps1). This turns the monitoring back on,
  removes those two exclusions, and records whether that took, read back from Defender itself (Get-MpComputerStatus,
  Get-MpPreference: real-time monitoring, scanning on access, its mode, the exclusions), so every reading taken after it
  says whether Defender scanned what it measured. The image's other settings (archive, download and script scanning,
  behaviour monitoring, cloud protection) stay as it left them: the runner's Defender is narrower than a laptop's, which
  lab 3 is for.

    powershell -File tools\defender-on.ps1 -Out <defender.json>

  It never fails the job for Defender: a monitoring that does not come on is written down ("took": false, with why), and
  each reading that needs it says so. It fails only when it cannot write its record.
#>
param([Parameter(Mandatory = $true)][string]$Out)
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
  }
}
# On only as the readings need it: real-time monitoring and scanning on access on, in its Normal mode (in passive or EDR
# block mode it does no real-time scanning), and neither C:\ nor D:\ excluded. tools/readings.js judges the record alike.
function Is-On($d) {
  if (-not $d -or -not $d.realtime -or -not $d.onAccess -or $d.mode -ne 'Normal') { return $false }
  foreach ($x in $d.exclusions) { if ($x -match '^[CD]:\\?$') { return $false } }
  return $true
}

$record = [ordered]@{ v = 1; at = (Get-Date).ToUniversalTime().ToString('o'); before = $null; after = $null; took = $false; errors = @() }
try { $record.before = Read-Defender } catch { $record.errors += ('read before: ' + $_.Exception.Message) }
try { Set-MpPreference -DisableRealtimeMonitoring $false } catch { $record.errors += ('real-time monitoring: ' + $_.Exception.Message) }
foreach ($x in 'C:\', 'D:\') {
  try { Remove-MpPreference -ExclusionPath $x } catch { $record.errors += ('exclusion ' + $x + ': ' + $_.Exception.Message) }
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
if ($record.took) { Write-Host 'Defender: real-time monitoring on, the image''s exclusions of C:\ and D:\ removed' }
else { Write-Host ('Defender: did not come on (' + ($record.errors -join '; ') + '): the readings say so') }
exit 0
