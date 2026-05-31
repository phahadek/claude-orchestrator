import { spawn } from 'child_process';

/**
 * Launches the installer in detached mode, then exits the backend process
 * so the installer can replace files in use.
 *
 * On Windows (Inno Setup): the installer handles RestartIfNeededByRun.
 * On macOS/Linux: the installer/package manager handles the replacement.
 */
export function launchInstallerAndExit(installerPath: string): void {
  console.log(`[updater] launching installer: ${installerPath}`);

  const args: string[] = [];

  if (process.platform === 'win32') {
    // Inno Setup: /SILENT suppresses the progress UI but still shows UAC prompt
    args.push('/SILENT');
  } else if (process.platform === 'darwin') {
    // For .dmg files: open with Finder so user can drag-install
    // For .pkg: installer command
    if (installerPath.endsWith('.pkg')) {
      const child = spawn('sudo', ['installer', '-pkg', installerPath, '-target', '/'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      setTimeout(() => process.exit(0), 500);
      return;
    } else {
      const child = spawn('open', [installerPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      setTimeout(() => process.exit(0), 500);
      return;
    }
  } else {
    // Linux: AppImage is executable; .deb/.rpm use package managers
    if (installerPath.endsWith('.AppImage')) {
      try {
        const fs = require('fs') as typeof import('fs');
        fs.chmodSync(installerPath, 0o755);
      } catch {
        // best effort
      }
    } else if (installerPath.endsWith('.deb')) {
      const child = spawn('pkexec', ['dpkg', '-i', installerPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      setTimeout(() => process.exit(0), 500);
      return;
    } else if (installerPath.endsWith('.rpm')) {
      const child = spawn('pkexec', ['rpm', '-U', installerPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      setTimeout(() => process.exit(0), 500);
      return;
    }
  }

  const child = spawn(installerPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Give the OS a moment to start the installer before we exit
  setTimeout(() => process.exit(0), 500);
}
