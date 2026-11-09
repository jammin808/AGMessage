<#
  The evidence of CI's canary jobs, removed with them once they have answered: what a runner with Defender back on was
  doing until it went quiet. Run by each of a canary's steps for that step's minutes, it writes to -Out every 20 s, over
  the files it wrote before (the heartbeat appended to), and the canary uploads that folder after each step under a name
  of its own, so what it held when the runner was last heard survives the job the hosted service fails later.

    pwsh -File tools\canary-evidence.ps1 -Out <folder> [-Minutes 2]

  It writes: heartbeat.log (a line every 20 s: the time, Defender's and the runner's processes with their CPU and memory,
  the runner listener's connections, free memory), defender-status.txt (Get-MpComputerStatus and Get-MpPreference),
  defender-events.txt (Defender's own log, newest first), threats.txt (what Defender found), system-events.txt (the
  System log's warnings and errors, newest first) and runner-diag\ (the runner listener's newest warnings and errors;
  never the worker's log, which holds the job's message). The artifact is readable by whoever reads the repository, so
  every line of every file goes through Hide-Secret first: anything shaped like a token, a signature or a key is blanked.
  Nothing here changes the machine. A reading that fails is written as its error, and the rest go on.
#>
param([Parameter(Mandatory = $true)][string]$Out, [int]$Minutes = 2)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force $Out | Out-Null
New-Item -ItemType Directory -Force (Join-Path $Out 'runner-diag') | Out-Null
$beat = Join-Path $Out 'heartbeat.log'
$until = (Get-Date).AddMinutes($Minutes)

# Every line written: a JWT, a GitHub token, a value named as a secret (sig=, token=, key=, password=, sessionid=) and any
# run of 32 or more characters a key or a signature is made of (URL-encoded too) blanked.
filter Hide-Secret {
  ([string]$_) -replace 'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+', '<token>' `
    -replace 'gh[pousr]_[A-Za-z0-9]{20,}', '<token>' -replace 'github_pat_[A-Za-z0-9_]+', '<token>' `
    -replace '(?i)\b(sig|signature|token|access_token|key|secret|password|pwd|sessionid)(\s*[=:]\s*)[^&\s;,"'']+', '$1$2<hidden>' `
    -replace '(?:[A-Za-z0-9+/=_\-]|%[0-9A-Fa-f]{2}){32,}', '<long>'
}
function Write-Safe([string]$file, [scriptblock]$what) {
  $to = Join-Path $Out $file
  try {
    $ErrorActionPreference = 'Stop'
    & $what | Out-String -Width 400 -Stream | Hide-Secret | Set-Content -LiteralPath $to -Encoding utf8
  } catch { ('could not read: ' + $_.Exception.Message) | Hide-Secret | Set-Content -LiteralPath $to -Encoding utf8 }
}

while ((Get-Date) -lt $until) {
  try {
    $now = (Get-Date).ToUniversalTime().ToString('u')
    $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in 'MsMpEng', 'MpDefenderCoreService', 'NisSrv' -or $_.ProcessName -like 'Runner.*' } |
      ForEach-Object { '{0}#{1} cpu {2:N0} s ws {3:N0} MB' -f $_.ProcessName, $_.Id, $_.CPU, ($_.WorkingSet64 / 1MB) })
    $listener = @(Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $conns = if ($listener.Count) { @(Get-NetTCPConnection -OwningProcess $listener -ErrorAction SilentlyContinue | ForEach-Object { '{0}:{1} {2}' -f $_.RemoteAddress, $_.RemotePort, $_.State }) } else { @('no Runner.Listener') }
    $free = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
    ('{0} | {1} | listener {2} | free {3} MB' -f $now, ($procs -join '; '), ($conns -join ', '), $free) | Hide-Secret | Add-Content -LiteralPath $beat -Encoding utf8
  } catch { ('heartbeat failed: ' + $_.Exception.Message) | Hide-Secret | Add-Content -LiteralPath $beat -Encoding utf8 }
  Write-Safe 'defender-status.txt' { Get-MpComputerStatus | Format-List *; Get-MpPreference | Format-List ExclusionPath, ExclusionProcess, ExclusionExtension, DisableRealtimeMonitoring, SignatureScheduleDay, SignatureScheduleTime, ScanScheduleDay, ScanScheduleTime, ScanParameters, EnableNetworkProtection, CloudBlockLevel, MAPSReporting }
  Write-Safe 'defender-events.txt' { Get-WinEvent -LogName 'Microsoft-Windows-Windows Defender/Operational' -MaxEvents 200 | ForEach-Object { $m = $_.Message -replace '\s+', ' '; '{0:u} {1} {2}: {3}' -f $_.TimeCreated.ToUniversalTime(), $_.Id, $_.LevelDisplayName, $m.Substring(0, [Math]::Min(900, $m.Length)) } }
  Write-Safe 'threats.txt' { Get-MpThreatDetection | Format-List *; Get-MpThreat | Format-List * }
  Write-Safe 'system-events.txt' { Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2, 3 } -MaxEvents 100 | ForEach-Object { $m = $_.Message -replace '\s+', ' '; '{0:u} {1} {2} {3}: {4}' -f $_.TimeCreated.ToUniversalTime(), $_.ProviderName, $_.Id, $_.LevelDisplayName, $m.Substring(0, [Math]::Min(600, $m.Length)) } }
  # The listener's own log only (never the worker's, which holds the job's message), and of it only its warnings and
  # errors.
  try {
    foreach ($exe in @(Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { $_.Path } | Sort-Object -Unique)) {
      $diag = Join-Path (Split-Path -Parent (Split-Path -Parent $exe)) '_diag'
      foreach ($log in @(Get-ChildItem -LiteralPath $diag -Filter 'Runner_*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2)) {
        Get-Content -LiteralPath $log.FullName -Tail 3000 -ErrorAction SilentlyContinue | Where-Object { $_ -match '\b(ERR|WARN)\b' } | Select-Object -Last 200 |
          Hide-Secret | Set-Content -LiteralPath (Join-Path $Out ('runner-diag\' + $log.Name)) -Encoding utf8
      }
    }
  } catch { ('could not read the runner''s logs: ' + $_.Exception.Message) | Hide-Secret | Set-Content -LiteralPath (Join-Path $Out 'runner-diag\error.txt') -Encoding utf8 }
  # Only as long as is left, so the step ends at its minutes.
  $left = ($until - (Get-Date)).TotalSeconds
  if ($left -gt 0) { Start-Sleep -Seconds ([Math]::Min(20, [Math]::Ceiling($left))) }
}
