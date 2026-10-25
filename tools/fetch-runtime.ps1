<#
  Downloads the two programs the portable bundle ships with, at pinned versions, and checks each against its official
  SHA-256 before keeping it:
    node\node.exe          Node.js 24.22.1 LTS (win-x64) https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
    bin\cloudflared.exe    cloudflared 2026.3.0         GitHub release asset digest
  They aren't kept in git (they're 150 MB). Run once after cloning; CI runs it before building the zip.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$files = @(
  @{ Url = 'https://nodejs.org/dist/v24.22.1/win-x64/node.exe';
     Path = 'node\node.exe';
     Sha = 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5' },
  @{ Url = 'https://github.com/cloudflare/cloudflared/releases/download/2026.3.0/cloudflared-windows-amd64.exe';
     Path = 'bin\cloudflared.exe';
     Sha = '59b12880b24af581cf5b1013db601c7d843b9b097e9c78aa5957c7f39f741885' }
)
foreach ($f in $files) {
  $dest = Join-Path $root $f.Path
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  if ((Test-Path $dest) -and ((Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -eq $f.Sha)) {
    Write-Host "  ok (already here)  $($f.Path)"; continue
  }
  $tmp = "$dest.download"
  Write-Host "  downloading        $($f.Url)"
  Invoke-WebRequest -Uri $f.Url -OutFile $tmp -UseBasicParsing
  $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $f.Sha) { Remove-Item $tmp -Force; throw "Checksum mismatch for $($f.Path): got $got, expected $($f.Sha)" }
  Move-Item $tmp $dest -Force
  Write-Host "  ok (verified)      $($f.Path)"
}
