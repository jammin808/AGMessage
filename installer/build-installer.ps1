<#
  Builds AGMessage's installer, AGMessage-Setup-<label>-unsigned.exe, from a portable stage (tools/build-portable.ps1's
  dist\AGMessage, or the zip the package job built, extracted): the stage laid into a payload folder without its two .bat
  files, compiled by Inno Setup's ISCC with installer\AGMessage.iss and the defines tools\installer-defines.js reads from the
  stage's app\package.json and app\build.json (a local build makes no installer, with words), and the payload's sums,
  SHA256SUMS.payload (every file the installer lays down, its path under the install folder), written beside it.

    pwsh -File installer\build-installer.ps1 -Stage <dist\AGMessage> -Iscc <ISCC.exe> -Out <folder>
#>
param(
    [Parameter(Mandatory)] [string] $Stage,
    [Parameter(Mandatory)] [string] $Iscc,
    [Parameter(Mandatory)] [string] $Out
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path $PSScriptRoot -Parent
$Stage = (Resolve-Path $Stage).Path
# The stage's own node.exe reads the defines: the build that is installed is the build that names itself.
# Its words, when it refuses, are on its error output, which this step's log shows.
$said = (& (Join-Path $Stage 'node\node.exe') (Join-Path $repo 'tools\installer-defines.js') $Stage) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "the installer's defines could not be read (tools\installer-defines.js ended with $LASTEXITCODE)" }
$d = $said | ConvertFrom-Json

$payload = Join-Path ([System.IO.Path]::GetTempPath()) ('agmessage-payload-' + $d.FileVersion)
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
Copy-Item $Stage $payload -Recurse
foreach ($f in $d.LeftOut) {
    $p = Join-Path $payload $f
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "the stage holds no $f, which the installer leaves out: it is not the zip's stage" }
    Remove-Item -LiteralPath $p -Force
}
if (@(Get-ChildItem $payload -Recurse -Filter '*.bat').Count) { throw 'the payload still holds a .bat file: the installed node has none' }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
& $Iscc /Q "/DSemVer=$($d.SemVer)" "/DBuild=$($d.Build)" "/DInstallVersion=$($d.InstallVersion)" "/DFileVersion=$($d.FileVersion)" `
    "/DFull=$($d.Full)" "/DLabel=$($d.Label)" "/DPayload=$payload" "/DOutputDir=$Out" (Join-Path $PSScriptRoot 'AGMessage.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }
$exe = Join-Path $Out ('AGMessage-Setup-' + $d.Label + '-unsigned.exe')
if (-not (Test-Path -LiteralPath $exe)) { throw "ISCC wrote no $exe" }
# The file says the build it was compiled for: its version, read back from the file itself. A version resource's strings
# are read with the padding the resource holds after them (spaces, or NULs), which says nothing of the version: it is cut.
$info = (Get-Item -LiteralPath $exe).VersionInfo
$fileVersion = ([string]$info.FileVersion) -replace '[\x00\s]+$', ''
$productVersion = ([string]$info.ProductVersion) -replace '[\x00\s]+$', ''
if ($fileVersion -ne $d.FileVersion -or $productVersion -ne $d.Full) {
    throw "the installer's version is $fileVersion ($productVersion); this build is $($d.FileVersion) ($($d.Full))"
}

# The payload's sums: every file the installer lays down, by its path under the install folder ('/' between folders).
$lines = Get-ChildItem $payload -Recurse -File | Sort-Object FullName | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.FullName.Substring($payload.Length + 1).Replace('\', '/')
}
Set-Content -Path (Join-Path $Out 'SHA256SUMS.payload') -Value $lines -Encoding ascii
Write-Host "==> Done: $exe ($([math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)) MB, install version $($d.InstallVersion), $($lines.Count) files laid down)"
if ($env:GITHUB_OUTPUT) {
    "installer=$exe", "label=$($d.Label)", "full=$($d.Full)" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8NoBOM
}
