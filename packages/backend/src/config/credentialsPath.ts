import os from 'os';
import path from 'path';

/**
 * Returns the path to the Claude CLI credentials file (~/.claude/.credentials.json).
 *
 * The `home` parameter is injectable for unit tests.
 *
 * Note: the %APPDATA%\Claude path belongs to the Claude Desktop app, not the CLI.
 * The CLI stores credentials in ~/.claude/ on all platforms.
 */
export function claudeCredentialsPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', '.credentials.json');
}
