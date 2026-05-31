#!/usr/bin/env bash
# Entry point for Claude Orchestrator.app — handles first-launch setup then launches the server
set -euo pipefail

APP_BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOURCES="$APP_BUNDLE/Contents/Resources"
NODE="$APP_BUNDLE/Contents/MacOS/node"
DATA_DIR="$HOME/Library/Application Support/ClaudeOrchestrator"
LOGS_DIR="$DATA_DIR/logs"
LAUNCHAGENT_ID="com.claude.orchestrator"
LAUNCHAGENT_PLIST="$HOME/Library/LaunchAgents/$LAUNCHAGENT_ID.plist"

# Ensure data and logs dirs exist
mkdir -p "$LOGS_DIR"

# First-launch: install LaunchAgent so the app auto-starts on login
if [ ! -f "$LAUNCHAGENT_PLIST" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  sed \
    -e "s|{{DATA_DIR}}|$DATA_DIR|g" \
    -e "s|{{HOME}}|$HOME|g" \
    "$RESOURCES/launchagent.plist.template" > "$LAUNCHAGENT_PLIST"
  launchctl load "$LAUNCHAGENT_PLIST" 2>/dev/null || true
fi

# Launch the server (exec replaces this shell so launchd tracks the node process)
export DATA_DIR="$DATA_DIR"
export PORT="${PORT:-3000}"
exec "$NODE" "$RESOURCES/app/server.js"
