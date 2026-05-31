# Linux Installer — Build Guide

This directory contains scripts to build the Linux `.deb` and `.AppImage` packages for Claude Orchestrator.

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
