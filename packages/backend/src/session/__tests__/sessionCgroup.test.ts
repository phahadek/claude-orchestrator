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
    test_run_io_max_wbps: 100 * 1024 * 1024,
    test_run_io_weight: 50,
  },
}));

vi.mock('../../db/queries', () => ({
  getTestRequestRunById: vi.fn(),
  getSession: vi.fn(),
  TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED: new Set([
    'done',
    'error',
    'killed',
    'superseded',
  ]),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import fs from 'fs';
import { runtimeSettings } from '../../config';
import { logger } from '../../logger';
import { recordEvent } from '../../audit/AuditLog';
import { getTestRequestRunById, getSession } from '../../db/queries';
import {
  computeSessionCgroupLimits,
  computeSessionCgroupIoLimits,
  resolveBlockDevice,
  formatIoMaxLine,
  setupSessionCgroup,
  placeSessionPid,
  killSessionCgroup,
  reapplySessionCgroupLimits,
  spawnIntoSessionCgroup,
  spawnIntoTestRunCgroup,
  killTestRunCgroup,
  isTestRunCgroupEmpty,
  removeTestRunCgroup,
  reapOrphanedMainCgroupProcesses,
  reapOrphanedTestsCgroupProcesses,
  reapTestsCgroupOrphans,
  _resetForTesting,
  _setSessionsPathForTesting,
  _setTestsPathForTesting,
  _setMainPathForTesting,
  _setIoControllerAvailableForTesting,
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

describe('resolveBlockDevice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decodes major:minor from a bigint dev_t using glibc gnu_dev encoding', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ dev: 64512n } as any);
    expect(resolveBlockDevice('/some/path')).toBe('252:0');
  });

  it('returns null when the path cannot be stat-ed', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(resolveBlockDevice('/missing')).toBeNull();
  });
});

describe('formatIoMaxLine', () => {
  it('formats a device and byte ceiling as an io.max wbps= line', () => {
    expect(formatIoMaxLine('252:0', 104857600)).toBe('252:0 wbps=104857600');
  });
});

describe('computeSessionCgroupIoLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the device and carries the configured ceiling and weight through', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ dev: 64512n } as any);
    const limits = computeSessionCgroupIoLimits({
      worktreePath: '/repo',
      maxWbps: 104857600,
      weight: 50,
    });
    expect(limits).toEqual({
      device: '252:0',
      maxWbpsBytes: 104857600,
      weight: 50,
    });
  });

  it('disables the write ceiling when maxWbps is 0, even if the device resolves', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ dev: 64512n } as any);
    const limits = computeSessionCgroupIoLimits({
      worktreePath: '/repo',
      maxWbps: 0,
      weight: 50,
    });
    expect(limits.maxWbpsBytes).toBe(0);
    expect(limits.device).toBe('252:0');
  });

  it('carries a null device through when resolution fails', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const limits = computeSessionCgroupIoLimits({
      worktreePath: '/missing',
      maxWbps: 104857600,
      weight: 50,
    });
    expect(limits.device).toBeNull();
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

  it('also writes memory.max/high/swap.max to the tests/ leaf when it is set up', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    reapplySessionCgroupLimits();
    const writtenPaths = writeSpy.mock.calls.map((c) => c[0]);
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/tests/memory.max',
    );
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/tests/memory.high',
    );
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/tests/memory.swap.max',
    );
  });

  it('also writes io.max and io.weight alongside memory.max when the io controller is available', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    _setIoControllerAvailableForTesting(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ dev: 64512n } as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    reapplySessionCgroupLimits();
    const writtenPaths = writeSpy.mock.calls.map((c) => c[0]);
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/io.max',
    );
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/io.weight',
    );
    const ioMaxCall = writeSpy.mock.calls.find(
      (c) => c[0] === '/sys/fs/cgroup/orchestrator.service/sessions/io.max',
    );
    expect(ioMaxCall?.[1]).toBe('252:0 wbps=104857600');
    const ioWeightCall = writeSpy.mock.calls.find(
      (c) => c[0] === '/sys/fs/cgroup/orchestrator.service/sessions/io.weight',
    );
    expect(ioWeightCall?.[1]).toBe('50');
  });

  it('does not write io.max/io.weight when the io controller is unavailable', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    _setIoControllerAvailableForTesting(false);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    reapplySessionCgroupLimits();
    const writtenPaths = writeSpy.mock.calls.map((c) => c[0]);
    expect(writtenPaths).not.toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/io.max',
    );
    expect(writtenPaths).not.toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/io.weight',
    );
    // memory limits must still be applied — io is best-effort only.
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/orchestrator.service/sessions/memory.max',
    );
  });

  it('resets io.max to wbps=max (rather than skipping the write) when the ceiling setting is toggled to 0', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    _setIoControllerAvailableForTesting(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ dev: 64512n } as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);
    const original = runtimeSettings.test_run_io_max_wbps;
    runtimeSettings.test_run_io_max_wbps = 0;
    try {
      reapplySessionCgroupLimits();
    } finally {
      runtimeSettings.test_run_io_max_wbps = original;
    }
    const ioMaxCall = writeSpy.mock.calls.find(
      (c) => c[0] === '/sys/fs/cgroup/orchestrator.service/sessions/io.max',
    );
    expect(ioMaxCall?.[1]).toBe('252:0 wbps=max');
  });

  it('tolerates io.max/io.weight write failures without throwing or blocking memory limits', () => {
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    _setIoControllerAvailableForTesting(true);
    vi.spyOn(fs, 'statSync').mockReturnValue({ dev: 64512n } as any);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p) => {
      if (String(p).endsWith('io.max') || String(p).endsWith('io.weight')) {
        throw new Error('ENOENT: no such file');
      }
    });
    expect(() => reapplySessionCgroupLimits()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
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
    expect(
      writtenPath.startsWith('/sys/fs/cgroup/orchestrator.service/sessions/'),
    ).toBe(true);
  });
});

