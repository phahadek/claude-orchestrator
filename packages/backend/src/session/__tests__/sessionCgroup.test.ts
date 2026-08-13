import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../config', () => ({
  runtimeSettings: {
    session_cgroup_prod_reserve_mb: 4096,
    session_cgroup_memory_high_fraction: 0.9,
    session_cgroup_deny_swap: true,
  },
}));

import fs from 'fs';
import { logger } from '../../logger';
import {
  computeSessionCgroupLimits,
  setupSessionCgroup,
  placeSessionPid,
  killSessionCgroup,
  reapplySessionCgroupLimits,
  _resetForTesting,
  _setSessionsPathForTesting,
} from '../sessionCgroup';

describe('computeSessionCgroupLimits', () => {
  it('derives memory.max as total memory minus the configured reserve', () => {
    const limits = computeSessionCgroupLimits({
      totalMemBytes: 32 * 1024 * 1024 * 1024,
      prodReserveMb: 4096,
      highFraction: 0.9,
      denySwap: true,
    });
    const expectedMax = 32 * 1024 * 1024 * 1024 - 4096 * 1024 * 1024;
    expect(limits.maxBytes).toBe(expectedMax);
  });

  it('derives memory.high as a fraction below memory.max', () => {
    const limits = computeSessionCgroupLimits({
      totalMemBytes: 32 * 1024 * 1024 * 1024,
      prodReserveMb: 4096,
      highFraction: 0.9,
      denySwap: true,
    });
    expect(limits.highBytes).toBe(Math.floor(limits.maxBytes * 0.9));
    expect(limits.highBytes).toBeLessThan(limits.maxBytes);
  });

  it('clamps memory.max at zero when the reserve exceeds total memory', () => {
    const limits = computeSessionCgroupLimits({
      totalMemBytes: 1024 * 1024 * 1024,
      prodReserveMb: 4096,
      highFraction: 0.9,
      denySwap: true,
    });
    expect(limits.maxBytes).toBe(0);
    expect(limits.highBytes).toBe(0);
  });

  it('carries the deny-swap flag through unchanged', () => {
    expect(
      computeSessionCgroupLimits({
        totalMemBytes: 1024 * 1024 * 1024,
        prodReserveMb: 0,
        highFraction: 0.9,
        denySwap: false,
      }).denySwap,
    ).toBe(false);
  });
});

describe('setupSessionCgroup graceful no-op', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('logs a warning and does not throw when the cgroup-v2 unified hierarchy is absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(() => setupSessionCgroup()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logs a warning and does not throw when reading /proc/self/cgroup fails', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    expect(() => setupSessionCgroup()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logs a warning and does not throw when subtree_control write fails (no delegation)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('/proc/self/cgroup')) {
        return '0::/system.slice/orchestrator.service';
      }
      if (String(p).endsWith('cgroup.controllers')) {
        return 'cpu memory io';
      }
      return '';
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p) => {
      if (String(p).endsWith('cgroup.subtree_control')) {
        throw new Error('EACCES: permission denied');
      }
    });
    expect(() => setupSessionCgroup()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('setupSessionCgroup write ordering', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('evacuates the own pid into main/cgroup.procs before enabling +memory on the parent subtree_control', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('/proc/self/cgroup')) {
        return '0::/system.slice/orchestrator.service';
      }
      if (String(p).endsWith('cgroup.controllers')) {
        return 'cpu memory io';
      }
      return '';
    });
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    setupSessionCgroup();

    const writtenPaths = writeSpy.mock.calls.map((c) => String(c[0]));
    const procsIndex = writtenPaths.findIndex((p) =>
      p.endsWith('/main/cgroup.procs'),
    );
    const subtreeControlIndex = writtenPaths.findIndex((p) =>
      p.endsWith('cgroup.subtree_control'),
    );

    expect(procsIndex).toBeGreaterThanOrEqual(0);
    expect(subtreeControlIndex).toBeGreaterThanOrEqual(0);
    expect(procsIndex).toBeLessThan(subtreeControlIndex);
  });
});

