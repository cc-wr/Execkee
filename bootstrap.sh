#!/usr/bin/env bash
# Execkee bootstrap — set up a WORKHORSE on a fresh macOS machine.
#
# The bash analog of bootstrap.ps1. Installs Node.js (portable tarball — no admin,
# no Homebrew) and Claude Code, ensures git, clones Execkee (a real git working
# copy), runs npm install, and launches the workhorse pointed at your controller.
#
#   curl -fsSL https://raw.githubusercontent.com/cc-wr/Execkee/master/bootstrap.sh \
#     | bash -s -- --controller 100.79.227.109:7700 --name "Mac-Workhorse"
#
#   # or, if you downloaded this file:
#   bash ./bootstrap.sh --controller 100.79.227.109:7700 --name "Mac-Workhorse"
#
# After it runs once, future starts are just: ./execkee-workhorse.sh --controller <addr>
#
# NOTE: the CONTROLLER + primary surface run on Windows (bootstrap.ps1). This
# script provisions a macOS *workhorse* only.

set -euo pipefail

MODE=workhorse
CONTROLLER=""
NAME="$(hostname -s 2>/dev/null || hostname)"
INSTALL_DIR="$HOME/Execkee"
REPO_OWNER="cc-wr"
REPO_NAME="Execkee"
BRANCH="master"
NODE_VERSION_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --controller|--controller-address) CONTROLLER="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --repo-owner) REPO_OWNER="$2"; shift 2 ;;
    --repo-name) REPO_NAME="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --node-version) NODE_VERSION_OVERRIDE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Portable Node toolchain lives OUTSIDE $INSTALL_DIR so the clone stays a clean
# git working copy (no toolchain files showing up as untracked).
TOOLS_DIR="$HOME/.execkee-tools"

C_CYAN='\033[36m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_OFF='\033[0m'
info() { printf "${C_CYAN}[execkee-setup] %s${C_OFF}\n" "$1"; }
done_() { printf "${C_GREEN}[execkee-setup] %s${C_OFF}\n" "$1"; }
warn() { printf "${C_YELLOW}[execkee-setup] %s${C_OFF}\n" "$1" >&2; }
die()  { printf "${C_YELLOW}[execkee-setup] ERROR: %s${C_OFF}\n" "$1" >&2; exit 1; }

# Append a line to ~/.zprofile only if it isn't already there (idempotent).
persist_path() {
  local line="$1" prof="$HOME/.zprofile"
  touch "$prof"
  grep -qxF "$line" "$prof" 2>/dev/null || printf '\n%s\n' "$line" >> "$prof"
}

# --- 1. Node.js 18+ (portable tarball: no admin, no Homebrew) ---
resolve_node_lts() {
  local json
  json="$(curl -fsSL https://nodejs.org/dist/index.json)" || return 1
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r 'map(select(.lts != false)) | .[0].version'
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r["lts"]))'
  else
    return 1
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node --version | sed 's/^v//' | cut -d. -f1)"
    if [ "${major:-0}" -ge 18 ] 2>/dev/null; then info "Node $(node --version) already present."; return; fi
    info "Node $(node --version) is too old; installing a current LTS locally."
  else
    info "Node.js not found; installing a current LTS locally (no admin needed)."
  fi

  local arch
  case "$(uname -m)" in
    arm64)  arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac

  local ver="$NODE_VERSION_OVERRIDE"
  if [ -z "$ver" ]; then
    info "Resolving latest Node LTS..."
    ver="$(resolve_node_lts)" || die "Could not resolve the latest Node LTS (no jq/python3). Re-run with --node-version vX.Y.Z"
  fi
  [ -n "$ver" ] || die "Empty Node version resolved; re-run with --node-version vX.Y.Z"

  local dir="node-$ver-darwin-$arch"
  local url="https://nodejs.org/dist/$ver/$dir.tar.gz"
  local tmp; tmp="$(mktemp -d)"
  info "Downloading Node $ver ($arch)..."
  curl -fsSL "$url" -o "$tmp/$dir.tar.gz" || die "Node download failed: $url"
  mkdir -p "$TOOLS_DIR/node"
  tar -xzf "$tmp/$dir.tar.gz" -C "$TOOLS_DIR/node" || die "Node extract failed."
  rm -rf "$tmp"
  # Stable 'current' symlink so PATH (and the launchd plist) never bake in a
  # version — upgrading Node just re-points the symlink (research: keeps TCC
  # Automation grants and the ~/.zprofile guard stable).
  ln -sfn "$TOOLS_DIR/node/$dir" "$TOOLS_DIR/node/current"
  export PATH="$TOOLS_DIR/node/current/bin:$PATH"
  persist_path 'export PATH="$HOME/.execkee-tools/node/current/bin:$PATH"'
  command -v node >/dev/null 2>&1 || die "Node extracted to $TOOLS_DIR/node but not on PATH. Open a new terminal and re-run."
  done_ "Node $(node --version) installed."
}