describe('spawnIntoSessionCgroup', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('relocates the backend into the session cgroup before spawnFn runs, so a forked child resolves to the session path, not main', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    let observedCgroupDuringSpawn: string | null = null;
    const result = spawnIntoSessionCgroup('session-xyz', () => {
      // Simulate the OS resolving the *would-be* fork-time cgroup of a
      // child spawned right now: whichever cgroup.procs write the backend
      // most recently issued for its own pid.
      const lastOwnPidWrite = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .reverse()
        .find((p) => p.endsWith('cgroup.procs'));
      observedCgroupDuringSpawn = lastOwnPidWrite ?? null;
      return 'spawned-child';
    });

    expect(result).toBe('spawned-child');
    expect(observedCgroupDuringSpawn).toBe(
      '/sys/fs/cgroup/orchestrator.service/sessions/session-xyz/cgroup.procs',
    );
    expect(observedCgroupDuringSpawn).not.toContain('/main/');
  });

  it('restores the backend to main/ after spawnFn returns, even when spawnFn throws', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    expect(() =>
      spawnIntoSessionCgroup('session-xyz', () => {
        throw new Error('spawn failed');
      }),
    ).toThrow('spawn failed');

    const lastWrite = String(
      writeSpy.mock.calls[writeSpy.mock.calls.length - 1][0],
    );
    expect(lastWrite).toBe(
      '/sys/fs/cgroup/orchestrator.service/main/cgroup.procs',
    );
  });

  it('never leaves a window where the backend sits in main/ during spawnFn — the pre- and post-spawn writes bracket it, so no descendant forked during spawnFn can land in main', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    _setSessionsPathForTesting('/sys/fs/cgroup/orchestrator.service/sessions');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    spawnIntoSessionCgroup('session-xyz', () => 'child');

    const ownPidWrites = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.endsWith('cgroup.procs'));
    expect(ownPidWrites).toEqual([
      '/sys/fs/cgroup/orchestrator.service/sessions/session-xyz/cgroup.procs',
      '/sys/fs/cgroup/orchestrator.service/main/cgroup.procs',
    ]);
  });

  it('falls back to calling spawnFn directly (unrelocated) when the delegated subtree was never set up', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const result = spawnIntoSessionCgroup('session-xyz', () => 'child');
    expect(result).toBe('child');
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe('spawnIntoTestRunCgroup', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('relocates the backend into a per-run sub-cgroup before spawnFn runs, so a forked test-lane subprocess resolves under tests/<runId>/, not main', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    let observedCgroupDuringSpawn: string | null = null;
    const result = spawnIntoTestRunCgroup('run-xyz', () => {
      const lastOwnPidWrite = writeSpy.mock.calls
        .map((c) => String(c[0]))
        .reverse()
        .find((p) => p.endsWith('cgroup.procs'));
      observedCgroupDuringSpawn = lastOwnPidWrite ?? null;
      return 'spawned-test-child';
    });

    expect(result).toBe('spawned-test-child');
    expect(observedCgroupDuringSpawn).toBe(
      '/sys/fs/cgroup/orchestrator.service/tests/run-xyz/cgroup.procs',
    );
    expect(observedCgroupDuringSpawn).not.toContain('/main/');
  });

  it('restores the backend to main/ after spawnFn returns', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    spawnIntoTestRunCgroup('run-xyz', () => 'child');

    const ownPidWrites = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.endsWith('cgroup.procs'));
    expect(ownPidWrites).toEqual([
      '/sys/fs/cgroup/orchestrator.service/tests/run-xyz/cgroup.procs',
      '/sys/fs/cgroup/orchestrator.service/main/cgroup.procs',
    ]);
  });

  it('falls back to calling spawnFn directly (unrelocated) when the delegated subtree was never set up', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const result = spawnIntoTestRunCgroup('run-xyz', () => 'child');
    expect(result).toBe('child');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('gives two runs distinct sub-cgroups regardless of session ownership — a session-less base_health_probe/pr_pipeline run is placed the same way as a session-owned one, just keyed by its own run id', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    spawnIntoTestRunCgroup('session-owned-run', () => 'a');
    spawnIntoTestRunCgroup('session-less-run', () => 'b');

    const ownPidWrites = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .filter(
        (p) => p.endsWith('cgroup.procs') && !p.endsWith('/main/cgroup.procs'),
      );
    expect(ownPidWrites).toEqual([
      '/sys/fs/cgroup/orchestrator.service/tests/session-owned-run/cgroup.procs',
      '/sys/fs/cgroup/orchestrator.service/tests/session-less-run/cgroup.procs',
    ]);
  });

  it('sanitizes a run id containing path-unsafe characters', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    spawnIntoTestRunCgroup('../../etc/passwd', () => 'child');

    const testsLeafWrite = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .find((p) => p.startsWith('/sys/fs/cgroup/orchestrator.service/tests/'));
    expect(testsLeafWrite).not.toContain('..');
    expect(testsLeafWrite).not.toContain('/etc/passwd');
  });
});

