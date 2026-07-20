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
