# Execkee bootstrap - set up the whole system on a fresh Windows machine.
#
# Installs Node.js and Git (portable - no admin, no winget), installs Claude
# Code, clones Execkee (a git working copy), runs npm install, and launches.
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

# Portable Node/Git install here, OUTSIDE $InstallDir, so the cloned repo stays a
# clean git working copy (no toolchain files showing up as untracked).
$toolsDir = Join-Path $HOME '.execkee-tools'

# --- 1. Node.js 18+ (portable zip: no admin, no winget) ---
function Ensure-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $cur = ((node --version) -replace 'v', '').Split('-')[0]
    if ([version]$cur -ge [version]'18.0.0') { Info "Node $cur already present."; return }
    Info "Node $cur is too old; installing a current LTS locally."
  } else {
    Info "Node.js not found; installing a current LTS locally (no admin needed)."
  }
  $nodeRoot = Join-Path $toolsDir 'node'
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

# --- 3. Git for Windows (portable: no admin, no winget) ---
function Ensure-Git {
  if (Get-Command git -ErrorAction SilentlyContinue) { Info "Git present ($(git --version))."; return }
  Info "Git not found; installing Git for Windows (portable, no admin)..."
  $gitRoot = Join-Path $toolsDir 'git'
  New-Item -ItemType Directory -Force -Path $gitRoot | Out-Null
  $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'Execkee-bootstrap' }
  $asset = $rel.assets | Where-Object { $_.name -match '^PortableGit-.*-64-bit\.7z\.exe$' } | Select-Object -First 1
  if (-not $asset) { Die "Could not find a 64-bit PortableGit asset in the latest Git for Windows release." }
  $sfx = Join-Path $env:TEMP $asset.name
  Info "Downloading $($asset.name)..."
  Invoke-WebRequest $asset.browser_download_url -OutFile $sfx -UseBasicParsing
  Info "Extracting portable Git to $gitRoot ..."
  Start-Process -FilePath $sfx -ArgumentList '-y', ('-o"' + $gitRoot + '"') -Wait -NoNewWindow
  Remove-Item $sfx -Force -ErrorAction SilentlyContinue
  $gitCmd = Join-Path $gitRoot 'cmd'
  $env:Path = "$gitCmd;$env:Path"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$gitCmd*") {
    [Environment]::SetEnvironmentVariable('Path', "$gitCmd;$userPath", 'User')
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die "Git was extracted to $gitRoot but 'git' is not on PATH. Open a NEW terminal and re-run this script."
  }
  Done "Git for Windows installed ($(git --version))."
}

# --- 4. Clone Execkee (a git working copy you can fix, commit, and push from) ---
function Ensure-Repo {
  if ($RepoOwner -eq 'REPLACE_ME') {
    Die "RepoOwner is not set. Edit bootstrap.ps1 (set `$RepoOwner) or pass -RepoOwner <github-user>."
  }
  if (Test-Path (Join-Path $InstallDir '.git')) { Info "Execkee already cloned at $InstallDir."; return }
  if (Test-Path (Join-Path $InstallDir 'package.json')) { Info "Execkee already present at $InstallDir."; return }
  $repoUrl = "https://github.com/$RepoOwner/$RepoName.git"
  Info "Cloning Execkee from $repoUrl (branch $Branch)..."
  git clone --branch $Branch $repoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Die "git clone failed (exit $LASTEXITCODE)." }
  Done "Execkee cloned to $InstallDir (git working copy - fix, commit, and push from here)."
}

# --- main ---
Info "Execkee setup - mode: $Mode, install dir: $InstallDir"
if ($Mode -eq 'workhorse' -and -not $ControllerAddress) {
  Die "Workhorse mode needs -ControllerAddress <host:port> (e.g. 192.168.1.50:7700)."
}
Ensure-Node
Ensure-Claude
Ensure-Git
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
# client policy is Restricted (clone files have no Mark-of-the-Web, but be safe).
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