describe('killTestRunCgroup', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('targets a cgroup path derived from the run id, never by process name or scanning', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    killTestRunCgroup('run-aaaa1111');

    expect(writeSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/orchestrator.service/tests/run-aaaa1111/cgroup.kill',
      '1',
    );
  });

  it('is a no-op returning true when the sub-cgroup is already gone', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    expect(killTestRunCgroup('run-already-gone')).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('is a no-op returning true when the delegated subtree was never set up', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    expect(killTestRunCgroup('some-run')).toBe(true);
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('returns false and does not throw when the cgroup.kill write fails', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => killTestRunCgroup('run-1')).not.toThrow();
    expect(killTestRunCgroup('run-1')).toBe(false);
  });

  it('only ever writes under this run id — a sibling run, a session, and the Remote Control slice are all untouched', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (p) => p === '/sys/fs/cgroup/orchestrator.service/tests/run-a',
    );
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    killTestRunCgroup('run-a');

    for (const call of writeSpy.mock.calls) {
      const p = String(call[0]);
      expect(p).not.toContain('run-b');
      expect(p).not.toContain('/sessions/');
      expect(p).not.toContain('remote-control');
    }
    expect(writeSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/orchestrator.service/tests/run-a/cgroup.kill',
      '1',
    );
  });
});

describe('isTestRunCgroupEmpty', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('reports empty (nothing to verify) when the delegated subtree was never set up', () => {
    expect(isTestRunCgroupEmpty('run-1')).toBe(true);
  });

  it('reports empty when the run sub-cgroup directory does not exist', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(isTestRunCgroupEmpty('run-1')).toBe(true);
  });

  it('reports non-empty when cgroup.procs still lists a pid', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('9999\n' as any);
    expect(isTestRunCgroupEmpty('run-1')).toBe(false);
  });

  it('reports empty when cgroup.procs is blank', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('' as any);
    expect(isTestRunCgroupEmpty('run-1')).toBe(true);
  });
});

