# Execkee bootstrap - set up the whole system on a fresh Windows machine.
#
# Installs Node.js (portable - no admin, no winget), installs Claude Code,
# downloads Execkee (zip - no git needed), runs npm install, and launches.
#
# CONTROLLER (default) - on the main machine:
#   irm https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.ps1 | iex
#   (or, if you downloaded this file:)
#   powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1
#
# WORKHORSE - on a second machine (point it at the controller):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.ps1))) -Mode workhorse -ControllerAddress 192.168.1.50:7700
#
# After it runs once, future starts are just: .\execkee-controller.ps1 (or .\execkee-workhorse.ps1)

param(
  [ValidateSet('controller', 'workhorse')] [string] $Mode = 'controller',
  [string] $ControllerAddress = '',
  [string] $Name = $env:COMPUTERNAME,
  [string] $InstallDir = (Join-Path $HOME 'Execkee'),
  [string] $RepoOwner = 'cc-wr',
  [string] $RepoName  = 'Execkee',
  [string] $Branch = 'master'
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "[execkee-setup] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[execkee-setup] $m" -ForegroundColor Green }
function Die($m)  { Write-Error $m; exit 1 }

# --- 1. Node.js 18+ (portable zip: no admin, no winget) ---
function Ensure-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $cur = ((node --version) -replace 'v', '').Split('-')[0]
    if ([version]$cur -ge [version]'18.0.0') { Info "Node $cur already present."; return }
    Info "Node $cur is too old; installing a current LTS locally."
  } else {
    Info "Node.js not found; installing a current LTS locally (no admin needed)."
  }
  $nodeRoot = Join-Path $InstallDir 'node'
  New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
  Info "Resolving latest Node LTS..."
  $lts = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts } | Select-Object -First 1
  $ver = $lts.version
  $dir = "node-$ver-win-x64"
  $zip = Join-Path $env:TEMP "$dir.zip"
  Info "Downloading Node $ver..."
  Invoke-WebRequest "https://nodejs.org/dist/$ver/$dir.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $nodeRoot -Force
  Remove-Item $zip -Force
  $nodeBin = Join-Path $nodeRoot $dir
  $env:Path = "$nodeBin;$env:Path"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$nodeBin*") {
    [Environment]::SetEnvironmentVariable('Path', "$nodeBin;$userPath", 'User')
  }
  Done "Node $((node --version)) installed."
}

# --- 2. Claude Code (native installer: no admin, no Node, no winget) ---
function Ensure-Claude {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Info "Installing Claude Code..."
    Invoke-Expression (Invoke-RestMethod 'https://claude.ai/install.ps1')
    $claudeBin = Join-Path $HOME '.local\bin'
    if (Test-Path $claudeBin) { $env:Path = "$claudeBin;$env:Path" }
  }
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Die "Claude Code installed but 'claude' is not on PATH. Open a NEW terminal and re-run this script."
  }
  Done "Claude Code present."
  $credPath = Join-Path $HOME '.claude\.credentials.json'
  if (-not (Test-Path $credPath)) {
    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    if (-not $interactive) {
      Die "Claude Code is not logged in and this session is non-interactive. Run 'claude' once in an interactive console to complete the browser login, then re-run this installer."
    }
    Write-Warning "Claude Code requires a one-time browser login before the controller can run."
    Info "In ANOTHER terminal run:  claude  -> complete the browser login. (Ctrl+C here to abort.)"
    while (-not (Test-Path $credPath)) {
      Read-Host "Press Enter to re-check login status" | Out-Null
      if (-not (Test-Path $credPath)) { Write-Warning "Still not logged in - $credPath not found yet." }
    }
  }
  Done "Claude Code logged in."
}

# --- 3. Download Execkee (zip: no git needed) ---
function Ensure-Repo {
  if ($RepoOwner -eq 'REPLACE_ME') {
    Die "RepoOwner is not set. Edit bootstrap.ps1 (set `$RepoOwner) or pass -RepoOwner <github-user>."
  }
  if (Test-Path (Join-Path $InstallDir 'package.json')) { Info "Execkee already present at $InstallDir."; return }
  $zipUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$Branch.zip"
  $zip = Join-Path $env:TEMP "execkee-$Branch.zip"
  $tmp = Join-Path $env:TEMP 'execkee-extract'
  Info "Downloading Execkee from $zipUrl ..."
  Invoke-WebRequest $zipUrl -OutFile $zip -UseBasicParsing
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extracted = Get-ChildItem $tmp -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Copy-Item -Path (Join-Path $extracted.FullName '*') -Destination $InstallDir -Recurse -Force
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Done "Execkee downloaded to $InstallDir."
}

# --- main ---
Info "Execkee setup - mode: $Mode, install dir: $InstallDir"
if ($Mode -eq 'workhorse' -and -not $ControllerAddress) {
  Die "Workhorse mode needs -ControllerAddress <host:port> (e.g. 192.168.1.50:7700)."
}
Ensure-Node
Ensure-Claude
Ensure-Repo
Set-Location $InstallDir
if (Test-Path (Join-Path $InstallDir 'package-lock.json')) {
  Info "Installing dependencies (npm ci)..."
  npm ci
} else {
  Info "Installing dependencies (npm install)..."
  npm install
}
if ($LASTEXITCODE -ne 0) { Die "npm install failed (exit $LASTEXITCODE)." }
# Let the local launcher .ps1 files run on future (day-2) starts: the default
# client policy is Restricted, and zip-extracted files may carry a Mark-of-the-Web.
Get-ChildItem -Path $InstallDir -Recurse -Include *.ps1, *.psm1, *.psd1 -File | Unblock-File -ErrorAction SilentlyContinue
$effPolicy = Get-ExecutionPolicy
if ($effPolicy -in @('Restricted', 'AllSigned', 'Undefined')) {
  Info "Allowing local launcher scripts to run (CurrentUser scope)..."
  try { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force }
  catch { Write-Warning "Could not set execution policy. If a launcher is blocked later, start it with: powershell -ExecutionPolicy Bypass -File .\execkee-$Mode.ps1" }
}

Done "Setup complete. Launching the $Mode..."
Write-Host ""
$launcher = Join-Path $InstallDir "execkee-$Mode.ps1"
if (-not (Test-Path $launcher)) { Die "Launcher $launcher not found in the downloaded repo." }
if ($Mode -eq 'controller') {
  & $launcher
} else {
  & $launcher -ControllerAddress $ControllerAddress -Name $Name
}
