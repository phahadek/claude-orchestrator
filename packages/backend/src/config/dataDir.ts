import os from 'os';
import path from 'path';

/**
 * Returns the per-OS application data directory for ClaudeOrchestrator.
 *
 * - Windows:  %APPDATA%\ClaudeOrchestrator\
 * - macOS:    ~/Library/Application Support/ClaudeOrchestrator/
 * - Linux:    ${XDG_DATA_HOME:-~/.local/share}/claude-orchestrator/
 *
 * The `platform` parameter is injectable for unit tests.
 */
export function getDataDir(
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA ?? os.homedir(),
        'ClaudeOrchestrator',
      );
    case 'darwin':
      return path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'ClaudeOrchestrator',
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
        'claude-orchestrator',
      );
  }
}
