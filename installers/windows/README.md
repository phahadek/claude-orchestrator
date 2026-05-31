# Windows Installer (Inno Setup)

Produces a self-contained `claude-orchestrator-setup.exe` that bundles Node 20 LTS,
the compiled app, and production `node_modules`.

## Prerequisites

| Tool                                              | Notes                                          |
| ------------------------------------------------- | ---------------------------------------------- |
| Node.js 20+                                       | To run the build (`npm run build`)             |
| [Inno Setup 6](https://jrsoftware.org/isinfo.php) | Installer compiler                             |
| PowerShell 5.1+                                   | Build script                                   |
| Internet access                                   | To download Node 20 LTS binary from nodejs.org |

## Build

```powershell
.\build.ps1
```

The script will:

1. Download Node 20 LTS Windows x64 from `nodejs.org` and verify its SHA-256
2. Run `npm run build` to compile frontend + backend
3. Assemble the payload under `installers/windows/payload/`
4. Invoke `ISCC.exe setup.iss` to produce `installers/windows/dist/claude-orchestrator-setup.exe`

### Options

```powershell
# Skip npm build when dist/ is already up to date
.\build.ps1 -SkipBuild

# Custom Inno Setup path
.\build.ps1 -InnoSetupPath "D:\Tools\InnoSetup6\ISCC.exe"

# Pin a specific Node 20 patch version
.\build.ps1 -NodeVersion "20.18.0"
```

## Payload layout

```
payload\
  node.exe          ← Node 20 LTS x64 (downloaded, gitignored)
  start.bat         ← Launcher
  app\
    server.js       ← packages/backend/dist/
    public\         ← packages/frontend/dist/
    node_modules\   ← production deps only
```

`payload/` and `dist/` are gitignored — never commit them.

## Install locations

| Item             | Path                                    |
| ---------------- | --------------------------------------- |
| App files        | `C:\Program Files\Claude Orchestrator\` |
| Data directory   | `%APPDATA%\ClaudeOrchestrator\`         |
| Start Menu       | `Claude Orchestrator`                   |
| Startup shortcut | All Users Startup folder                |

## Uninstall

_Add or Remove Programs → Claude Orchestrator → Uninstall._

The uninstaller preserves `%APPDATA%\ClaudeOrchestrator\` (config, database) by default.
Check **"Also delete application data"** during uninstall to remove it.

## Notes

- **No code signing in v1.** Windows SmartScreen will warn on first run.
  Click _More info → Run anyway_ to proceed.
- Target compressed size: ≤ 48 MB. The build script warns if exceeded.
- Windows x64 only.
