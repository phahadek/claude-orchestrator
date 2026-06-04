import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
}));

// We capture the args and options passed to spawn so we can assert on them.
let capturedSpawnArgs: string[] = [];
let capturedSpawnOptions: Record<string, unknown> = {};

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
  spawn: vi.fn(
    (_cmd: string, args: string[], options: Record<string, unknown>) => {
      capturedSpawnArgs = args;
      capturedSpawnOptions = options;
      return makeMockProc();
    },
  ),
  execSync: vi.fn(() => ''),
}));

import { CliSessionRunner } from '../CliSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const RESUME_ID = 'bbbbcccc-dddd-eeee-ffff-aaaaaaaaaaaa';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  capturedSpawnArgs = [];
  capturedSpawnOptions = {};
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

  it('spawn env carries BASH_MAX_OUTPUT_LENGTH=30000 and BASH_DEFAULT_TIMEOUT_MS=300000', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    const env = capturedSpawnOptions.env as Record<string, string>;
    expect(env.BASH_MAX_OUTPUT_LENGTH).toBe('30000');
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('300000');
  });

  it('includes --settings autoCompactEnabled:false when disableAutoCompact is true', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: true },
      () => {},
    );

    const settingsIdx = capturedSpawnArgs.indexOf('--settings');
    expect(settingsIdx).not.toBe(-1);
    expect(capturedSpawnArgs[settingsIdx + 1]).toBe(
      '{"autoCompactEnabled":false}',
    );
  });

  it('does not include --settings when disableAutoCompact is false', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: false },
      () => {},
    );

    expect(capturedSpawnArgs).not.toContain('--settings');
  });

  it('does not include --settings when disableAutoCompact is absent', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    await runner.run('hello', undefined, defaultOptions, () => {});

    expect(capturedSpawnArgs).not.toContain('--settings');
  });

  it('disableAutoCompact can be set independently per spawn', async () => {
    const runner1 = new CliSessionRunner(SESSION_ID);
    await runner1.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: true },
      () => {},
    );
    const argsWithDisabled = [...capturedSpawnArgs];

    const runner2 = new CliSessionRunner(SESSION_ID);
    await runner2.run(
      'hello',
      undefined,
      { ...defaultOptions, disableAutoCompact: false },
      () => {},
    );
    const argsWithEnabled = [...capturedSpawnArgs];

    expect(argsWithDisabled).toContain('--settings');
    expect(argsWithEnabled).not.toContain('--settings');
  });
});