describe('removeTestRunCgroup', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('removes the per-run sub-cgroup directory', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    const rmdirSpy = vi
      .spyOn(fs, 'rmdirSync')
      .mockImplementation(() => undefined as any);

    removeTestRunCgroup('run-1');

    expect(rmdirSpy).toHaveBeenCalledWith(
      '/sys/fs/cgroup/orchestrator.service/tests/run-1',
    );
  });

  it('does not throw when the directory is already gone or non-empty', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    vi.spyOn(fs, 'rmdirSync').mockImplementation(() => {
      throw new Error('ENOTEMPTY');
    });
    expect(() => removeTestRunCgroup('run-1')).not.toThrow();
  });

  it('is a no-op when the delegated subtree was never set up', () => {
    const rmdirSpy = vi.spyOn(fs, 'rmdirSync');
    expect(() => removeTestRunCgroup('run-1')).not.toThrow();
    expect(rmdirSpy).not.toHaveBeenCalled();
  });
});

describe('setupSessionCgroup creates a bounded tests/ leaf', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('creates tests/ alongside main/ and sessions/, and writes memory.swap.max = 0 to it', () => {
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
    const mkdirSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined as any);
    const writeSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => undefined);

    setupSessionCgroup();

    const mkdirPaths = mkdirSpy.mock.calls.map((c) => String(c[0]));
    expect(mkdirPaths).toContain(
      '/sys/fs/cgroup/system.slice/orchestrator.service/tests',
    );

    const writtenPaths = writeSpy.mock.calls.map((c) => String(c[0]));
    expect(writtenPaths).toContain(
      '/sys/fs/cgroup/system.slice/orchestrator.service/tests/memory.swap.max',
    );
    const swapMaxCall = writeSpy.mock.calls.find(
      (c) =>
        String(c[0]) ===
        '/sys/fs/cgroup/system.slice/orchestrator.service/tests/memory.swap.max',
    );
    // runtimeSettings mock at the top of this file sets denySwap: true.
    expect(swapMaxCall?.[1]).toBe('0');
  });
});