describe('placeSessionPid no-op when not set up', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('does not throw and does not touch the filesystem when the delegated subtree is unavailable', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    expect(() => placeSessionPid(1234)).not.toThrow();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes the pid to cgroup.procs once the sessions path is set up', () => {
    _setSessionsPathForTesting(
      '/sys/fs/cgroup/system.slice/orchestrator.service/sessions',
    );
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    placeSessionPid(1234);
    expect(writeSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/system.slice/orchestrator.service/sessions/cgroup.procs',
      '1234',
    );
  });
});

describe('reapplySessionCgroupLimits', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('no-ops when the delegated subtree was never set up', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    expect(() => reapplySessionCgroupLimits()).not.toThrow();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes memory.max, memory.high, and memory.swap.max when set up', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    reapplySessionCgroupLimits();
    const writtenPaths = writeSpy.mock.calls.map((c) => c[0]);
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/memory.max',
    );
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/memory.high',
    );
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/memory.swap.max',
    );
  });
});

describe('placeSessionPid with a sessionId — per-session sub-cgroup', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('creates the per-session sub-cgroup dir and writes the pid into its cgroup.procs', () => {
    _setSessionsPathForTesting(
      '/sys/fs/cgroup/system.slice/orchestrator.service/sessions',
    );
    const mkdirSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    placeSessionPid(4242, 'aaaabbbb-cccc-dddd-eeee-ffffffffffff');

    expect(mkdirSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/system.slice/orchestrator.service/sessions/aaaabbbb-cccc-dddd-eeee-ffffffffffff',
      { recursive: true },
    );
    expect(writeSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/system.slice/orchestrator.service/sessions/aaaabbbb-cccc-dddd-eeee-ffffffffffff/cgroup.procs',
      '4242',
    );
  });

  it('sanitizes a sessionId containing path-unsafe characters', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    placeSessionPid(1, '../../etc/passwd');

    const writtenPath = String(writeSpy.mock.calls[0][0]);
    expect(writtenPath).not.toContain('..');
    expect(writtenPath.startsWith('/sys/fs/cgroup/orchestrator.service/sessions/')).toBe(
      true,
    );
  });
});

describe('killSessionCgroup', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('targets a cgroup path derived from the session id, never by process name or scanning', () => {
    _setSessionsPathForTesting(
      '/sys/fs/cgroup/system.slice/orchestrator.service/sessions',
    );
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    vi.spyOn(fs, 'rmdirSync').mockImplementation(() => undefined as any);

    killSessionCgroup('aaaabbbb-cccc-dddd-eeee-ffffffffffff');

    expect(writeSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/system.slice/orchestrator.service/sessions/aaaabbbb-cccc-dddd-eeee-ffffffffffff/cgroup.kill',
      '1',
    );
  });

  it('removes the per-session sub-cgroup directory after killing it', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const rmdirSpy = vi
      .spyOn(fs, 'rmdirSync')
      .mockImplementation(() => undefined as any);

    killSessionCgroup('session-1');

    expect(rmdirSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/orchestrator.service/sessions/session-1',
    );
  });

  it('is idempotent — does not throw and does not write when the sub-cgroup is already gone', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    expect(() => killSessionCgroup('session-already-gone')).not.toThrow();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when the delegated subtree was never set up', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    expect(() => killSessionCgroup('some-session')).not.toThrow();
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('does not throw when the cgroup.kill write fails (e.g. dir raced away)', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => killSessionCgroup('session-1')).not.toThrow();
  });

  it('only ever writes under this session id — a sibling session path is untouched', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => p === '/sys/fs/cgroup/orchestrator.service/sessions/session-a',
    );
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    vi.spyOn(fs, 'rmdirSync').mockImplementation(() => undefined as any);

    killSessionCgroup('session-a');

    for (const call of writeSpy.mock.calls) {
      expect(String(call[0])).not.toContain('session-b');
    }
    expect(writeSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/orchestrator.service/sessions/session-a/cgroup.kill',
      '1',
    );
  });
});
