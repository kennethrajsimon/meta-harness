# Thin wrapper — register-agent.js is the real implementation.
# Usage:
#   $env:META_HARNESS_ADMIN_TOKEN = "your-token"
#   .\scripts\register-agent.ps1 my-agent --caps "docs,summarize" --model sonnet

param([Parameter(ValueFromRemainingArguments=$true)] $Args)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

if (-not $env:META_HARNESS_ADMIN_TOKEN) {
  Write-Host "META_HARNESS_ADMIN_TOKEN not set." -ForegroundColor Red
  Write-Host "  `$env:META_HARNESS_ADMIN_TOKEN = 'your-token'"
  exit 1
}

& node scripts/register-agent.js @Args
exit $LASTEXITCODE
