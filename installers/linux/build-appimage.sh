#!/usr/bin/env bash
# Build a portable .AppImage for claude-orchestrator (Linux x64).
# Usage: ./installers/linux/build-appimage.sh [--version X.Y.Z]
#
# Requires: appimagetool on PATH (or APPIMAGETOOL env var pointing to binary).
# Download from: https://github.com/AppImage/AppImageKit/releases
#
# Environment variables consumed:
#   NODE_VERSION  — Node.js LTS version to bundle (default: 20.19.1)
#   APPIMAGETOOL  — path to appimagetool binary (default: appimagetool)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── version ───────────────────────────────────────────────────────────────────
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
fi
echo "Building AppImage version ${VERSION}"

# ── Node.js bundle ─────────────────────────────────────────────────────────────
NODE_VERSION="${NODE_VERSION:-20.19.1}"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
NODE_SHA256_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

BUILD_DIR="${SCRIPT_DIR}/build/appimage/ClaudeOrchestrator.AppDir"
rm -rf "${SCRIPT_DIR}/build/appimage"
mkdir -p "${BUILD_DIR}/app" "${BUILD_DIR}/usr/share/applications"

echo "Downloading Node.js ${NODE_VERSION}..."
curl -fsSL "${NODE_URL}" -o "/tmp/${NODE_ARCHIVE}"
curl -fsSL "${NODE_SHA256_URL}" -o "/tmp/SHASUMS256.txt"
grep "${NODE_ARCHIVE}" /tmp/SHASUMS256.txt | sha256sum --check --status
echo "Node.js checksum verified."
tar -xzf "/tmp/${NODE_ARCHIVE}" -C /tmp
cp "/tmp/node-v${NODE_VERSION}-linux-x64/bin/node" "${BUILD_DIR}/node"
chmod +x "${BUILD_DIR}/node"

# ── app build ──────────────────────────────────────────────────────────────────
echo "Building application..."
(cd "${REPO_ROOT}" && npm run build)

# ── copy app payload ───────────────────────────────────────────────────────────
cp "${REPO_ROOT}/packages/backend/dist/server.js" "${BUILD_DIR}/app/"

if [ -d "${REPO_ROOT}/packages/backend/dist/public" ]; then
    cp -r "${REPO_ROOT}/packages/backend/dist/public" "${BUILD_DIR}/app/public"
elif [ -d "${REPO_ROOT}/packages/frontend/dist" ]; then
    cp -r "${REPO_ROOT}/packages/frontend/dist" "${BUILD_DIR}/app/public"
fi

cp -r "${REPO_ROOT}/packages/backend/node_modules" "${BUILD_DIR}/app/node_modules"

# ── AppRun entry script ────────────────────────────────────────────────────────
cp "${SCRIPT_DIR}/AppRun" "${BUILD_DIR}/AppRun"
chmod +x "${BUILD_DIR}/AppRun"

# ── .desktop file (AppImage spec requires one in root) ────────────────────────
cp "${SCRIPT_DIR}/claude-orchestrator.desktop" "${BUILD_DIR}/claude-orchestrator.desktop"
cp "${SCRIPT_DIR}/claude-orchestrator.desktop" "${BUILD_DIR}/usr/share/applications/claude-orchestrator.desktop"

# ── .DirIcon (AppImage spec) ──────────────────────────────────────────────────
# Use a placeholder icon if none is present; replace with real PNG before release.
if [ -f "${REPO_ROOT}/packages/frontend/public/icon.png" ]; then
    cp "${REPO_ROOT}/packages/frontend/public/icon.png" "${BUILD_DIR}/.DirIcon"
    cp "${REPO_ROOT}/packages/frontend/public/icon.png" "${BUILD_DIR}/claude-orchestrator.png"
else
    # Create a minimal 1×1 transparent PNG as placeholder
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' \
        > "${BUILD_DIR}/.DirIcon"
    cp "${BUILD_DIR}/.DirIcon" "${BUILD_DIR}/claude-orchestrator.png"
fi

# ── build AppImage ─────────────────────────────────────────────────────────────
APPIMAGETOOL="${APPIMAGETOOL:-appimagetool}"
OUT_DIR="${REPO_ROOT}/dist/linux"
mkdir -p "${OUT_DIR}"
APPIMAGE_FILE="${OUT_DIR}/claude-orchestrator-${VERSION}-x86_64.AppImage"

ARCH=x86_64 "${APPIMAGETOOL}" "${BUILD_DIR}" "${APPIMAGE_FILE}"
chmod +x "${APPIMAGE_FILE}"
echo "Built: ${APPIMAGE_FILE}"
