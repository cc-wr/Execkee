# Execkee - reset local state for a clean test run.
#
# Stops any running Execkee processes and clears the tracking file and shared
# store under ~/.execkee. Does NOT delete the life-tasks folder (your tasks)
# or any Claude session on disk.
#
#   .\scripts\reset.ps1

$ErrorActionPreference = 'SilentlyContinue'
$data = Join-Path $env:USERPROFILE ".execkee"

Write-Host "Stopping Execkee processes..." -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'supervisor\.js|src[\\/]server[\\/]index\.js|src[\\/]workhorse[\\/]index\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "Clearing tracking + shared store..." -ForegroundColor Cyan
Set-Content -Path (Join-Path $data "tracking.json") -Value '{"version":1,"workhorses":{},"instances":{}}' -Encoding ascii
Set-Content -Path (Join-Path $data "state.json") -Value '{"updatedAt":null,"workhorses":{}}' -Encoding ascii
$store = Join-Path $data "shared-store"
if (Test-Path $store) { Get-ChildItem $store -Filter *.json | Remove-Item -Force -ErrorAction SilentlyContinue }

Write-Host "Reset complete. Managed-instance windows (if any) were left open - close them manually if needed." -ForegroundColor Green
