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
  BACKGROUND_TASK_MAX_SILENCE_MS,
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

  it('does not force-kill while the process keeps emitting events after the result event — e.g. a live background subagent', async () => {
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

    // A background subagent keeps emitting lines well past what would have
    // been the fixed grace deadline — each line must push the deadline out
    // instead of letting the original timer fire on schedule.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS - 1000);
      lastProc!.stdout.push(
        JSON.stringify({ type: 'assistant', message: { i } }) + '\n',
      );
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(killSpy).not.toHaveBeenCalled();

    // Once the subagent finally goes quiet, the grace timer fires as usual.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', null);
    const exitCode = await runPromise;
    expect(exitCode).toBeNull();
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

  it('does not force-kill a later turn that goes quiet after a new turn starts (init event resets the latch)', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const events: Record<string, unknown>[] = [];
    const runPromise = runner.run('hello', undefined, defaultOptions, (event) =>
      events.push(event),
    );
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    // First turn finishes with a result event — same process, no exit
    // (e.g. a resumed session waiting on the next prompt over stdin).
    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // A new turn starts in the same process: the CLI emits an `init` event
    // before doing any real work.
    lastProc!.stdout.push(JSON.stringify({ type: 'init' }) + '\n');
    await vi.advanceTimersByTimeAsync(0);

    // The new turn then goes quiet for well over the grace window — e.g.
    // block-buffered stdout during a long-running tool call — without
    // emitting a further result. It must not be force-killed: the prior
    // turn's result event no longer describes this process's state.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS * 2);
    expect(killSpy).not.toHaveBeenCalled();

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 0);
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
  });

  it('resets the grace latch when sendMessage() delivers a new turn over stdin', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // Caller delivers the next turn's prompt directly over stdin (the
    // resumed-session path), rather than waiting for the CLI's own `init`
    // event — this must reset the latch just the same.
    runner.sendMessage('do the next thing');

    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS * 2);
    expect(killSpy).not.toHaveBeenCalled();

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 0);
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
  });

  it('does not force-kill past the grace window while background_tasks_changed reports a live task', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    lastProc!.stdout.push(
      JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ id: 'bg-1' }],
      }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // Total silence beyond the fixed grace window — a live background task
    // must keep the process alive instead of triggering the fixed-schedule
    // kill.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS * 2);
    expect(killSpy).not.toHaveBeenCalled();

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', 0);
    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
  });

  it('force-kills once background_tasks_changed reports the task list empty again', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    lastProc!.stdout.push(
      JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ id: 'bg-1' }],
      }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // The background task finishes — the CLI's self-correcting snapshot
    // reports an empty tasks[] array.
    lastProc!.stdout.push(
      JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
      }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // Now that no background task is live, silence beyond the grace window
    // fires the kill as usual.
    await vi.advanceTimersByTimeAsync(RESULT_EVENT_EXIT_GRACE_MS);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', null);
    const exitCode = await runPromise;
    expect(exitCode).toBeNull();
  });

  it('force-kills once BACKGROUND_TASK_MAX_SILENCE_MS elapses with a background task live and no further lines at all', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    const runPromise = runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdout.push(
      JSON.stringify({ type: 'result', is_error: false }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    lastProc!.stdout.push(
      JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ id: 'bg-1' }],
      }) + '\n',
    );
    await vi.advanceTimersByTimeAsync(0);

    // No further lines at all — the grace timer keeps re-arming on the
    // fixed cadence while the background task is live, but the ceiling
    // still bounds total silence.
    await vi.advanceTimersByTimeAsync(BACKGROUND_TASK_MAX_SILENCE_MS - 1_000);
    expect(killSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');

    lastProc!.stdout.push(null);
    lastProc!.emit('exit', null);
    const exitCode = await runPromise;
    expect(exitCode).toBeNull();
  });
});
