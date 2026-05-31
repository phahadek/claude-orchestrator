#!/usr/bin/env bash
# Uninstall Claude Orchestrator — unloads LaunchAgent and removes the app bundle.
# Data dir is preserved by default. Pass --remove-data to delete it too.
set -euo pipefail

LAUNCHAGENT_ID="com.claude.orchestrator"
LAUNCHAGENT_PLIST="$HOME/Library/LaunchAgents/$LAUNCHAGENT_ID.plist"
APP_PATH="/Applications/Claude Orchestrator.app"
DATA_DIR="$HOME/Library/Application Support/ClaudeOrchestrator"
REMOVE_DATA=false

for arg in "$@"; do
  case "$arg" in
    --remove-data) REMOVE_DATA=true ;;
  esac
done

echo "==> Uninstalling Claude Orchestrator"

# Unload and remove LaunchAgent
if [ -f "$LAUNCHAGENT_PLIST" ]; then
  launchctl unload "$LAUNCHAGENT_PLIST" 2>/dev/null || true
  rm -f "$LAUNCHAGENT_PLIST"
  echo "    Removed LaunchAgent"
fi

# Remove app bundle (requires write access to /Applications)
if [ -d "$APP_PATH" ]; then
  rm -rf "$APP_PATH"
  echo "    Removed $APP_PATH"
fi

# Optionally remove data dir
if $REMOVE_DATA; then
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
    echo "    Removed data dir: $DATA_DIR"
  fi
else
  echo "    Data dir preserved: $DATA_DIR"
  echo "    Run with --remove-data to delete it"
fi

echo "==> Done"
