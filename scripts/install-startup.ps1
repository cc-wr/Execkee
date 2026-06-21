# Execkee - install a logon-startup entry so the controller (or a workhorse) starts
# automatically when you log in (survives logout and reboot, on next logon). No admin
# required: this drops a small launcher in your user Startup folder. Remove with -Uninstall.
#
#   .\scripts\install-startup.ps1                                   (controller, brain-only)
#   .\scripts\install-startup.ps1 -WithLocalWorkhorse               (controller + co-located workhorse)
#   .\scripts\install-startup.ps1 -Mode workhorse -ControllerAddress <controller-host>:7700 -Name "Workhorse-2"
#   .\scripts\install-startup.ps1 -Uninstall
#
# Note: this runs at LOGON (no admin). For before-logon / service-style startup, a
# scheduled task or Windows service is the next step (needs admin) - see STATUS.md.

param(
  [ValidateSet('controller', 'workhorse')] [string] $Mode = 'controller',
  [string] $ControllerAddress = '',
  [string] $Name = $env:COMPUTERNAME,
  [switch] $WithLocalWorkhorse,
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$startup = [Environment]::GetFolderPath('Startup')
$cmdPath = Join-Path $startup 'Execkee.cmd'

if ($Uninstall) {
  if (Test-Path $cmdPath) { Remove-Item $cmdPath -Force; Write-Host "Removed startup entry: $cmdPath" }
  else { Write-Host "No Execkee startup entry found." }
  return
}

if ($Mode -eq 'workhorse' -and -not $ControllerAddress) {
  Write-Error "Workhorse mode needs -ControllerAddress <host:port> (e.g. 192.168.1.50:7700)."
  exit 1
}

if ($Mode -eq 'controller') {
  $launcher = Join-Path $repo 'execkee-controller.ps1'
  $line = 'start "Execkee" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
  if ($WithLocalWorkhorse) { $line += ' -WithLocalWorkhorse' }
} else {
  $launcher = Join-Path $repo 'execkee-workhorse.ps1'
  $line = 'start "Execkee" powershell -NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '" -ControllerAddress "' + $ControllerAddress + '" -Name "' + $Name + '"'
}

# A .cmd in the Startup folder runs at logon (no admin); 'start' opens the launcher
# in its own window where the controller/workhorse runs in the foreground.
$content = "@echo off`r`n" + $line + "`r`n"
Set-Content -Path $cmdPath -Value $content -Encoding ASCII
Write-Host "Installed logon-startup entry: $cmdPath"
Write-Host "Mode: $Mode$(if ($Mode -eq 'workhorse') { " -> $ControllerAddress" })"
Write-Host "Execkee will start at your next logon. Remove with: .\scripts\install-startup.ps1 -Uninstall"
