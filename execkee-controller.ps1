# Execkee - start the controller (one command).
#
# Stands up: the persistent server (WebSocket hub + dashboard + 30-min cycle),
# a co-located workhorse subcontroller (Phase 0), and the primary Claude Code
# surface in the life-tasks folder - and keeps them all running. Closing this
# window (Ctrl+C) stops the system.
#
#   .\execkee-controller.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is not on PATH. Install Node, then re-run."
  exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning "The 'claude' CLI is not on PATH - the primary surface and reports will not launch."
}

if (-not (Test-Path "node_modules")) {
  Write-Host "First run - installing dependencies..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed (exit $LASTEXITCODE)"; exit 1 }
}

Write-Host "Starting Execkee controller. The dashboard will open shortly; the primary window will appear." -ForegroundColor Green
Write-Host "Press Ctrl+C here to stop the whole system." -ForegroundColor DarkGray
node src/supervisor.js controller
