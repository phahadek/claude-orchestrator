import https from 'https';
import type { IncomingMessage } from 'http';
import type { GitHubRelease, UpdateInfo } from './types.js';
import type { ServerMessage } from '../ws/types.js';

const REPO = 'phahadek/claude-orchestrator';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

function isDevMode(): boolean {
  return process.env.CO_DEV === '1';
}

function getCurrentVersion(): string {
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

function isNewer(current: string, candidate: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const [ca, cb, cc] = parse(current);
  const [na, nb, nc] = parse(candidate);
  if (na !== ca) return na > ca;
  if (nb !== cb) return nb > cb;
  return nc > cc;
}

function fetchRelease(): Promise<GitHubRelease | null> {
  return new Promise((resolve) => {
    const req = https.get(
      RELEASES_URL,
      {
        headers: {
          'User-Agent': `claude-orchestrator/${getCurrentVersion()}`,
          Accept: 'application/vnd.github+json',
        },
      },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body) as GitHubRelease);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

export class UpdateChecker {
  private timer: NodeJS.Timeout | null = null;
  private dismissedVersion: string | null = null;

  constructor(private readonly broadcast: (msg: ServerMessage) => void) {}

  /** Start polling. Called after server boots. */
  start(): void {
    if (isDevMode()) {
      console.log('[updater] dev mode — update checks disabled');
      return;
    }
    void this.check();
    this.timer = setInterval(() => void this.check(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force an immediate check, ignoring dismiss state. */
  async checkNow(): Promise<UpdateInfo | null> {
    if (isDevMode()) return null;
    return this.runCheck(true);
  }

  /** Called when user dismisses the banner for a given version. */
  dismiss(version: string): void {
    this.dismissedVersion = version;
  }

  private async check(): Promise<void> {
    await this.runCheck(false);
  }

  private async runCheck(force: boolean): Promise<UpdateInfo | null> {
    const release = await fetchRelease();
    if (!release) {
      console.warn(
        '[updater] failed to fetch latest release — will retry next cycle',
      );
      return null;
    }

    if (release.prerelease) return null;

    const currentVersion = getCurrentVersion();
    const tagVersion = release.tag_name;

    if (!isNewer(currentVersion, tagVersion)) return null;

    // Clear dismissed state when a newer version than the dismissed one is available
    if (
      this.dismissedVersion &&
      isNewer(this.dismissedVersion, tagVersion) &&
      !force
    ) {
      return null;
    }

    const info: UpdateInfo = {
      version: tagVersion,
      releaseNotesUrl: release.html_url,
      assets: release.assets,
    };

    if (!force && this.dismissedVersion === tagVersion) return null;

    this.broadcast({
      type: 'update_available',
      version: tagVersion,
      releaseNotesUrl: release.html_url,
    });

    console.log(
      `[updater] update available: ${currentVersion} → ${tagVersion}`,
    );
    return info;
  }
}
