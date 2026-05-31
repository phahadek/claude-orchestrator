#!/usr/bin/env bash
# Build a signed .deb package for claude-orchestrator (Linux x64).
# Usage: ./installers/linux/build-deb.sh [--version X.Y.Z]
#
# Environment variables consumed:
#   LINUX_GPG_PRIVATE_KEY  — ASCII-armored private key (base64-encoded) for signing
#   LINUX_GPG_PASSPHRASE   — passphrase for the GPG key
#   NODE_VERSION           — Node.js LTS version to bundle (default: 20.19.1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── version ───────────────────────────────────────────────────────────────────
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
fi
echo "Building .deb version ${VERSION}"

# ── Node.js bundle ─────────────────────────────────────────────────────────────
NODE_VERSION="${NODE_VERSION:-20.19.1}"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
NODE_SHA256_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

BUILD_DIR="${SCRIPT_DIR}/build/deb"
PAYLOAD_DIR="${BUILD_DIR}/opt/claude-orchestrator"

rm -rf "${BUILD_DIR}"
mkdir -p "${PAYLOAD_DIR}/bin" "${PAYLOAD_DIR}/app" "${PAYLOAD_DIR}/share"

echo "Downloading Node.js ${NODE_VERSION}..."
curl -fsSL "${NODE_URL}" -o "/tmp/${NODE_ARCHIVE}"
curl -fsSL "${NODE_SHA256_URL}" -o "/tmp/SHASUMS256.txt"
grep "${NODE_ARCHIVE}" /tmp/SHASUMS256.txt | sha256sum --check --status
echo "Node.js checksum verified."
tar -xzf "/tmp/${NODE_ARCHIVE}" -C /tmp
cp "/tmp/node-v${NODE_VERSION}-linux-x64/bin/node" "${PAYLOAD_DIR}/node"
chmod +x "${PAYLOAD_DIR}/node"

# ── app build ──────────────────────────────────────────────────────────────────
echo "Building application..."
(cd "${REPO_ROOT}" && npm run build)

# ── copy app payload ───────────────────────────────────────────────────────────
cp "${REPO_ROOT}/packages/backend/dist/server.js" "${PAYLOAD_DIR}/app/"

# Copy frontend static assets (built into backend's public dir or frontend dist)
if [ -d "${REPO_ROOT}/packages/backend/dist/public" ]; then
    cp -r "${REPO_ROOT}/packages/backend/dist/public" "${PAYLOAD_DIR}/app/public"
elif [ -d "${REPO_ROOT}/packages/frontend/dist" ]; then
    cp -r "${REPO_ROOT}/packages/frontend/dist" "${PAYLOAD_DIR}/app/public"
fi

# Production node_modules (backend only)
cp -r "${REPO_ROOT}/packages/backend/node_modules" "${PAYLOAD_DIR}/app/node_modules"

# ── wrapper script ─────────────────────────────────────────────────────────────
cat > "${PAYLOAD_DIR}/bin/claude-orchestrator" <<'WRAPPER'
#!/bin/sh
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/claude-orchestrator"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-orchestrator"
mkdir -p "$DATA_DIR" "$CONFIG_DIR"
export CLAUDE_ORCHESTRATOR_DATA_DIR="$DATA_DIR"
export CLAUDE_ORCHESTRATOR_CONFIG_DIR="$CONFIG_DIR"
exec /opt/claude-orchestrator/node /opt/claude-orchestrator/app/server.js "$@"
WRAPPER
chmod +x "${PAYLOAD_DIR}/bin/claude-orchestrator"

# ── share (desktop file template) ─────────────────────────────────────────────
cp "${SCRIPT_DIR}/claude-orchestrator.desktop" "${PAYLOAD_DIR}/share/autostart.desktop"

# ── debian control files ───────────────────────────────────────────────────────
DEBIAN_DIR="${BUILD_DIR}/DEBIAN"
mkdir -p "${DEBIAN_DIR}"

sed "s/^Version: .*/Version: ${VERSION}/" "${SCRIPT_DIR}/debian/control" > "${DEBIAN_DIR}/control"
cp "${SCRIPT_DIR}/debian/postinst" "${DEBIAN_DIR}/postinst"
cp "${SCRIPT_DIR}/debian/prerm"    "${DEBIAN_DIR}/prerm"
chmod 755 "${DEBIAN_DIR}/postinst" "${DEBIAN_DIR}/prerm"

# Fix installed-size estimate (in KB)
INSTALLED_KB=$(du -sk "${PAYLOAD_DIR}" | cut -f1)
sed -i "s/^Installed-Size: .*/Installed-Size: ${INSTALLED_KB}/" "${DEBIAN_DIR}/control"

# ── build .deb ─────────────────────────────────────────────────────────────────
OUT_DIR="${REPO_ROOT}/dist/linux"
mkdir -p "${OUT_DIR}"
DEB_FILE="${OUT_DIR}/claude-orchestrator_${VERSION}_amd64.deb"

dpkg-deb --build --root-owner-group "${BUILD_DIR}" "${DEB_FILE}"
echo "Built: ${DEB_FILE}"

# ── GPG signing (optional — skipped if secrets not present) ────────────────────
if [ -n "${LINUX_GPG_PRIVATE_KEY:-}" ]; then
    echo "Importing GPG key and signing .deb..."
    echo "${LINUX_GPG_PRIVATE_KEY}" | base64 -d | gpg --batch --import
    echo "${LINUX_GPG_PASSPHRASE}" | dpkg-sig --gpg-options "--batch --passphrase-fd 0" --sign builder "${DEB_FILE}"
    echo "Signed: ${DEB_FILE}"
else
    echo "LINUX_GPG_PRIVATE_KEY not set — skipping GPG signing."
fi

echo "Done. Output: ${DEB_FILE}"
