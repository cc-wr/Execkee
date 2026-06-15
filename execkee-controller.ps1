# Execkee - start the controller (one command).
#
# Stands up: the persistent server (WebSocket hub + dashboard + 30-min cycle),
# a co-located workhorse subcontroller (Phase 0), and the primary Claude Code
# surface in the life-tasks folder - and keeps them all running. Closing this
# window (Ctrl+C) stops the system.
#
#   .\execkee-controller.ps1                     (brain-only; workers run on remote machines)
#   .\execkee-controller.ps1 -WithLocalWorkhorse (also run a co-located workhorse; single-machine)

param(
  [switch] $WithLocalWorkhorse
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Allow npm.ps1 / scripts to run on a fresh machine (default Restricted policy);
# process scope only, transient to this launch.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}

# Self-heal PATH: a prior install may have updated the User PATH in a way this
# terminal hasn't picked up yet. Re-merge it (and the Claude bin) before checking.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) { $env:Path = "$env:Path;$userPath" }
$claudeBin = Join-Path $HOME '.local\bin'
if ((-not (Get-Command claude -ErrorAction SilentlyContinue)) -and (Test-Path $claudeBin)) { $env:Path = "$claudeBin;$env:Path" }

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

# Best-effort: allow inbound TCP 7700 so workhorses on other machines can connect.
try {
  if (-not (Get-NetFirewallRule -DisplayName 'Execkee 7700' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Execkee 7700' -Direction Inbound -Protocol TCP -LocalPort 7700 -Action Allow -ErrorAction Stop | Out-Null
  }
} catch {
  Write-Warning "Could not add the firewall rule for TCP 7700 (needs Administrator). For remote workhorses, run once as Admin: New-NetFirewallRule -DisplayName 'Execkee 7700' -Direction Inbound -Protocol TCP -LocalPort 7700 -Action Allow"
}
# LAN address hint for remote workhorses; skip loopback/APIPA and common
# virtual/VPN adapters (a multi-homed host may still have several).
$virtualAlias = 'VMware|VMnet|VirtualBox|Hyper-V|vEthernet|Loopback|Tailscale|NordLynx|OpenVPN|TAP|Bluetooth|WSL|Pseudo'
$lanIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' -and $_.InterfaceAlias -notmatch $virtualAlias } |
  Select-Object -ExpandProperty IPAddress)
if ($lanIps.Count -eq 1) {
  Write-Host "Workhorses on other machines connect with:  .\execkee-workhorse.ps1 -ControllerAddress $($lanIps[0]):7700" -ForegroundColor Cyan
} elseif ($lanIps.Count -gt 1) {
  Write-Host "Workhorses on other machines connect with:  .\execkee-workhorse.ps1 -ControllerAddress <ip>:7700" -ForegroundColor Cyan
  Write-Host ("  where <ip> is this controller's LAN address - candidates: {0}" -f ($lanIps -join ', ')) -ForegroundColor DarkGray
}

if ($WithLocalWorkhorse) { $env:EXECKEE_LOCAL_WORKHORSE = '1'; Write-Host "Also running a co-located workhorse (single-machine mode)." -ForegroundColor DarkGray }
Write-Host "Starting Execkee controller. The dashboard will open shortly; the primary window will appear." -ForegroundColor Green
Write-Host "Press Ctrl+C here to stop the whole system." -ForegroundColor DarkGray
node src/supervisor.js controller
