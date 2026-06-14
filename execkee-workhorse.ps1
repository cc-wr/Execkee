# Execkee - start a workhorse subcontroller (one command, on machine 2+).
#
# Self-registers upward to the controller and keeps the subcontroller running.
# You only touch this machine; the controller needs no prior configuration.
#
#   .\execkee-workhorse.ps1 -ControllerAddress 192.168.1.50:7700 -Name "Work-Laptop"
#   .\execkee-workhorse.ps1 -ControllerAddress localhost:7700

param(
  [Parameter(Mandatory = $true)] [string] $ControllerAddress,
  [string] $Name = $env:COMPUTERNAME
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not on PATH. Install Node, then re-run."
  exit 1
}
if (-not (Test-Path "node_modules")) {
  Write-Host "First run - installing dependencies..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed (exit $LASTEXITCODE)"; exit 1 }
}

if ($ControllerAddress -notmatch '^ws://') { $serverUrl = "ws://$ControllerAddress" } else { $serverUrl = $ControllerAddress }
$workhorseId = "wh-" + ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9-]', '-')

# Persist config so a later bare restart can reconnect without re-specifying.
node scripts/setup-workhorse.js $ControllerAddress $Name | Out-Null

Write-Host "Starting Execkee workhorse '$Name' -> $serverUrl" -ForegroundColor Green
Write-Host "Press Ctrl+C here to stop this workhorse." -ForegroundColor DarkGray
node src/supervisor.js workhorse $serverUrl $workhorseId $Name
