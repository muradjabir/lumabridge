#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/lumabridge"
CONFIG_FILE="$CONFIG_DIR/config.json"
LOG_DIR="$HOME/Library/Logs/LumaBridge"
AGENT_DIR="$HOME/Library/LaunchAgents"
BIN_PATH="/usr/local/bin/lumabridged"
PLIST_PATH="$AGENT_DIR/com.lumabridge.daemon.plist"
SERVICE_LABEL="com.lumabridge.daemon"
UID_NUM="$(id -u)"

usage() {
  cat <<EOF
LumaBridge macOS External Display Daemon Installer

Usage:
  ./install-lumabridge.sh              Compile and install lumabridged + LaunchAgent
  ./install-lumabridge.sh --status     Inspect running launchd service and recent logs
  ./install-lumabridge.sh --uninstall  Stop and remove the LaunchAgent and binary
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: install-lumabridge.sh must be executed on macOS (Darwin)." >&2
  exit 1
fi

if [[ "${1:-}" == "--status" ]]; then
  echo "Service: gui/$UID_NUM/$SERVICE_LABEL"
  launchctl print "gui/$UID_NUM/$SERVICE_LABEL" 2>/dev/null || echo "Service is not currently loaded."
  if [[ -f "$LOG_DIR/daemon.out.log" ]]; then
    echo "--- Recent daemon.out.log ---"
    tail -n 20 "$LOG_DIR/daemon.out.log"
  fi
  exit 0
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "Uninstalling LumaBridge background daemon..."
  launchctl bootout "gui/$UID_NUM/$SERVICE_LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  if [[ -f "$BIN_PATH" ]]; then
    sudo rm -f "$BIN_PATH"
  fi
  echo "Removed LaunchAgent and $BIN_PATH."
  echo "Your configuration at $CONFIG_FILE was preserved."
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "Error: swiftc not found. Install Xcode Command Line Tools first:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

SWIFT_SRC="$SCRIPT_DIR/macos/LumaBridgeDaemon.swift"
PLIST_SRC="$SCRIPT_DIR/macos/com.lumabridge.daemon.plist"
DEFAULT_CONFIG="$SCRIPT_DIR/macos/config.default.json"

if [[ ! -f "$SWIFT_SRC" || ! -f "$PLIST_SRC" || ! -f "$DEFAULT_CONFIG" ]]; then
  echo "Error: Missing macos/ source files alongside install-lumabridge.sh." >&2
  exit 1
fi

echo "Installing LumaBridge macOS External Display Background Daemon..."
mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$AGENT_DIR"

if [[ ! -f "$CONFIG_FILE" ]]; then
  cp "$DEFAULT_CONFIG" "$CONFIG_FILE"
  echo "Installed default display configuration -> $CONFIG_FILE"
else
  echo "Preserving existing display configuration at $CONFIG_FILE"
fi

echo "Compiling native lumabridged binary with swiftc..."
sudo mkdir -p /usr/local/bin
sudo swiftc -O \
  -framework Cocoa \
  -framework IOKit \
  -framework CoreGraphics \
  "$SWIFT_SRC" -o "$BIN_PATH"
sudo chmod 755 "$BIN_PATH"

sed "s|__HOME__|$HOME|g" "$PLIST_SRC" > "$PLIST_PATH"

launchctl bootout "gui/$UID_NUM/$SERVICE_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH"
launchctl kickstart -k "gui/$UID_NUM/$SERVICE_LABEL"

echo ""
echo "LumaBridge background daemon is installed and running."
echo "  Binary: $BIN_PATH"
echo "  Config: $CONFIG_FILE"
echo "  Agent:  $PLIST_PATH"
echo "  Logs:   $LOG_DIR/daemon.out.log"
echo ""
echo "Run './install-lumabridge.sh --status' to inspect or '--uninstall' to remove."
