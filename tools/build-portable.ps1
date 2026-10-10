<#
  Builds the portable Windows bundle: dist\AGMessage-Portable-Windows-<version>.zip
  The zip never contains meeting history, uploads, keys or settings: app\data and app\uploads start empty.

    powershell -File tools\build-portable.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
& (Join-Path $PSScriptRoot 'fetch-runtime.ps1')

$version = (Get-Content app\package.json -Raw | ConvertFrom-Json).version
$name = "AGMessage-Portable-Windows-$version"
$stage = Join-Path $root "dist\$name"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force "$stage\app" | Out-Null

Write-Host "==> Staging $name"
Copy-Item app\server.js, app\package.json, app\package-lock.json, app\README.md "$stage\app"
Copy-Item app\lib "$stage\app\lib" -Recurse
Copy-Item app\public "$stage\app\public" -Recurse
New-Item -ItemType Directory -Force "$stage\app\data\rooms", "$stage\app\uploads" | Out-Null
New-Item -ItemType File -Force "$stage\app\uploads\.gitkeep" | Out-Null
Copy-Item node "$stage\node" -Recurse
Copy-Item bin "$stage\bin" -Recurse
Copy-Item README.txt, start-agmessage.bat, make-shareable-copy.bat $stage

Write-Host '==> Installing production dependencies'
Push-Location "$stage\app"
npm ci --omit=dev --no-audit --no-fund
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'npm ci failed' }

# Never ship meeting data, whatever the working copy holds.
foreach ($p in 'app\data\rooms\*.json', 'app\data\rooms\*.log', 'app\data\*.key', 'app\data\settings.json') {
  if (Get-ChildItem (Join-Path $stage $p) -ErrorAction SilentlyContinue) { throw "Refusing to package: $p is present" }
}

$zip = Join-Path $root "dist\$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip
Write-Host "==> Done: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)" -ForegroundColor Green
