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
): MockProc {
  const closeCbs: Array<(c: number | null) => void> = [];
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
      if (e === 'close') closeCbs.push(cb as (c: number | null) => void);
    },
  };

  setTimeout(() => {
    if (stdout) outCbs.forEach((cb) => cb(Buffer.from(stdout)));
    if (stderr) errCbs.forEach((cb) => cb(Buffer.from(stderr)));
    closeCbs.forEach((cb) => cb(exitCode));
  }, delayMs);

  return proc;
}

// ── subject ───────────────────────────────────────────────────────────────────

import { runTestCommands } from '../test-runner';

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
    // Advance past the 5s timeout
    await vi.advanceTimersByTimeAsync(6_000);
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
    await vi.advanceTimersByTimeAsync(3_000);
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
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;

    expect(callCount).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('TIMEOUT');
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
    // Advance past the 2s RSS poll interval
    await vi.advanceTimersByTimeAsync(3_000);
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
    await vi.advanceTimersByTimeAsync(3_000);
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
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;

    expect(callCount).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.output).toContain('OOM_KILL');
  });
});
