# PowerShell launcher for the Meta Harness stack. Thin wrapper around
# start-all.bat — the .bat uses `start /MIN cmd /c ...` which fully detaches
# child processes on Windows, which is the only reliable way to keep them
# running after this script exits.
#
# Usage:
#   $env:META_HARNESS_ADMIN_TOKEN = "your-token"
#   .\scripts\start-all.ps1
# or:
#   .\scripts\start-all.ps1 -AdminToken your-token [-Port 20000]

param(
  [string]$AdminToken = $env:META_HARNESS_ADMIN_TOKEN,
  [int]$Port = $(if ($env:META_HARNESS_PORT) { [int]$env:META_HARNESS_PORT } else { 20000 })
)

$ErrorActionPreference = 'Stop'

if (-not $AdminToken -or $AdminToken.Length -eq 0) {
  Write-Host "[meta-harness] Admin token not provided." -ForegroundColor Red
  Write-Host ""
  Write-Host "  Option 1: set the env var first"
  Write-Host '     $env:META_HARNESS_ADMIN_TOKEN = "your-token"'
  Write-Host "     .\scripts\start-all.ps1"
  Write-Host ""
  Write-Host "  Option 2: pass as parameter"
  Write-Host "     .\scripts\start-all.ps1 -AdminToken your-token"
  exit 1
}

# Propagate to child cmd.exe via env so the .bat sees them.
$env:META_HARNESS_ADMIN_TOKEN = $AdminToken
$env:META_HARNESS_PORT = "$Port"

$bat = Join-Path $PSScriptRoot 'start-all.bat'
if (-not (Test-Path $bat)) { Write-Host "start-all.bat not found at $bat" -ForegroundColor Red; exit 1 }

& cmd.exe /c "`"$bat`""
exit $LASTEXITCODE
