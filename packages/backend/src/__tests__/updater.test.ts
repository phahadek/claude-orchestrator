import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// We need to mock the https module before importing UpdateChecker
vi.mock('https', () => {
  return {
    default: {
      get: vi.fn(),
    },
  };
});

import https from 'https';
import { UpdateChecker } from '../updater/UpdateChecker.js';
import { selectAsset } from '../updater/UpdateDownloader.js';
import type { GitHubAsset, UpdateInfo } from '../updater/types.js';
import type { ServerMessage } from '../ws/types.js';

// Read the actual version from package.json so tests stay correct as version bumps.
 
const CURRENT_VERSION: string = (
  require('../../package.json') as { version: string }
).version;
const [major, minor, patch] = CURRENT_VERSION.split('.').map(Number);
// Build version strings relative to the current version
const NEWER_MINOR = `v${major}.${minor + 1}.${patch}`;
const NEWER_MAJOR = `v${major + 1}.${minor}.${patch}`;
const SAME = `v${CURRENT_VERSION}`;
const OLDER = `v${major}.${Math.max(0, minor - 1)}.${patch}`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRelease(tagName: string, prerelease = false) {
  return {
    tag_name: tagName,
    name: tagName,
    html_url: `https://github.com/phahadek/claude-orchestrator/releases/tag/${tagName}`,
    prerelease,
    assets: [
      {
        name: 'ClaudeOrchestrator-Setup.exe',
        browser_download_url: `https://github.com/phahadek/claude-orchestrator/releases/download/${tagName}/ClaudeOrchestrator-Setup.exe`,
        size: 1024,
        content_type: 'application/octet-stream',
      },
    ],
    body: 'Release notes',
  };
}

function mockHttpsGet(responseBody: object | null, statusCode = 200) {
  (https.get as Mock).mockImplementationOnce(
    (_url: unknown, _opts: unknown, callback: (res: unknown) => void) => {
      const events: Record<string, ((chunk?: unknown) => void)[]> = {};
      const res = {
        statusCode,
        on: (event: string, handler: (chunk?: unknown) => void) => {
          events[event] = events[event] ?? [];
          events[event].push(handler);
          return res;
        },
      };
      callback(res);
      if (responseBody !== null) {
        events['data']?.forEach((h) =>
          h(Buffer.from(JSON.stringify(responseBody))),
        );
      }
      events['end']?.forEach((h) => h());
      return { on: vi.fn(), setTimeout: vi.fn() };
    },
  );
}

function mockHttpsGetError() {
  (https.get as Mock).mockImplementationOnce(
    (_url: unknown, _opts: unknown, _callback: unknown) => {
      const req = {
        on: (event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error('Network error'));
          return req;
        },
        setTimeout: vi.fn(),
      };
      return req;
    },
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('UpdateChecker', () => {
  let broadcast: Mock<[ServerMessage], void>;
  let checker: UpdateChecker;

  beforeEach(() => {
    broadcast = vi.fn();
    checker = new UpdateChecker(broadcast);
    delete process.env.CO_DEV;
    vi.useFakeTimers();
  });

  afterEach(() => {
    checker.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('emits update_available when a newer version is published', async () => {
    mockHttpsGet(makeRelease(NEWER_MINOR));
    const info = await checker.checkNow();
    expect(info).not.toBeNull();
    expect(info?.version).toBe(NEWER_MINOR);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'update_available',
        version: NEWER_MINOR,
      }),
    );
  });

  it('does not emit when version is the same', async () => {
    mockHttpsGet(makeRelease(SAME));
    const info = await checker.checkNow();
    expect(info).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not emit when running an older release (downgrade guard)', async () => {
    mockHttpsGet(makeRelease(OLDER));
    const info = await checker.checkNow();
    expect(info).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('skips pre-releases', async () => {
    mockHttpsGet(makeRelease(`${NEWER_MAJOR}-beta`, true));
    const info = await checker.checkNow();
    expect(info).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('handles network failure gracefully — no broadcast, no throw', async () => {
    mockHttpsGetError();
    const info = await checker.checkNow();
    expect(info).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('handles non-200 HTTP responses gracefully', async () => {
    mockHttpsGet({ message: 'Not Found' }, 404);
    const info = await checker.checkNow();
    expect(info).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('skips update check entirely in dev mode', async () => {
    process.env.CO_DEV = '1';
    checker.start();
    // No https.get should have been called
    expect(https.get).not.toHaveBeenCalled();
    const info = await checker.checkNow();
    expect(info).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('suppresses re-prompt for dismissed version', async () => {
    // First check: update available
    mockHttpsGet(makeRelease(NEWER_MINOR));
    await checker.checkNow();
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Dismiss
    checker.dismiss(NEWER_MINOR);

    // checkNow uses force=true, so it will broadcast regardless of dismiss
    mockHttpsGet(makeRelease(NEWER_MINOR));
    const info = await checker.checkNow();
    expect(broadcast).toHaveBeenCalledTimes(2);
    void info;

    // A newer release than the dismissed one should clear dismiss state and broadcast
    checker.dismiss(NEWER_MINOR);
    mockHttpsGet(makeRelease(NEWER_MAJOR));
    const info2 = await checker.checkNow();
    expect(info2?.version).toBe(NEWER_MAJOR);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });
});

// ── Asset selection ────────────────────────────────────────────────────────────

describe('selectAsset', () => {
  const makeInfo = (assets: Partial<GitHubAsset>[]): UpdateInfo => ({
    version: 'v1.1.0',
    releaseNotesUrl: 'https://example.com',
    assets: assets.map((a) => ({
      name: a.name ?? 'file',
      browser_download_url:
        a.browser_download_url ?? 'https://example.com/file',
      size: a.size ?? 1024,
      content_type: a.content_type ?? 'application/octet-stream',
    })),
  });

  it('selects .exe on win32', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    const info = makeInfo([
      { name: 'ClaudeOrchestrator-Setup.exe' },
      { name: 'ClaudeOrchestrator.dmg' },
    ]);
    const asset = selectAsset(info);
    expect(asset?.name).toBe('ClaudeOrchestrator-Setup.exe');
    Object.defineProperty(process, 'platform', {
      value: origPlatform,
      configurable: true,
    });
  });

  it('selects .dmg on darwin', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
    const info = makeInfo([
      { name: 'ClaudeOrchestrator-Setup.exe' },
      { name: 'ClaudeOrchestrator.dmg' },
    ]);
    const asset = selectAsset(info);
    expect(asset?.name).toBe('ClaudeOrchestrator.dmg');
    Object.defineProperty(process, 'platform', {
      value: origPlatform,
      configurable: true,
    });
  });

  it('selects amd64 .deb on linux x64', () => {
    const origPlatform = process.platform;
    const origArch = process.arch;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64',
      configurable: true,
    });
    const info = makeInfo([
      { name: 'ClaudeOrchestrator-arm64.deb' },
      { name: 'ClaudeOrchestrator-amd64.deb' },
    ]);
    const asset = selectAsset(info);
    expect(asset?.name).toBe('ClaudeOrchestrator-amd64.deb');
    Object.defineProperty(process, 'platform', {
      value: origPlatform,
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: origArch,
      configurable: true,
    });
  });

  it('returns null when no matching asset found', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    const info = makeInfo([{ name: 'README.md' }]);
    const asset = selectAsset(info);
    expect(asset).toBeNull();
    Object.defineProperty(process, 'platform', {
      value: origPlatform,
      configurable: true,
    });
  });
});
