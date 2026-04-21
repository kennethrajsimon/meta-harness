# Stops the Meta Harness service + broker. Leaves the Fleet dashboard alone.
# Usage: .\scripts\stop-all.ps1 [-Port 20000]

param([int]$Port = $(if ($env:META_HARNESS_PORT) { [int]$env:META_HARNESS_PORT } else { 20000 }))

Write-Host "[meta-harness] stopping listener on :$Port"
$portListeners = netstat -ano | Select-String -Pattern ":$Port\s.*LISTENING" | ForEach-Object {
  ($_ -split '\s+')[-1]
} | Where-Object { $_ -and $_ -ne '0' } | Sort-Object -Unique

foreach ($procId in $portListeners) {
  Write-Host "  killing pid $procId"
  try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { }
}

Write-Host "[meta-harness] stopping node processes running meta-broker / meta-harness"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.CommandLine -match 'meta-broker|meta-harness'
} | ForEach-Object {
  Write-Host "  killing pid $($_.ProcessId)  ($($_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length))))"
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { }
}

Write-Host "[meta-harness] stopped."
