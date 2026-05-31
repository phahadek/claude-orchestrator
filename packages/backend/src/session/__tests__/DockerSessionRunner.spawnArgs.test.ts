import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
}));

// Capture the args passed to spawn('docker', ...) so we can assert on them.
let capturedDockerArgs: string[] = [];

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
  // Push EOF then emit exit so readline closes and run() resolves.
  setImmediate(() => {
    stdout.push(null);
    proc.emit('exit', 0);
  });
  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((_cmd: string, args: string[]) => {
    capturedDockerArgs = args;
    return makeMockProc();
  }),
  execSync: vi.fn(() => ''),
}));

import { DockerSessionRunner } from '../DockerSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const RESUME_ID = 'bbbbcccc-dddd-eeee-ffff-aaaaaaaaaaaa';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  capturedDockerArgs = [];
  vi.clearAllMocks();
});

describe('DockerSessionRunner spawn args', () => {
  it('initial spawn passes --session-id <sessionId> to claude and not --resume', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    // The docker exec args are: ['exec', '-i', containerName, claudeBin, ...claudeArgs]
    // claudeArgs start after claudeBin at index 4.
    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).toContain('--session-id');
    expect(claudeArgs).toContain(SESSION_ID);
    expect(claudeArgs).not.toContain('--resume');
    const idx = claudeArgs.indexOf('--session-id');
    expect(claudeArgs[idx + 1]).toBe(SESSION_ID);
  });

  it('resume spawn passes --resume <resumeSessionId> to claude and not --session-id', async () => {
    const runner = new DockerSessionRunner(SESSION_ID);
    await runner.run(undefined, RESUME_ID, defaultOptions, () => {});

    const claudeArgs = capturedDockerArgs.slice(4);
    expect(claudeArgs).toContain('--resume');
    expect(claudeArgs).toContain(RESUME_ID);
    expect(claudeArgs).not.toContain('--session-id');
    const idx = claudeArgs.indexOf('--resume');
    expect(claudeArgs[idx + 1]).toBe(RESUME_ID);
  });
});
