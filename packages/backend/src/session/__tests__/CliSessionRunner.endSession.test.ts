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

    const endPromise = runner.endSession();
    expect(lastProc!.stdin.end).toHaveBeenCalled();
    // Process honors stdin EOF and exits well within the grace period.
    lastProc!.emit('exit', 0);
    const escalated = await endPromise;

    expect(escalated).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
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
    // SIGTERM then SIGKILL, both sent to the process group (-pid).
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
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
  });
});
