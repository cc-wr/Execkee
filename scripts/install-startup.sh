#!/usr/bin/env bash
# Execkee — install a login-startup LaunchAgent so a macOS workhorse starts
# automatically when you log in (survives logout/reboot, on next logon). No admin
# required: this drops a per-user LaunchAgent in ~/Library/LaunchAgents. The bash
# analog of scripts/install-startup.ps1. Remove with --uninstall.
#
#   ./scripts/install-startup.sh --controller 100.79.227.109:7700 --name "Mac-Workhorse"
#   ./scripts/install-startup.sh --uninstall
#
# IMPORTANT — macOS Automation (TCC) permission, one-time and manual:
#   The workhorse drives Terminal.app via AppleScript to open/hide/show instance
#   windows. The FIRST time it does so, macOS shows a prompt: "<app> wants to
#   control Terminal.app." A human MUST click OK once, while logged in at the
#   Mac's screen. A login/launchd-started run that hits this before anyone is
#   looking (or over SSH) will fail silently. So: run ./execkee-workhorse.sh
#   MANUALLY once at the console and approve the prompt BEFORE installing this
#   LaunchAgent. The grant is bound to the node binary path — this installer pins
#   the stable ~/.execkee-tools/node/current path to keep the grant across Node
#   upgrades. Inspect/revoke under System Settings > Privacy & Security > Automation.

set -euo pipefail

MODE=workhorse
CONTROLLER=""
NAME="$(hostname -s 2>/dev/null || hostname)"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --controller|--controller-address) CONTROLLER="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.execkee.workhorse"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

if [ "$UNINSTALL" = "1" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if [ -f "$PLIST" ]; then rm -f "$PLIST"; echo "Removed startup agent: $PLIST"; else echo "No Execkee startup agent found."; fi
  exit 0
fi

[ "$MODE" = "workhorse" ] || { echo "install-startup.sh supports --mode workhorse only on macOS." >&2; exit 1; }
[ -n "$CONTROLLER" ] || { echo "Workhorse mode needs --controller <host:port>." >&2; exit 1; }

# Pin a stable node path (research: keeps the TCC Automation grant valid across
# Node upgrades). Prefer the Execkee toolchain symlink; fall back to PATH node.
if [ -x "$HOME/.execkee-tools/node/current/bin/node" ]; then
  NODE_BIN="$HOME/.execkee-tools/node/current/bin"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(cd "$(dirname "$(command -v node)")" && pwd)"
else
  echo "Node.js not found. Run bootstrap.sh first." >&2; exit 1
fi

mkdir -p "$AGENT_DIR" "$LOG_DIR"

# Run via execkee-workhorse.sh so PATH self-heal + config persistence + the
# reachability preflight all happen exactly as in a manual start. launchd gives
# the process a minimal PATH, so we also set a usable PATH in the plist.
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO_DIR/execkee-workhorse.sh</string>
        <string>--controller</string>
        <string>$CONTROLLER</string>
        <string>--name</string>
        <string>$NAME</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/execkee-workhorse.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/execkee-workhorse.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_BIN:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST

# Reload idempotently (bootout the old one first; ignore if absent). bootout is
# asynchronous, so pause briefly to let a stale service finish tearing down —
# otherwise bootstrap can race it and fail with "already bootstrapped"/I-O error.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  echo "launchctl bootstrap reported an error (often a stale service still tearing down)." >&2
  echo "Re-run this command, or run:  launchctl bootout gui/$(id -u)/$LABEL  then re-run." >&2
  exit 1
fi

echo "Installed login-startup agent: $PLIST"
echo "Mode: workhorse -> $CONTROLLER  (logs: $LOG_DIR/execkee-workhorse.{out,err}.log)"
echo "It will start now and at every login. Remove with: ./scripts/install-startup.sh --uninstall"
echo ""
echo "REMINDER: approve the one-time macOS 'control Terminal' Automation prompt at the"
echo "console (run ./execkee-workhorse.sh manually once first if you have not yet)."
