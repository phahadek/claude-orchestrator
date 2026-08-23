import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── fs mock (for RSS /proc reads) ─────────────────────────────────────────────

import * as fsModule from 'fs';
vi.mock('fs');

// ── child_process mock ────────────────────────────────────────────────────────

interface MockProc {
  stdout: { on: (e: string, cb: (d: Buffer) => void) => void } | null;
  stderr: { on: (e: string, cb: (d: Buffer) => void) => void } | null;
  pid: number;
  on: (e: string, cb: (...args: unknown[]) => void) => void;
}

type SpawnHook = (cmd: string, opts: unknown) => MockProc;
let _spawnHook: SpawnHook | null = null;

vi.mock('child_process', () => ({
  spawn: (cmd: string, opts: unknown): MockProc => {
    if (_spawnHook) return _spawnHook(cmd, opts);
    return makeProc(0, 'ok');
  },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function makeProc(
  exitCode: number,
  stdout = '',
  stderr = '',
  delayMs = 0,
  signal: string | null = null,
): MockProc {
  const closeCbs: Array<(c: number | null, s: string | null) => void> = [];
  const outCbs: Array<(d: Buffer) => void> = [];
  const errCbs: Array<(d: Buffer) => void> = [];

  const proc: MockProc = {
    pid: 1234,
    stdout: {
      on: (e, cb) => {
        if (e === 'data') outCbs.push(cb);
      },
    },
    stderr: {
      on: (e, cb) => {
        if (e === 'data') errCbs.push(cb);
      },
    },
    on: (e, cb) => {
      if (e === 'close')
        closeCbs.push(cb as (c: number | null, s: string | null) => void);
    },
  };

  setTimeout(() => {
    if (stdout) outCbs.forEach((cb) => cb(Buffer.from(stdout)));
    if (stderr) errCbs.forEach((cb) => cb(Buffer.from(stderr)));
    closeCbs.forEach((cb) => cb(exitCode, signal));
  }, delayMs);

  return proc;
}

// ── subject ───────────────────────────────────────────────────────────────────

import {
  runTestCommands,
  collapseProgressRuns,
  truncateForDelivery,
  TEARDOWN_VERIFY_RETRY_MS,
} from '../test-runner';
import {
  _setTestsPathForTesting,
  _setMainPathForTesting,
  _resetForTesting,
} from '../sessionCgroup';

/**
 * A proc whose stdout streams once (after listeners attach) but that never
 * fires 'close' — mirrors a runner that keeps printing past the per-command
 * timeout, so the only way it settles is via the timeout branch.
 */
function makeNonClosingStreamingProc(stdout: string): MockProc {
  const outCbs: Array<(d: Buffer) => void> = [];
  const proc: MockProc = {
    pid: 1234,
    stdout: {
      on: (e, cb) => {
        if (e === 'data') outCbs.push(cb);
      },
    },
    stderr: { on: () => {} },
    on: () => {},
  };
  setTimeout(() => {
    outCbs.forEach((cb) => cb(Buffer.from(stdout)));
  }, 0);
  return proc;
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  _spawnHook = null;
  vi.mocked(fsModule.readFileSync).mockReturnValue('' as unknown as Buffer);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runTestCommands — empty commands', () => {
  it('returns passed:true and empty output without spawning anything', async () => {
    const spawned: string[] = [];
    _spawnHook = (cmd) => {
      spawned.push(cmd as string);
      return makeProc(0);
    };

    const result = await runTestCommands('/worktree', [], 300, () => {});

    expect(result.passed).toBe(true);
    expect(result.output).toBe('');
    expect(spawned).toHaveLength(0);
  });
});

describe('runTestCommands — successful commands', () => {
  it('returns passed:true when all commands exit 0', async () => {
    _spawnHook = () => makeProc(0, 'test output');

    const promise = runTestCommands('/worktree', ['npm test'], 300, () => {});
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(true);
    expect(result.output).toContain('test output');
  });

  it('captures stdout and stderr in output', async () => {
    _spawnHook = () => makeProc(0, 'stdout-line', 'stderr-line');

    const promise = runTestCommands('/worktree', ['npm test'], 300, () => {});
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.output).toContain('stdout-line');
    expect(result.output).toContain('stderr-line');
  });

  it('runs commands in the given worktree cwd', async () => {
    const capturedOpts: unknown[] = [];
    _spawnHook = (_cmd, opts) => {
      capturedOpts.push(opts);
      return makeProc(0);
    };

    const promise = runTestCommands('/my/worktree', ['echo hi'], 300, () => {});
    await vi.runAllTimersAsync();
    await promise;

    expect(capturedOpts[0]).toMatchObject({ cwd: '/my/worktree' });
  });
});

describe('runTestCommands — failing commands', () => {
  it('returns passed:false when a command exits non-zero', async () => {
    _spawnHook = () => makeProc(1, '', 'test failed');

    const promise = runTestCommands('/worktree', ['npm test'], 300, () => {});
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.output).toContain('test failed');
  });

  it('runs all commands even when one fails, combining output', async () => {
    let callCount = 0;
    _spawnHook = () => {
      callCount++;
      return makeProc(callCount === 1 ? 1 : 0, `cmd${callCount}`);
    };

    const promise = runTestCommands(
      '/worktree',
      ['cmd1', 'cmd2'],
      300,
      () => {},
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(2);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('cmd1');
    expect(result.output).toContain('cmd2');
  });
});

describe('runTestCommands — timeout', () => {
  it('marks a timed-out command as failed and includes TIMEOUT in output', async () => {
    _spawnHook = () => makeProc(0, 'slow', '', 9999_000);

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    // Advance past the 5s timeout plus the SIGINT grace period
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.output).toContain('TIMEOUT');
  });

  it('calls log with TIMEOUT message on timeout', async () => {
    _spawnHook = () => makeProc(0, '', '', 9999_000);

    const logs: string[] = [];
    const promise = runTestCommands('/worktree', ['slow-cmd'], 2, (m) =>
      logs.push(m),
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await promise;

    expect(logs.some((l) => l.includes('TIMEOUT'))).toBe(true);
  });
});

describe('runTestCommands — fail-fast', () => {
  it('stops after first failure when failFast is true', async () => {
    let callCount = 0;
    _spawnHook = () => {
      callCount++;
      return makeProc(callCount === 1 ? 1 : 0, `cmd${callCount}`);
    };

    const promise = runTestCommands(
      '/worktree',
      ['cmd1', 'cmd2'],
      300,
      () => {},
      { failFast: true },
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.output).not.toContain('cmd2');
  });

  it('runs all commands when failFast is false', async () => {
    let callCount = 0;
    _spawnHook = () => {
      callCount++;
      return makeProc(callCount === 1 ? 1 : 0, `cmd${callCount}`);
    };

    const promise = runTestCommands(
      '/worktree',
      ['cmd1', 'cmd2'],
      300,
      () => {},
      { failFast: false },
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBe(2);
    expect(result.passed).toBe(false);
  });

  it('stops on timeout when failFast is true', async () => {
    let callCount = 0;
    _spawnHook = (cmd) => {
      // On Windows, killProcessTree uses spawn('taskkill'); don't count those.
      if (cmd !== 'taskkill') callCount++;
      return makeProc(0, '', '', 9999_000);
    };

    const promise = runTestCommands(
      '/worktree',
      ['slow-cmd', 'second-cmd'],
      5,
      () => {},
      { failFast: true },
    );
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(callCount).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('TIMEOUT');
  });

  it('runs the second command after the first times out, when failFast is false — each command is bounded independently by its own timeout', async () => {
    let callCount = 0;
    _spawnHook = (cmd) => {
      if (cmd !== 'taskkill') callCount++;
      // First command hangs past the timeout; second returns immediately.
      return callCount === 1
        ? makeProc(0, '', '', 9999_000)
        : makeProc(0, 'cmd2');
    };

    const promise = runTestCommands(
      '/worktree',
      ['slow-cmd', 'second-cmd'],
      5,
      () => {},
      { failFast: false },
    );
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(callCount).toBe(2);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('TIMEOUT');
    expect(result.output).toContain('cmd2');
  });
});

describe('runTestCommands — RSS kill', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
      writable: true,
    });
    vi.mocked(fsModule.readFileSync).mockReturnValue(
      'Name:\tpytest\nVmRSS:\t999999 kB\n' as unknown as Buffer,
    );
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('kills process and marks failed when RSS exceeds maxRssMb', async () => {
    _spawnHook = () => makeProc(0, 'running', '', 9999_000);

    const promise = runTestCommands('/worktree', ['pytest'], 300, () => {}, {
      maxRssMb: 512,
    });
    // Advance past the 2s RSS poll interval plus the SIGINT grace period
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.output).toContain('OOM_KILL');
    expect(result.output).toContain('512 MB');
  });

  it('calls log with OOM_KILL message', async () => {
    _spawnHook = () => makeProc(0, '', '', 9999_000);

    const logs: string[] = [];
    const promise = runTestCommands(
      '/worktree',
      ['pytest'],
      300,
      (m) => logs.push(m),
      { maxRssMb: 256 },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await promise;

    expect(logs.some((l) => l.includes('OOM_KILL'))).toBe(true);
  });

  it('does not kill when RSS is within limit', async () => {
    // Return RSS well below the limit
    vi.mocked(fsModule.readFileSync).mockReturnValue(
      'VmRSS:\t1024 kB\n' as unknown as Buffer,
    );
    _spawnHook = () => makeProc(0, 'ok');

    const promise = runTestCommands('/worktree', ['pytest'], 300, () => {}, {
      maxRssMb: 512,
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(true);
  });

  it('stops after OOM_KILL when failFast is true', async () => {
    let callCount = 0;
    _spawnHook = (cmd) => {
      // On Windows, killProcessTree uses spawn('taskkill'); don't count those.
      if (cmd !== 'taskkill') callCount++;
      return makeProc(0, '', '', 9999_000);
    };

    const promise = runTestCommands(
      '/worktree',
      ['pytest', 'second-cmd'],
      300,
      () => {},
      { maxRssMb: 512, failFast: true },
    );
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await promise;

    expect(callCount).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('OOM_KILL');
  });
});

describe('runTestCommands — externally signal-killed process (host/container OOM-killer)', () => {
  it('marks oomKilled:true on an unescalated SIGKILL close even when the RSS poller is disabled (maxRssMb: 0)', async () => {
    // No maxRssMb passed — the RSS poller never starts — yet the subprocess
    // still exits via SIGKILL (the OS/container OOM-killer, not our own
    // escalate()), so this must be caught purely from the close event's
    // signal arg.
    _spawnHook = () =>
      makeProc(null as unknown as number, '', '', 0, 'SIGKILL');

    const promise = runTestCommands(
      '/worktree',
      ['npm run test -w backend'],
      300,
      () => {},
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.oomKilled).toBe(true);
    expect(result.output).toContain('SIGKILL');
  });

  it('does not mark oomKilled for an ordinary nonzero exit with no signal', async () => {
    _spawnHook = () => makeProc(1, 'failure output', '', 0, null);

    const promise = runTestCommands('/worktree', ['npm test'], 300, () => {});
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.oomKilled).toBe(false);
  });

  it('does not mark oomKilled for a non-SIGKILL signal (e.g. SIGTERM)', async () => {
    _spawnHook = () =>
      makeProc(null as unknown as number, '', '', 0, 'SIGTERM');

    const promise = runTestCommands('/worktree', ['npm test'], 300, () => {});
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.oomKilled).toBe(false);
  });
});

