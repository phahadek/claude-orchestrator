import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
  PLANNING_DISALLOWED_TOOLS: [],
}));

let capturedExecSyncCmds: string[] = [];

const { mockCreate, mockRemove } = vi.hoisted(() => ({
  mockCreate: vi.fn(
    (projectDir: string, sessionId: string) =>
      `${projectDir}/.claude/scratch/${sessionId}`,
  ),
  mockRemove: vi.fn(),
}));

vi.mock('../planningScratchDir', () => ({
  createScratchDir: mockCreate,
  removeScratchDir: mockRemove,
}));

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
    pid: 999,
    exitCode: null as number | null,
  });
  setImmediate(() => {
    stdout.push(null);
    proc.emit('exit', 0);
  });
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => makeMockProc()),
  execSync: vi.fn((cmd: string) => {
    capturedExecSyncCmds.push(cmd);
    return '';
  }),
}));

import { DockerSessionRunner } from '../DockerSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

beforeEach(() => {
  capturedExecSyncCmds = [];
  vi.clearAllMocks();
});

function sessionRunCmd() {
  return capturedExecSyncCmds.find(
    (c) =>
      c.startsWith('docker run -d') &&
      c.includes(`--name claude-session-${SESSION_ID}`),
  );
}

describe('DockerSessionRunner checkout mount', () => {
  it('mounts a coding (non-planning) worktree read-write', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      {
        worktreePath: '/fake/worktree',
        model: undefined,
        allowedTools: ['Bash'],
      },
      () => {},
    );

    expect(mockCreate).not.toHaveBeenCalled();
    expect(sessionRunCmd()).toContain('-v "/fake/worktree:/fake/worktree"');
    expect(sessionRunCmd()).not.toContain(
      '-v "/fake/worktree:/fake/worktree:ro"',
    );
  });

  it('mounts a planning-session checkout read-write, same as coding sessions', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      {
        worktreePath: '/fake/project',
        model: undefined,
        allowedTools: ['Bash'],
        sessionType: 'groom',
      },
      () => {},
    );

    expect(mockCreate).toHaveBeenCalledWith('/fake/project', SESSION_ID);
    const cmd = sessionRunCmd();
    expect(cmd).toContain('-v "/fake/project:/fake/project"');
    expect(cmd).not.toContain('-v "/fake/project:/fake/project:ro"');
  });

  it('removes the scratch dir on session end', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      {
        worktreePath: '/fake/project',
        model: undefined,
        allowedTools: ['Bash'],
        sessionType: 'ops',
      },
      () => {},
    );

    expect(mockRemove).toHaveBeenCalledWith(
      `/fake/project/.claude/scratch/${SESSION_ID}`,
    );
  });
});
