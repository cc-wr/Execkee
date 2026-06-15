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
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning "The 'claude' CLI is not on PATH - this workhorse can register but cannot launch or report on instances until it is installed."
}
if (-not (Test-Path "node_modules")) {
  Write-Host "First run - installing dependencies..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed (exit $LASTEXITCODE)"; exit 1 }
}

if ($ControllerAddress -notmatch '^ws://') { $serverUrl = "ws://$ControllerAddress" } else { $serverUrl = $ControllerAddress }

# Reachability preflight (UX only - the subcontroller also retries on its own).
$hostport = $ControllerAddress -replace '^ws://', ''
$chost = ($hostport -split ':')[0]
$cport = ($hostport -split ':')[1]; if (-not $cport) { $cport = 7700 }
$reach = Test-NetConnection -ComputerName $chost -Port $cport -WarningAction SilentlyContinue -InformationLevel Quiet
if (-not $reach) {
  Write-Warning "Can't reach controller at ${chost}:${cport} yet - check the address, that the controller is running, and the firewall. Starting anyway; it will keep retrying."
}
$workhorseId = "wh-" + ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9-]', '-')

# Persist config so a later bare restart can reconnect without re-specifying.
node scripts/setup-workhorse.js $ControllerAddress $Name | Out-Null

Write-Host "Starting Execkee workhorse '$Name' -> $serverUrl" -ForegroundColor Green
Write-Host "Press Ctrl+C here to stop this workhorse." -ForegroundColor DarkGray
node src/supervisor.js workhorse $serverUrl $workhorseId $Name
