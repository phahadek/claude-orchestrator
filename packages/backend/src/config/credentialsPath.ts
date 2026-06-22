import os from 'os';
import path from 'path';

/**
 * Returns the path to the Claude OAuth credentials file.
 *
 * - Windows: %APPDATA%\Claude\.credentials.json
 * - Other:   ~/.claude/.credentials.json
 *
 * The `platform` parameter is injectable for unit tests.
 */
export function claudeCredentialsPath(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? os.homedir(),
      'Claude',
      '.credentials.json',
    );
  }
  return path.join(os.homedir(), '.claude', '.credentials.json');
}