# --- 2. Claude Code (native installer: no admin) ---
ensure_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    info "Installing Claude Code..."
    curl -fsSL https://claude.ai/install.sh | bash || die "Claude Code install failed."
    [ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"
    persist_path 'export PATH="$HOME/.local/bin:$PATH"'
  fi
  command -v claude >/dev/null 2>&1 || die "Claude Code installed but 'claude' is not on PATH. Open a NEW terminal and re-run."
  done_ "Claude Code present."
  if [ ! -f "$HOME/.claude/.credentials.json" ]; then
    warn "Claude Code is not logged in yet. The workhorse can register, but it cannot"
    warn "launch or report on instances until you log in. In another terminal run:  claude"
    warn "complete the browser login, then restart the workhorse."
  fi
}

# --- 3. git (macOS: ships via the Xcode Command Line Tools) ---
ensure_git() {
  if git --version >/dev/null 2>&1; then info "Git present ($(git --version))."; return; fi
  warn "git is not available. On macOS it ships with the Xcode Command Line Tools."
  info "Opening the Command Line Tools installer (a GUI dialog will appear)..."
  xcode-select --install >/dev/null 2>&1 || true
  die "Finish the Command Line Tools install (the dialog that just opened), then re-run this script."
}

# --- 4. Clone Execkee (a committable git working copy) ---
ensure_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Execkee already present at $INSTALL_DIR; pulling latest (git pull --ff-only)..."
    git -C "$INSTALL_DIR" pull --ff-only || warn "Could not fast-forward (local changes / diverged); keeping the existing checkout."
    return
  fi
  if [ -f "$INSTALL_DIR/package.json" ]; then info "Execkee already present at $INSTALL_DIR."; return; fi
  local url="https://github.com/$REPO_OWNER/$REPO_NAME.git"
  info "Cloning Execkee from $url (branch $BRANCH)..."
  git clone --branch "$BRANCH" "$url" "$INSTALL_DIR" || die "git clone failed."
  done_ "Execkee cloned to $INSTALL_DIR (git working copy — fix, commit, and push from here)."
}

# --- main ---
info "Execkee setup — mode: $MODE, install dir: $INSTALL_DIR"
[ "$MODE" = "workhorse" ] || die "bootstrap.sh supports --mode workhorse only on macOS. The controller + primary surface run on Windows (bootstrap.ps1)."
[ -n "$CONTROLLER" ] || die "Workhorse mode needs --controller <host:port> (e.g. 100.79.227.109:7700)."

ensure_node
ensure_claude
ensure_git
ensure_repo

cd "$INSTALL_DIR"
if [ -f package-lock.json ]; then
  info "Installing dependencies (npm ci)..."
  npm ci || die "npm ci failed."
else
  info "Installing dependencies (npm install)..."
  npm install || die "npm install failed."
fi
chmod +x execkee-workhorse.sh 2>/dev/null || true
[ -f scripts/install-startup.sh ] && chmod +x scripts/install-startup.sh 2>/dev/null || true

done_ "Setup complete. Launching the workhorse..."
echo ""
exec ./execkee-workhorse.sh --controller "$CONTROLLER" --name "$NAME"
