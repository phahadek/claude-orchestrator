import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('https', () => ({
  default: { get: vi.fn() },
}));

const { mockGetSetting, mockSetSetting } = vi.hoisted(() => ({
  mockGetSetting: vi.fn<[], string | undefined>(() => undefined),
  mockSetSetting: vi.fn<[string, string], void>(),
}));
vi.mock('../../db/queries', () => ({
  getSetting: mockGetSetting,
  setSetting: mockSetSetting,
}));

import https from 'https';
import {
  UpdateChecker,
  selectNewest,
  getChannel,
  isNewer,
  getCurrentVersion,
} from '../UpdateChecker.js';
import type { GitHubRelease } from '../types.js';
import type { ServerMessage } from '../../ws/types.js';

const CURRENT_VERSION: string = (
  require('../../../package.json') as { version: string }
).version;
const [major, minor, patch] = CURRENT_VERSION.split('.').map(Number);
const NEWER_STABLE = `v${major}.${minor + 1}.${patch}`;
const NEWER_PRERELEASE = `v${major}.${minor + 2}.${patch}-beta.1`;
const OLDER_STABLE = `v${major}.${Math.max(0, minor - 1)}.${patch}`;

function makeRelease(tagName: string, prerelease = false): GitHubRelease {
  return {
    tag_name: tagName,
    name: tagName,
    html_url: `https://github.com/example/releases/tag/${tagName}`,
    prerelease,
    assets: [],
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

describe('isNewer', () => {
  it('returns false when versions are identical', () => {
    expect(isNewer('1.4.0', '1.4.0')).toBe(false);
  });

  it('returns false when versions are identical with v prefix', () => {
    expect(isNewer('1.4.0', 'v1.4.0')).toBe(false);
  });

  it('returns true when candidate has a newer patch', () => {
    expect(isNewer('1.4.0', '1.4.1')).toBe(true);
  });

  it('returns false when candidate has an older minor', () => {
    expect(isNewer('1.4.0', '1.3.9')).toBe(false);
  });

  it('returns true when candidate has a newer minor', () => {
    expect(isNewer('1.4.0', '1.5.0')).toBe(true);
  });

  it('returns true when candidate has a newer major', () => {
    expect(isNewer('1.4.0', '2.0.0')).toBe(true);
  });

  it('returns false when candidate has an older major', () => {
    expect(isNewer('2.0.0', '1.9.9')).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  it('returns a non-placeholder semver string', () => {
    const version = getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).not.toBe('0.0.0');
  });

  it('matches the package.json version', () => {
    const pkg = require('../../../package.json') as { version: string };
    expect(getCurrentVersion()).toBe(pkg.version);
  });
});

describe('getChannel', () => {
  it('defaults to stable when setting is unset', () => {
    mockGetSetting.mockReturnValueOnce(undefined);
    expect(getChannel()).toBe('stable');
  });

  it('returns stable when setting is stable', () => {
    mockGetSetting.mockReturnValueOnce('stable');
    expect(getChannel()).toBe('stable');
  });

  it('returns beta when setting is beta', () => {
    mockGetSetting.mockReturnValueOnce('beta');
    expect(getChannel()).toBe('beta');
  });

  it('defaults to stable for unknown values', () => {
    mockGetSetting.mockReturnValueOnce('nightly' as string);
    expect(getChannel()).toBe('stable');
  });
});

describe('selectNewest', () => {
  it('returns null for an empty list', () => {
    expect(selectNewest([], false)).toBeNull();
    expect(selectNewest([], true)).toBeNull();
  });

  it('filters out prereleases in stable mode', () => {
    const releases = [
      makeRelease(NEWER_STABLE),
      makeRelease(NEWER_PRERELEASE, true),
    ];
    const result = selectNewest(releases, false);
    expect(result?.tag_name).toBe(NEWER_STABLE);
    expect(result?.prerelease).toBe(false);
  });

  it('includes prereleases in beta mode and picks newest', () => {
    const releases = [
      makeRelease(NEWER_STABLE),
      makeRelease(NEWER_PRERELEASE, true),
    ];
    const result = selectNewest(releases, true);
    expect(result?.tag_name).toBe(NEWER_PRERELEASE);
  });

  it('picks the newest by semver across a mixed list', () => {
    const v1 = makeRelease(`v${major}.${minor + 3}.0`, true);
    const v2 = makeRelease(`v${major}.${minor + 1}.0`);
    const v3 = makeRelease(`v${major}.${minor + 2}.0-rc.1`, true);
    const result = selectNewest([v2, v3, v1], true);
    expect(result?.tag_name).toBe(v1.tag_name);
  });
});

describe('UpdateChecker — release channel behavior', () => {
  let broadcast: Mock<[ServerMessage], void>;
  let checker: UpdateChecker;

  beforeEach(() => {
    broadcast = vi.fn();
    checker = new UpdateChecker(broadcast);
    delete process.env.CO_DEV;
    mockGetSetting.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    checker.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stable channel ignores a prerelease tag', async () => {
    mockGetSetting.mockReturnValue('stable');
    mockHttpsGet(makeRelease(NEWER_PRERELEASE, true));
    const info = await checker.checkNow();
    expect(info).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('stable channel surfaces a normal newer release', async () => {
    mockGetSetting.mockReturnValue('stable');
    mockHttpsGet(makeRelease(NEWER_STABLE));
    const info = await checker.checkNow();
    expect(info).not.toBeNull();
    expect(info?.version).toBe(NEWER_STABLE);
  });

  it('stable channel does not surface an older release', async () => {
    mockGetSetting.mockReturnValue('stable');
    mockHttpsGet(makeRelease(OLDER_STABLE));
    const info = await checker.checkNow();
    expect(info).toBeNull();
  });

  it('beta channel surfaces a prerelease tag', async () => {
    mockGetSetting.mockReturnValue('beta');
    mockHttpsGet([makeRelease(NEWER_PRERELEASE, true)]);
    const info = await checker.checkNow();
    expect(info).not.toBeNull();
    expect(info?.version).toBe(NEWER_PRERELEASE);
  });

  it('beta channel picks the newest from a mixed stable+prerelease list', async () => {
    mockGetSetting.mockReturnValue('beta');
    const releases = [
      makeRelease(NEWER_STABLE),
      makeRelease(NEWER_PRERELEASE, true),
    ];
    mockHttpsGet(releases);
    const info = await checker.checkNow();
    expect(info?.version).toBe(NEWER_PRERELEASE);
  });

  it('channel is re-read on each checkNow (no restart needed after PUT)', async () => {
    mockGetSetting.mockReturnValueOnce('stable');
    mockHttpsGet(makeRelease(NEWER_STABLE));
    const info1 = await checker.checkNow();
    expect(info1?.version).toBe(NEWER_STABLE);

    mockGetSetting.mockReturnValueOnce('beta');
    mockHttpsGet([makeRelease(NEWER_PRERELEASE, true)]);
    const info2 = await checker.checkNow();
    expect(info2?.version).toBe(NEWER_PRERELEASE);
  });

  it('release_channel defaults to stable when unset (regression guard)', async () => {
    mockGetSetting.mockReturnValue(undefined);
    mockHttpsGet(makeRelease(NEWER_STABLE));
    const info = await checker.checkNow();
    expect(info?.version).toBe(NEWER_STABLE);
    expect(https.get).toHaveBeenCalledTimes(1);
    expect((https.get as Mock).mock.calls[0][0]).toContain('/releases/latest');
  });

  it('beta channel calls the /releases list endpoint (not /releases/latest)', async () => {
    mockGetSetting.mockReturnValue('beta');
    mockHttpsGet([makeRelease(NEWER_PRERELEASE, true)]);
    await checker.checkNow();
    const url = (https.get as Mock).mock.calls[0][0] as string;
    expect(url).toContain('/releases');
    expect(url).not.toMatch(/\/releases\/latest$/);
  });
});
