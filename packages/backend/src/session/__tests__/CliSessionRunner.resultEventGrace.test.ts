import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  PLANNING_DISALLOWED_TOOLS: [],
  SCHEDULING_DISALLOWED_TOOLS: [],
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

import {
  CliSessionRunner,
  RESULT_EVENT_EXIT_GRACE_MS,
} from '../CliSessionRunner';

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
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  placeSessionPidMock.mockClear();
  killSessionCgroupMock.mockClear();
  spawnIntoSessionCgroupMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  killSpy.mockRestore();
});

describe('CliSessionRunner.run — post-result grace timeout', () => {
  it('force-kills and resolves run() when the process emits a terminal result event but never exits', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const events: Record<string, unknown>[] = [];
    const runPromise = runner.run('hello', undefined, defaultOptions, (event) =>
      events.push(event),
    );
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    // Let the readline 'line' handler run.
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: 'result', is_error: false }]);

    // Process never exits on its own after emitting result — advance past
    // the grace window, then past kill()'s own SIGTERM->SIGKILL escalation.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

    // The forced SIGKILL finally reaps the process, resolving run().
    lastProc!.stdout.push(null);
    lastProc!.emit('exit', null);
    const exitCode = await runPromise;

    expect(exitCode).toBeNull();
  });

  it('resolves null when the grace-killed process actually exits with code 143 (SIGTERM handled by the CLI)', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const events: Record<string, unknown>[] = [];
    const runPromise = runner.run('hello', undefined, defaultOptions, (event) =>
      events.push(event),
    );
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // Grace timer fires and force-kills; the CLI installs its own SIGTERM
    // handler and exits 143 rather than being reaped by SIGKILL.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 143);
    const exitCode = await runPromise;

    expect(exitCode).toBeNull();
  });

  it('resolves the real exit code (143) when the process exits on its own with no result event seen', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 143);
    const exitCode = await runPromise;

    expect(exitCode).toBe(143);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('resolves the real exit code (143) when the process exits with 143 after a result event but before the grace timer fires', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // Process exits with 143 on its own, well within the grace window —
    // the grace timer never fires, so this is the pre-existing (correct)
    // delivery-race classification, unaffected by the new flag.
    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 143);
    const exitCode = await runPromise;

    expect(exitCode).toBe(143);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('does not arm the grace timer when no result event has been seen', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'assistant', message: {} }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // No result event yet — advancing well past the grace window must not
    // trigger a kill; the process is still legitimately mid-turn.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS * 2);
    expect(killSpy).not.toHaveBeenCalled();

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 0);
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
  });

  it('clears the grace timer and does not kill when the process exits on its own after result', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // Process exits cleanly well within the grace window.
    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 0);
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    // Advancing time after the run resolved must not trigger a stray kill.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS * 2);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