describe('reapOrphanedMainCgroupProcesses', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('kills a pid sitting in main/ whose parent has already exited (ppid=1), and reports it as reaped', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    const killed: number[] = [];

    const reaped = reapOrphanedMainCgroupProcesses({
      ownPid: 100,
      listMainCgroupPids: () => [100, 42424],
      readPpid: (pid) => (pid === 42424 ? 1 : 100),
      kill: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([42424]);
    expect(reaped).toBe(1);
  });

  it('never kills the backend itself, even if somehow its own ppid resolved to 1', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    const killed: number[] = [];

    reapOrphanedMainCgroupProcesses({
      ownPid: 100,
      listMainCgroupPids: () => [100],
      readPpid: () => 1,
      kill: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([]);
  });

  it('leaves a pid alone whose parent is still alive (not re-parented to init)', () => {
    _setMainPathForTesting('/sys/fs/cgroup/orchestrator.service/main');
    const killed: number[] = [];

    const reaped = reapOrphanedMainCgroupProcesses({
      ownPid: 100,
      listMainCgroupPids: () => [100, 555],
      readPpid: (pid) => (pid === 555 ? 100 : 100),
      kill: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([]);
    expect(reaped).toBe(0);
  });

  it('is a no-op when the delegated subtree was never set up', () => {
    const kill = vi.fn();
    const reaped = reapOrphanedMainCgroupProcesses({ kill });
    expect(reaped).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it('never targets a process outside …/orchestrator.service/main — e.g. a Remote Control-slice process, even one reparented to init, is never reaped', () => {
    _setMainPathForTesting(
      '/sys/fs/cgroup/system.slice/orchestrator.service/main',
    );
    const killed: number[] = [];
    // A Remote Control session process lives under a wholly separate
    // systemd slice (/system.slice/orchestrator-remote-control.service),
    // never under main/'s own cgroup.procs — the sweep only ever reads
    // pids listMainCgroupPids returns, so an RC pid can never be a
    // candidate regardless of its ppid.
    const remoteControlPid = 9999;

    reapOrphanedMainCgroupProcesses({
      ownPid: 100,
      // remoteControlPid deliberately absent — it is not a member of
      // main/'s cgroup.procs, so this list can never surface it.
      listMainCgroupPids: () => [100, 42424],
      readPpid: (pid) =>
        pid === remoteControlPid ? 1 : pid === 42424 ? 1 : 100,
      kill: (pid) => killed.push(pid),
    });

    expect(killed).not.toContain(remoteControlPid);
    expect(killed).toEqual([42424]);
  });
});

describe('reapOrphanedTestsCgroupProcesses', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  it('kills a ppid=1 process in a run directory the caller marks reapable', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    const killed: number[] = [];

    const reaped = reapOrphanedTestsCgroupProcesses(() => true, {
      ownPid: 100,
      listTestRunDirs: () => ['run-1'],
      listRunCgroupPids: (runId) => (runId === 'run-1' ? [42424] : []),
      readPpid: () => 1,
      kill: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([42424]);
    expect(reaped).toBe(1);
  });

  it('does not select a process in a run directory the caller marks not reapable', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    const killed: number[] = [];

    const reaped = reapOrphanedTestsCgroupProcesses(() => false, {
      ownPid: 100,
      listTestRunDirs: () => ['run-1'],
      listRunCgroupPids: () => [42424],
      readPpid: () => 1,
      kill: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([]);
    expect(reaped).toBe(0);
  });

  it('never selects the backend own pid, even when its ppid resolves to 1', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    const killed: number[] = [];

    reapOrphanedTestsCgroupProcesses(() => true, {
      ownPid: 100,
      listTestRunDirs: () => ['run-1'],
      listRunCgroupPids: () => [100],
      readPpid: () => 1,
      kill: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([]);
  });

  it('leaves a process alone whose parent is still alive (ppid other than 1)', () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    const killed: number[] = [];

    const reaped = reapOrphanedTestsCgroupProcesses(() => true, {
      ownPid: 100,
      listTestRunDirs: () => ['run-1'],
      listRunCgroupPids: () => [555],
      readPpid: () => 642755,
      kill: (pid) => killed.push(pid),
    });

    expect(killed).toEqual([]);
    expect(reaped).toBe(0);
  });

  it('is a no-op when the delegated tests/ subtree was never set up', () => {
    const kill = vi.fn();
    const reaped = reapOrphanedTestsCgroupProcesses(() => true, { kill });
    expect(reaped).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('reapTestsCgroupOrphans', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  function mockTestsCgroupFs(pid: number) {
    vi.spyOn(fs, 'readdirSync').mockReturnValue([
      { name: 'run-1', isDirectory: () => true },
    ] as unknown as fs.Dirent[]);
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      const pathStr = String(p);
      if (pathStr.endsWith('cgroup.procs')) return `${pid}\n`;
      if (pathStr === `/proc/${pid}/stat`) {
        return `${pid} (postgres) S 1 ${pid} ${pid} 0 -1 4194304`;
      }
      throw new Error(`unexpected read: ${pathStr}`);
    });
  }

  it('kills a ppid=1 process in the tests cgroup whose owning session row is terminal, and records an audit event naming the count', async () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    mockTestsCgroupFs(42424);
    vi.mocked(getTestRequestRunById).mockReturnValue({
      session_id: 'sess-1',
    } as any);
    vi.mocked(getSession).mockReturnValue({ status: 'killed' } as any);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const reaped = await reapTestsCgroupOrphans();

    expect(killSpy).toHaveBeenCalledWith(42424, 'SIGKILL');
    expect(reaped).toBe(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'orphan_processes_reaped',
        payload: expect.objectContaining({ reaped_count: 1 }),
      }),
    );
  });

  it('does not select a process whose owning session is non-terminal, and records no audit event', async () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    mockTestsCgroupFs(42424);
    vi.mocked(getTestRequestRunById).mockReturnValue({
      session_id: 'sess-1',
    } as any);
    vi.mocked(getSession).mockReturnValue({ status: 'running' } as any);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const reaped = await reapTestsCgroupOrphans();

    expect(killSpy).not.toHaveBeenCalled();
    expect(reaped).toBe(0);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('treats a run with no owning session as reapable', async () => {
    _setTestsPathForTesting('/sys/fs/cgroup/orchestrator.service/tests');
    mockTestsCgroupFs(42424);
    vi.mocked(getTestRequestRunById).mockReturnValue({
      session_id: null,
    } as any);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const reaped = await reapTestsCgroupOrphans();

    expect(killSpy).toHaveBeenCalledWith(42424, 'SIGKILL');
    expect(reaped).toBe(1);
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
