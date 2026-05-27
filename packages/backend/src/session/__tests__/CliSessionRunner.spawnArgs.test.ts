import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
}));

// We capture the args passed to spawn so we can assert on them.
let capturedSpawnArgs: string[] = [];

function makeMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
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
    capturedSpawnArgs = args;
    return makeMockProc();
  }),
  execSync: vi.fn(() => ''),
}));

import { CliSessionRunner } from '../CliSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const RESUME_ID  = 'bbbbcccc-dddd-eeee-ffff-aaaaaaaaaaaa';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  capturedSpawnArgs = [];
  vi.clearAllMocks();
});

describe('CliSessionRunner spawn args', () => {
  it('initial spawn includes --session-id <sessionId> and not --resume', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    expect(capturedSpawnArgs).toContain('--session-id');
    expect(capturedSpawnArgs).toContain(SESSION_ID);
    expect(capturedSpawnArgs).not.toContain('--resume');
    // --session-id must immediately precede SESSION_ID
    const idx = capturedSpawnArgs.indexOf('--session-id');
    expect(capturedSpawnArgs[idx + 1]).toBe(SESSION_ID);
  });

  it('resume spawn includes --resume <resumeSessionId> and not --session-id', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(undefined, RESUME_ID, defaultOptions, () => {});

    expect(capturedSpawnArgs).toContain('--resume');
    expect(capturedSpawnArgs).toContain(RESUME_ID);
    expect(capturedSpawnArgs).not.toContain('--session-id');
    const idx = capturedSpawnArgs.indexOf('--resume');
    expect(capturedSpawnArgs[idx + 1]).toBe(RESUME_ID);
  });
});
