#!/usr/bin/env bash
# Build the Claude Orchestrator macOS .app bundle and .dmg
# Requires: macOS arm64, Xcode CLI tools, Python 3, dmgbuild (pip install dmgbuild)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="Claude Orchestrator"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
DMG_OUT="$BUILD_DIR/ClaudeOrchestrator.dmg"

NODE_VERSION="20.19.2"
NODE_ARCH="arm64"
NODE_TARBALL="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_SHASUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

echo "==> Claude Orchestrator macOS build — Node ${NODE_VERSION} arm64"

# Verify we're on arm64 macOS
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: This build script targets arm64 only. Run on Apple Silicon." >&2
  exit 1
fi

# --- Build the app ---
echo "==> npm run build"
(cd "$REPO_ROOT" && npm run build)

# --- Clean build dir ---
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# --- Download and verify Node ---
echo "==> Downloading Node ${NODE_VERSION} arm64"
curl -fSL "$NODE_URL" -o "$BUILD_DIR/$NODE_TARBALL"
curl -fSL "$NODE_SHASUMS_URL" -o "$BUILD_DIR/SHASUMS256.txt"

echo "==> Verifying SHA-256"
(cd "$BUILD_DIR" && grep " ${NODE_TARBALL}$" SHASUMS256.txt | shasum -a 256 -c -)

# --- Assemble .app bundle ---
echo "==> Assembling .app bundle"
mkdir -p "$CONTENTS/MacOS"
mkdir -p "$CONTENTS/Resources/app"

# Info.plist
cp "$SCRIPT_DIR/Info.plist" "$CONTENTS/Info.plist"

# Node binary
tar -xzf "$BUILD_DIR/$NODE_TARBALL" -C "$BUILD_DIR"
cp "$BUILD_DIR/node-v${NODE_VERSION}-darwin-${NODE_ARCH}/bin/node" "$CONTENTS/MacOS/node"
chmod +x "$CONTENTS/MacOS/node"

# start.sh
cp "$SCRIPT_DIR/start.sh" "$CONTENTS/MacOS/start.sh"
chmod +x "$CONTENTS/MacOS/start.sh"

# LaunchAgent template (installed by start.sh on first launch)
cp "$SCRIPT_DIR/com.claude.orchestrator.plist.template" \
   "$CONTENTS/Resources/launchagent.plist.template"

# Backend compiled output (includes frontend public/ from vite build) → Resources/app/
cp -r "$REPO_ROOT/packages/backend/dist/." "$CONTENTS/Resources/app/"

# Production node_modules for backend
echo "==> Installing production node_modules"
STAGING="$BUILD_DIR/staging-nm"
mkdir -p "$STAGING"
cp "$REPO_ROOT/packages/backend/package.json" "$STAGING/package.json"
cp "$REPO_ROOT/package-lock.json" "$STAGING/package-lock.json"
(cd "$STAGING" && npm ci --omit=dev --ignore-scripts)
cp -r "$STAGING/node_modules" "$CONTENTS/Resources/app/node_modules"

# Uninstall script in bundle for user convenience
cp "$SCRIPT_DIR/uninstall.sh" "$CONTENTS/Resources/uninstall.sh"
chmod +x "$CONTENTS/Resources/uninstall.sh"

# --- Build .dmg ---
echo "==> Installing dmgbuild"
pip3 install --quiet dmgbuild

echo "==> Building .dmg"
dmgbuild \
  -s "$SCRIPT_DIR/dmgbuild_settings.py" \
  -D "app=$APP_BUNDLE" \
  -D "uninstall=$SCRIPT_DIR/uninstall.sh" \
  "$APP_NAME" \
  "$DMG_OUT"

echo ""
echo "==> Done"
ls -lh "$DMG_OUT"
