param([Parameter(ValueFromRemainingArguments=$true)] $Args)
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root
if (-not $env:META_HARNESS_ADMIN_TOKEN) {
  Write-Host "META_HARNESS_ADMIN_TOKEN not set." -ForegroundColor Red
  exit 1
}
& node scripts/onboard-agent.js @Args
exit $LASTEXITCODE
