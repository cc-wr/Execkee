#!/usr/bin/env bash
# Execkee — start a workhorse subcontroller (one command, on a macOS machine).
#
# The bash analog of execkee-workhorse.ps1. Self-registers upward to the
# controller and keeps the subcontroller running. You only touch this machine;
# the controller needs no prior configuration.
#
#   ./execkee-workhorse.sh --controller <controller-host>:7700 --name "Mac-Workhorse"
#   ./execkee-workhorse.sh <controller-host>:7700 "Mac-Workhorse"     # positional also works
#   ./execkee-workhorse.sh --controller localhost:7700

set -euo pipefail

# Run from the repo root (this script's directory), like the .ps1 does.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONTROLLER=""
NAME=""

# Accept --controller/--name (and -ControllerAddress/-Name for symmetry with the
# Windows launcher), plus bare positional [controller] [name].
while [ $# -gt 0 ]; do
  case "$1" in
    --controller|--controller-address|-ControllerAddress|-c) CONTROLLER="$2"; shift 2 ;;
    --name|-Name|-n) NAME="$2"; shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [ -z "$CONTROLLER" ]; then CONTROLLER="$1"
      elif [ -z "$NAME" ]; then NAME="$1"
      fi
      shift ;;
  esac
done

if [ -z "$CONTROLLER" ]; then
  echo "Usage: ./execkee-workhorse.sh --controller <host:port> [--name <name>]" >&2
  exit 1
fi

HOST_SHORT="$(hostname -s 2>/dev/null || hostname)"
[ -z "$NAME" ] && NAME="$HOST_SHORT"

# Self-heal PATH: a prior install may have updated ~/.zprofile in a way this shell
# hasn't picked up yet. Make sure the portable Node and the Claude bin are visible.
# Each iteration returns 0 (if-with-false-condition is 0) so the loop never trips
# `set -e`, and ":$PATH:" matching avoids duplicate entries.
for d in "$HOME"/.execkee-tools/node/current/bin "$HOME"/.execkee-tools/node/*/bin "$HOME/.local/bin"; do
  if [ -d "$d" ]; then
    case ":$PATH:" in
      *":$d:"*) ;;
      *) PATH="$d:$PATH" ;;
    esac
  fi
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not on PATH. Run bootstrap.sh first, or install Node, then re-run." >&2
  exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "WARNING: the 'claude' CLI is not on PATH — this workhorse can register but" >&2
  echo "         cannot launch or report on instances until Claude Code is installed." >&2
fi
if [ ! -d node_modules ]; then
  echo "First run — installing dependencies..."
  npm install
fi

# Normalize to a ws:// URL.
case "$CONTROLLER" in
  ws://*) SERVER_URL="$CONTROLLER" ;;
  *)      SERVER_URL="ws://$CONTROLLER" ;;
esac

# Reachability preflight (UX only — the subcontroller also retries on its own).
HOSTPORT="${CONTROLLER#ws://}"
CHOST="${HOSTPORT%%:*}"
CPORT="${HOSTPORT##*:}"
[ "$CPORT" = "$HOSTPORT" ] && CPORT=7700
if command -v nc >/dev/null 2>&1; then
  if ! nc -z -G 2 "$CHOST" "$CPORT" >/dev/null 2>&1; then
    echo "WARNING: can't reach controller at ${CHOST}:${CPORT} yet — check the address," >&2
    echo "         that the controller is running, and the firewall. Starting anyway; it retries." >&2
  fi
fi

# wh-<sanitized-hostname>, matching the node-side default in setup-workhorse.js.
WID="wh-$(echo "$HOST_SHORT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')"

# Persist config so a later bare restart can reconnect without re-specifying.
# Non-fatal: a config-write hiccup shouldn't stop the workhorse from starting.
node scripts/setup-workhorse.js "$CONTROLLER" "$NAME" >/dev/null || true

echo "Starting Execkee workhorse '$NAME' -> $SERVER_URL"
echo "Press Ctrl+C here to stop this workhorse."
exec node src/supervisor.js workhorse "$SERVER_URL" "$WID" "$NAME"
