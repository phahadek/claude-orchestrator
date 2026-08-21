import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  PLANNING_DISALLOWED_TOOLS: [],
}));

let lastProc: ReturnType<typeof makeMockProc> | null = null;

function makeMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: Object.assign(stdin, { writable: true, end: vi.fn() }),
    pid: 4242,
    exitCode: null as number | null,
  });
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    lastProc = makeMockProc();
    return lastProc;
  }),
  execSync: vi.fn(() => ''),
}));

vi.mock('../planningScratchDir', () => ({
  createScratchDir: vi.fn(),
  removeScratchDir: vi.fn(),
  getScratchDir: vi.fn(),
}));

const {
  placeSessionPidMock,
  killSessionCgroupMock,
  spawnIntoSessionCgroupMock,
} = vi.hoisted(() => ({
  placeSessionPidMock: vi.fn(),
  killSessionCgroupMock: vi.fn(),
  spawnIntoSessionCgroupMock: vi.fn(
    (_sessionId: string, spawnFn: () => unknown) => spawnFn(),
  ),
}));
vi.mock('../sessionCgroup', () => ({
  placeSessionPid: (...args: unknown[]) => placeSessionPidMock(...args),
  killSessionCgroup: (...args: unknown[]) => killSessionCgroupMock(...args),
  spawnIntoSessionCgroup: (...args: [string, () => unknown]) =>
    spawnIntoSessionCgroupMock(...args),
}));

import { CliSessionRunner, GRACEFUL_END_TIMEOUT_MS } from '../CliSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lastProc = null;
  vi.useFakeTimers();
  // process.kill(-pgid, signal) is how killProcessTree signals the tree;
  // stub it so escalation doesn't try to signal a real process group.
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  placeSessionPidMock.mockClear();
  killSessionCgroupMock.mockClear();
  spawnIntoSessionCgroupMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  killSpy.mockRestore();
});

describe('CliSessionRunner.endSession — verify-and-escalate teardown', () => {
  it('does not escalate when the process exits promptly after stdin close', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    // Let spawn() run synchronously to completion.
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    expect(placeSessionPidMock).toHaveBeenCalledWith(4242, SESSION_ID);

    const endPromise = runner.endSession();
    expect(lastProc!.stdin.end).toHaveBeenCalled();
    // Process honors stdin EOF and exits well within the grace period.
    lastProc!.emit('exit', 0);
    const escalated = await endPromise;

    expect(escalated).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    // The cgroup backstop still runs even though the process-group kill
    // above was never needed — a daemonized grandchild can outlive a
    // cleanly-exited parent.
    expect(killSessionCgroupMock).toHaveBeenCalledWith(SESSION_ID);
  });

  it('escalates to a process-tree kill when the process does not exit within the grace period', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    const endPromise = runner.endSession();
    expect(lastProc!.stdin.end).toHaveBeenCalled();

    // Process never exits on its own — advance past the graceful-exit
    // window, then past kill()'s own SIGTERM->SIGKILL escalation window.
    await vi.advanceTimersByTimeAsync(GRACEFUL_END_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(15_000);
    // kill() only resolves once the process 'exit's; simulate the SIGKILL
    // finally reaping it.
    lastProc!.emit('exit', null);
    const escalated = await endPromise;

    expect(escalated).toBe(true);
    // SIGTERM then SIGKILL, both sent to the process group (-pid) — the
    // first, cheapest step stays in place, ahead of the cgroup backstop.
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(killSessionCgroupMock).toHaveBeenCalledWith(SESSION_ID);
    const sigkillOrder = killSpy.mock.invocationCallOrder[1];
    const cgroupOrder = killSessionCgroupMock.mock.invocationCallOrder[0];
    expect(cgroupOrder).toBeGreaterThan(sigkillOrder);
  });

  it('is a no-op when the process already exited before endSession is called', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.exitCode = 0;
    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 0);
    await runPromise;

    const escalated = await runner.endSession();

    expect(escalated).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    // The process-group kill is skipped (nothing left to signal), but the
    // cgroup backstop still runs — a daemonized grandchild of this exact
    // already-exited process is exactly the case it exists to catch.
    expect(killSessionCgroupMock).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe('CliSessionRunner — spawn keeps detached: true as the first, cheapest step', () => {
  it('spawns with detached: true on non-win32', async () => {
    const { spawn } = await import('child_process');
    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();

    expect(spawn).toHaveBeenCalledWith(
      '/fake/claude',
      expect.anything(),
      expect.objectContaining({ detached: true }),
    );
  });
});

describe('CliSessionRunner.kill — cgroup backstop wiring', () => {
  it('runs the cgroup backstop after the process-group kill when the process is live', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    const killPromise = runner.kill();
    lastProc!.emit('exit', null);
    await killPromise;

    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(killSessionCgroupMock).toHaveBeenCalledWith(SESSION_ID);
  });

  it('still runs the cgroup backstop when kill() is called after the process already exited', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.exitCode = 0;
    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 0);
    await runPromise;

    await runner.kill();

    expect(killSpy).not.toHaveBeenCalled();
    expect(killSessionCgroupMock).toHaveBeenCalledWith(SESSION_ID);
  });
});

describe('CliSessionRunner — Windows branch unchanged', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses taskkill /T /F instead of process.kill on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { execSync } = await import('child_process');

    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    const killPromise = runner.kill();
    lastProc!.emit('exit', null);
    await killPromise;

    expect(execSync).toHaveBeenCalledWith(
      'taskkill /pid 4242 /T /F',
      expect.anything(),
    );
    expect(killSpy).not.toHaveBeenCalledWith(-4242, expect.anything());
  });
});
