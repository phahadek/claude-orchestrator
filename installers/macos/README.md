# macOS Installer — Claude Orchestrator

Builds a drag-to-Applications `.dmg` with a bundled `.app` containing Node 20 LTS arm64.

## Prerequisites

- macOS arm64 (Apple Silicon)
- Xcode Command Line Tools: `xcode-select --install`
- Python 3 + dmgbuild: `pip3 install dmgbuild`
- Node.js + npm (for building the app)

## Build

```bash
cd installers/macos
./build.sh
```

Output: `installers/macos/build/ClaudeOrchestrator.dmg`

## What the installer does

1. User drags **Claude Orchestrator.app** to `/Applications`.
2. On first launch, `start.sh` creates `~/Library/Application Support/ClaudeOrchestrator/` and installs the LaunchAgent at `~/Library/LaunchAgents/com.claude.orchestrator.plist`.
3. The server auto-starts on every login and is accessible at <http://localhost:3000>.

## App bundle layout

```
Claude Orchestrator.app/
  Contents/
    Info.plist
    MacOS/
      node              ← Node 20 LTS arm64 binary
      start.sh          ← CFBundleExecutable; handles first-launch setup
    Resources/
      app/
        server.js       ← compiled backend
        public/         ← compiled frontend (Vite build)
        node_modules/   ← production backend dependencies
      launchagent.plist.template
      uninstall.sh
```

## Uninstall

```bash
/Applications/Claude\ Orchestrator.app/Contents/Resources/uninstall.sh
```

Preserves `~/Library/Application Support/ClaudeOrchestrator/` (config + DB).
Add `--remove-data` to delete it too.

## Notes

- **Unsigned for v1** — macOS will show a Gatekeeper warning on first launch.
  Right-click → Open → Open to dismiss it.
- Intel Macs (x86_64) are not supported in v1. Use the dev install path instead.
- Node 20 LTS version is pinned in `build.sh`. Update `NODE_VERSION` to upgrade.
