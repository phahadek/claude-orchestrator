# Linux Installer — Build Guide

This directory contains scripts to build the Linux `.deb` and `.AppImage` packages for Claude Orchestrator, and the systemd unit for running from source on a dedicated Ubuntu host.

---

## Run from Source under systemd (Recommended for servers)

This section covers running the orchestrator directly from the cloned repository under systemd, owned by a dedicated non-root user. This is the supported server deployment model. The packaged `.deb`/`.AppImage` installer sections below are for desktop/user installs.

### Prerequisites

| Tool    | Purpose                              |
| ------- | ------------------------------------ |
| `node`  | Runtime — install system-wide, not via nvm |
| `npm`   | Bundled with Node.js                 |
| `git`   | Clone and pull updates               |

Install Node.js (system-wide, not via nvm so the systemd unit can find it):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Verify the paths the unit expects:

```bash
which node   # must be /usr/bin/node or /usr/local/bin/node
which git    # must be on PATH
node --version
```

### 1. Provision the service user

```bash
sudo useradd --system --create-home --shell /bin/bash orchestrator
```

All subsequent steps that touch `/home/orchestrator/` must run as that user:

```bash
sudo -u orchestrator -i   # open a shell as the orchestrator user
```

### 2. Clone and build

Run the following **as the `orchestrator` user**:

```bash
cd ~
git clone https://github.com/your-org/claude-orchestrator.git
cd claude-orchestrator
npm ci
npm run build
```

> **Note on native modules**: `better-sqlite3` contains a native addon compiled for the build host. Never copy `node_modules/` from a Windows or macOS machine — always run `npm ci` on the Ubuntu host so the addon is compiled for Linux. If you update Node.js, re-run `npm ci` to recompile.

Re-run `npm ci && npm run build` after every `git pull` to keep the built output in sync.

### 3. Authenticate the claude CLI as the service user

The orchestrator reads claude CLI credentials from the service user's home directory (`~/.claude/.credentials.json`). Authenticate **as the `orchestrator` user**:

```bash
claude auth login
```

Verify the credentials file was created:

```bash
ls -la ~/.claude/.credentials.json
```

### 4. Install and enable the systemd unit

Exit back to your admin shell, then:

```bash
sudo cp /home/orchestrator/claude-orchestrator/installers/linux/orchestrator.service \
     /etc/systemd/system/orchestrator.service

sudo systemctl daemon-reload
sudo systemctl enable --now orchestrator
```

Check that it started:

```bash
sudo systemctl status orchestrator
sudo journalctl -u orchestrator -f
```

### 5. Lifecycle management

| Action          | Command                              |
| --------------- | ------------------------------------ |
| Status          | `sudo systemctl status orchestrator` |
| Logs            | `sudo journalctl -u orchestrator -f` |
| Restart         | `sudo systemctl restart orchestrator` |
| Stop            | `sudo systemctl stop orchestrator`   |
| Disable autostart | `sudo systemctl disable orchestrator` |

On `systemctl stop`, systemd sends SIGTERM and waits up to `TimeoutStopSec=20` seconds for the process to exit gracefully before sending SIGKILL. The orchestrator's graceful-shutdown handler runs agent-session cleanup during this window.

### Updating

```bash
sudo -u orchestrator -i
cd ~/claude-orchestrator
git pull
npm ci
npm run build
exit
sudo systemctl restart orchestrator
```

---

## Prerequisites

| Tool                | Purpose                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `dpkg-deb`          | Build `.deb` packages (Ubuntu/Debian)                                                                      |
| `dpkg-sig`          | GPG-sign the `.deb`                                                                                        |
| `appimagetool`      | Build `.AppImage` (download from [AppImageKit releases](https://github.com/AppImage/AppImageKit/releases)) |
| `curl`, `sha256sum` | Download and verify Node.js                                                                                |
| `node`              | Version detection from `package.json`                                                                      |

Install tools on Ubuntu/Debian:

```bash
sudo apt-get install dpkg-sig
```

Download `appimagetool`:

```bash
wget -O /usr/local/bin/appimagetool \
  https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x /usr/local/bin/appimagetool
```

## Build .deb

```bash
./installers/linux/build-deb.sh
```

The output is written to `dist/linux/claude-orchestrator_<version>_amd64.deb`.

### GPG Signing

The `.deb` is signed automatically when `LINUX_GPG_PRIVATE_KEY` and `LINUX_GPG_PASSPHRASE`
are set. Without them, an unsigned `.deb` is produced.

#### One-time key generation (maintainer step)

```bash
gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: Claude Orchestrator Release
Name-Email: release@claude-orchestrator
Expire-Date: 0
%no-protection
EOF

# Export private key (base64-encoded) for GitHub Actions secret
gpg --export-secret-keys --armor release@claude-orchestrator | base64 -w0
# → paste output as LINUX_GPG_PRIVATE_KEY secret

# Export public key for users to import
gpg --export --armor release@claude-orchestrator > installers/linux/release-key.asc
```

Add the following secrets in **GitHub → Settings → Secrets and variables → Actions**:

| Secret                  | Value                                            |
| ----------------------- | ------------------------------------------------ |
| `LINUX_GPG_PRIVATE_KEY` | base64-encoded ASCII-armored private key         |
| `LINUX_GPG_PASSPHRASE`  | GPG key passphrase (leave blank if key has none) |

#### User key import (for signature verification)

```bash
gpg --import installers/linux/release-key.asc
dpkg-sig --verify claude-orchestrator_<version>_amd64.deb
```

## Build AppImage

```bash
./installers/linux/build-appimage.sh
```

The output is written to `dist/linux/claude-orchestrator-<version>-x86_64.AppImage`.

AppImages are not GPG-signed (the format embeds a digest instead).

## Manual install (without a package manager)

```bash
chmod +x claude-orchestrator-<version>-x86_64.AppImage
./claude-orchestrator-<version>-x86_64.AppImage
```

The app creates its data directory at `~/.local/share/claude-orchestrator/` on first launch
and is accessible at **http://localhost:3000**.

## Installer payload structure

```
/opt/claude-orchestrator/
  node                          ← bundled Node 20 LTS x64
  bin/
    claude-orchestrator         ← wrapper script
  app/
    server.js
    public/                     ← frontend static assets
    node_modules/               ← production dependencies
  share/
    autostart.desktop           ← .desktop template copied by postinst
```

## Auto-start behaviour

The `.deb` `postinst` script detects `$SUDO_USER`:

- **If set** (i.e., `sudo apt install …`): copies `autostart.desktop` to
  `/home/<user>/.config/autostart/claude-orchestrator.desktop`.
- **If unset** (plain `root` install): prints a manual copy command.

The AppImage does not install an autostart entry. Users can add one manually:

```bash
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/claude-orchestrator.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Claude Orchestrator
Exec=/path/to/claude-orchestrator-<version>-x86_64.AppImage
X-GNOME-Autostart-enabled=true
EOF
```

## Uninstall (.deb)

```bash
sudo apt remove claude-orchestrator
```

The data directory at `~/.local/share/claude-orchestrator/` is **preserved** by default.
To purge all data:

```bash
rm -rf ~/.local/share/claude-orchestrator ~/.config/claude-orchestrator
```