describe('runTestCommands — SIGINT escalation', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  function makeControllableProc(): {
    proc: MockProc;
    emitData: (s: string) => void;
    emitClose: (code: number | null) => void;
  } {
    const closeCbs: Array<(c: number | null) => void> = [];
    const outCbs: Array<(d: Buffer) => void> = [];
    const proc: MockProc = {
      pid: 1234,
      stdout: {
        on: (e, cb) => {
          if (e === 'data') outCbs.push(cb);
        },
      },
      stderr: { on: () => {} },
      on: (e, cb) => {
        if (e === 'close') closeCbs.push(cb as (c: number | null) => void);
      },
    };
    return {
      proc,
      emitData: (s: string) => outCbs.forEach((cb) => cb(Buffer.from(s))),
      emitClose: (code: number | null) => closeCbs.forEach((cb) => cb(code)),
    };
  }

  it('sends SIGINT before SIGKILL on timeout', async () => {
    const { proc } = makeControllableProc();
    _spawnHook = () => proc;

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    const signals = killSpy.mock.calls.map((c) => c[1]);
    expect(signals).toEqual(['SIGINT', 'SIGKILL']);
  });

  it('includes output emitted during the grace period in the returned output', async () => {
    const { proc, emitData } = makeControllableProc();
    _spawnHook = () => proc;

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    emitData('late output during grace period');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;

    expect(result.output).toContain('late output during grace period');
  });

  it('never sends SIGKILL to a child that exits cleanly on SIGINT', async () => {
    const { proc, emitClose } = makeControllableProc();
    _spawnHook = () => proc;

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    emitClose(130);
    const result = await promise;

    const signals = killSpy.mock.calls.map((c) => c[1]);
    expect(signals).toEqual(['SIGINT']);
    expect(result.timedOut).toBe(true);
  });

  it('SIGKILLs a child that ignores SIGINT once the grace period elapses', async () => {
    const { proc } = makeControllableProc();
    _spawnHook = () => proc;

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    const signals = killSpy.mock.calls.map((c) => c[1]);
    expect(signals).toEqual(['SIGINT', 'SIGKILL']);
  });

  it('reports timedOut:true when the child exits gracefully on SIGINT', async () => {
    const { proc, emitClose } = makeControllableProc();
    _spawnHook = () => proc;

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    emitClose(130);
    const result = await promise;

    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('performs the same SIGINT escalation on OOM and still returns oomKilled:true', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
      writable: true,
    });
    vi.mocked(fsModule.readFileSync).mockReturnValue(
      'VmRSS:\t999999 kB\n' as unknown as Buffer,
    );

    const { proc, emitClose } = makeControllableProc();
    _spawnHook = () => proc;

    const promise = runTestCommands('/worktree', ['pytest'], 300, () => {}, {
      maxRssMb: 512,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    emitClose(130);
    const result = await promise;

    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }

    const signals = killSpy.mock.calls.map((c) => c[1]);
    expect(signals).toEqual(['SIGINT']);
    expect(result.oomKilled).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('resolves exactly once when close fires during the grace period', async () => {
    const { proc, emitClose } = makeControllableProc();
    _spawnHook = () => proc;

    let resolveCount = 0;
    const promise = runTestCommands(
      '/worktree',
      ['slow-cmd'],
      5,
      () => {},
    ).then((r) => {
      resolveCount++;
      return r;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    emitClose(130);
    emitClose(130);
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(resolveCount).toBe(1);
  });
});

describe('runTestCommands — cgroup-scoped teardown verification', () => {
  const TESTS_CGROUP_PATH = '/sys/fs/cgroup/orchestrator.service/tests';

  beforeEach(() => {
    // Mock call history (e.g. rmdirSync) is not cleared between tests by
    // default — without this, an earlier test's cgroup-cleanup call would
    // leak into a later test's "was never called" assertion.
    vi.clearAllMocks();
    _setTestsPathForTesting(TESTS_CGROUP_PATH);
    // mainCgroupPath left null so spawnIntoTestRunCgroup takes its
    // unrelocated fallback path — these tests exercise kill/verify only.
    _setMainPathForTesting(null);
    vi.mocked(fsModule.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    _resetForTesting();
  });

  /**
   * Configures the cgroup.procs read to report non-empty for the first
   * `survivingReads` reads and empty thereafter — simulating a process that
   * is still alive in the run's cgroup until cgroup.kill (written by
   * killTestRunCgroup) actually reaps it, which takes a moment to be
   * reflected. RSS-poll reads of /proc/<pid>/status are left unaffected.
   */
  function mockCgroupProcsSurvivesThenClears(survivingReads: number): void {
    let cgroupReadCount = 0;
    vi.mocked(fsModule.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith('cgroup.procs')) {
        cgroupReadCount++;
        return (cgroupReadCount <= survivingReads ? '5678\n' : '') as never;
      }
      return '' as never;
    });
  }

  it('terminates a timed-out command whose child re-parented to init and escaped the process group', async () => {
    // killProcessTree's process-group signal is a no-op against this
    // escapee by construction (process.kill is mocked and has no bearing on
    // the fake cgroup.procs state) — only killTestRunCgroup's cgroup.kill
    // write, verified via isTestRunCgroupEmpty, can observe it terminate.
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    mockCgroupProcsSurvivesThenClears(1);
    _spawnHook = () => makeProc(0, '', '', 9999_000);

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(11_000 + TEARDOWN_VERIFY_RETRY_MS * 2);
    const result = await promise;

    expect(vi.mocked(fsModule.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('cgroup.kill'),
      '1',
    );
    expect(result.teardownVerificationFailed).toBe(false);
  });

  it('terminates a timed-out command whose child called setsid()', async () => {
    // Same escape shape as re-parenting from test-runner's perspective:
    // cgroup-v2 membership is orthogonal to both process group and parent
    // pid, so the verify-and-kill loop is what reaches it either way.
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    mockCgroupProcsSurvivesThenClears(2);
    _spawnHook = () => makeProc(0, '', '', 9999_000);

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(11_000 + TEARDOWN_VERIFY_RETRY_MS * 3);
    const result = await promise;

    expect(vi.mocked(fsModule.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('cgroup.kill'),
      '1',
    );
    expect(result.teardownVerificationFailed).toBe(false);
  });

  it('records a distinct outcome, not a silent success, when a process survives every teardown attempt', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    // Always reports non-empty — nothing ever reaps.
    vi.mocked(fsModule.readFileSync).mockImplementation(
      (p: unknown) =>
        (String(p).endsWith('cgroup.procs') ? '5678\n' : '') as never,
    );
    _spawnHook = () => makeProc(0, '', '', 9999_000);

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(11_000 + TEARDOWN_VERIFY_RETRY_MS * 5);
    const result = await promise;

    expect(result.teardownVerificationFailed).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('never removes the per-run cgroup dir while a process still survives in it', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    vi.mocked(fsModule.readFileSync).mockImplementation(
      (p: unknown) =>
        (String(p).endsWith('cgroup.procs') ? '5678\n' : '') as never,
    );
    _spawnHook = () => makeProc(0, '', '', 9999_000);

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(11_000 + TEARDOWN_VERIFY_RETRY_MS * 5);
    await promise;

    expect(vi.mocked(fsModule.rmdirSync)).not.toHaveBeenCalled();
  });

  it('a runner that exits cleanly within the SIGINT grace period still writes its report and is not hard-killed, and settles once its cgroup is confirmed empty', async () => {
    vi.mocked(fsModule.readFileSync).mockImplementation(
      (p: unknown) => (String(p).endsWith('cgroup.procs') ? '' : '') as never,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true as never);
    const closeCbs: Array<(c: number | null) => void> = [];
    const proc: MockProc = {
      pid: 4321,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (e, cb) => {
        if (e === 'close') closeCbs.push(cb as (c: number | null) => void);
      },
    };
    _spawnHook = () => proc;

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    closeCbs.forEach((cb) => cb(130));
    const result = await promise;

    const signals = killSpy.mock.calls.map((c) => c[1]);
    expect(signals).toEqual(['SIGINT']);
    expect(result.timedOut).toBe(true);
    expect(result.teardownVerificationFailed).toBe(false);
  });
});

describe('runTestCommands — collection-cap tail retention', () => {
  it('retains the tail of output past the collection cap, with TIMEOUT surviving', async () => {
    const noise = Array.from({ length: 60_000 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('');
    const stdout = 'HEAD_MARKER' + noise + 'TAIL_MARKER';
    _spawnHook = () => makeNonClosingStreamingProc(stdout);

    const promise = runTestCommands('/worktree', ['slow-cmd'], 5, () => {});
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await promise;

    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('TAIL_MARKER');
    expect(result.output).toContain('[test-runner] TIMEOUT');
    expect(result.output).not.toContain('HEAD_MARKER');
    expect(result.output.endsWith('[test-runner] TIMEOUT')).toBe(true);
  });

  it('delivers output below the collection cap byte-identical to raw output', async () => {
    _spawnHook = () => makeProc(0, 'small stdout content');

    const promise = runTestCommands('/worktree', ['npm test'], 300, () => {});
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.output).toBe('$ npm test\nsmall stdout content');
  });
});

describe('collapseProgressRuns', () => {
  it('collapses a long run of a repeated character and records an elided count', () => {
    const input = 'start' + '.'.repeat(5_000) + 'end';
    const collapsed = collapseProgressRuns(input);

    expect(collapsed.length).toBeLessThan(input.length);
    expect(collapsed).toContain('start');
    expect(collapsed).toContain('end');
    expect(collapsed).toMatch(/elided/);
    expect(collapsed).toContain('4999');
  });

  it('leaves short runs (below the collapse threshold) untouched', () => {
    const input = 'a....b';
    expect(collapseProgressRuns(input)).toBe(input);
  });
});

describe('runTestCommands — pytest-shaped fixture spanning both caps', () => {
  it('still delivers the failure summary after collection and delivery truncation', async () => {
    const progress = '.'.repeat(3_000);
    const noise = Array.from({ length: 60_000 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('');
    const summary =
      '\n=================== FAILURES ===================\n' +
      '_________________ test_foo _________________\n' +
      'AssertionError: assert 1 == 2\n' +
      '=============== short test summary info ===============\n' +
      'FAILED tests/test_foo.py::test_foo - AssertionError: assert 1 == 2\n';
    const stdout = progress + noise + summary;
    _spawnHook = () => makeProc(1, stdout);

    const promise = runTestCommands('/worktree', ['pytest'], 300, () => {});
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.passed).toBe(false);
    expect(result.output).toContain(
      'FAILED tests/test_foo.py::test_foo - AssertionError',
    );

    const delivered = truncateForDelivery(result.output, 8_000);
    expect(delivered).toContain(
      'FAILED tests/test_foo.py::test_foo - AssertionError',
    );
    expect(delivered.startsWith('[truncated]...')).toBe(true);
  });
});

describe('truncateForDelivery', () => {
  it('returns output unchanged when at or below the cap', () => {
    expect(truncateForDelivery('short output', 8_000)).toBe('short output');
  });

  it('retains the tail and prefixes the truncation marker when over the cap', () => {
    const output = 'A'.repeat(10) + 'B'.repeat(20);
    const result = truncateForDelivery(output, 20);

    expect(result.startsWith('[truncated]...')).toBe(true);
    expect(result.endsWith('B'.repeat(20))).toBe(true);
    expect(result).not.toContain('A');
  });
});
