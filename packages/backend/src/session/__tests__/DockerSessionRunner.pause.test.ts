import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
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
    kill: vi.fn(),
  });
  return proc;
}

let capturedExecSyncCmds: string[] = [];

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    lastProc = makeMockProc();
    return lastProc;
  }),
  execSync: vi.fn((cmd: string) => {
    capturedExecSyncCmds.push(cmd);
    return '';
  }),
}));

import { DockerSessionRunner } from '../DockerSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  lastProc = null;
  capturedExecSyncCmds = [];
  vi.clearAllMocks();
});

describe('DockerSessionRunner.pause vs kill', () => {
  it('pause() stops the exec process but does not remove the container/proxy/network', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    const pausePromise = runner.pause();
    lastProc!.emit('exit', null);
    await pausePromise;

    expect(lastProc!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(capturedExecSyncCmds.some((c) => c.startsWith('docker rm -f'))).toBe(
      false,
    );
    expect(
      capturedExecSyncCmds.some((c) => c.startsWith('docker network rm')),
    ).toBe(false);
  });

  it('kill() stops the exec process and removes the container/proxy/network', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    const killPromise = runner.kill();
    lastProc!.emit('exit', null);
    await killPromise;

    expect(lastProc!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(
      capturedExecSyncCmds.some(
        (c) => c === `docker rm -f claude-session-${SESSION_ID}`,
      ),
    ).toBe(true);
    expect(
      capturedExecSyncCmds.some(
        (c) => c === `docker rm -f claude-session-proxy-${SESSION_ID}`,
      ),
    ).toBe(true);
    expect(
      capturedExecSyncCmds.some(
        (c) => c === `docker network rm claude-session-net-${SESSION_ID}`,
      ),
    ).toBe(true);
  });

  it('a subsequent kill() after pause() still tears down the container/network', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    const pausePromise = runner.pause();
    lastProc!.emit('exit', null);
    await pausePromise;

    capturedExecSyncCmds = [];
    const killPromise = runner.kill();
    lastProc!.emit('exit', null);
    await killPromise;

    expect(
      capturedExecSyncCmds.some(
        (c) => c === `docker rm -f claude-session-${SESSION_ID}`,
      ),
    ).toBe(true);
  });
});
