import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('../../config', () => ({
  config: { claudePath: '/fake/claude' },
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  PLANNING_DISALLOWED_TOOLS: [],
}));

let lastProc: ReturnType<typeof makeMockProc> | null = null;

function makeMockProc(writable = true) {
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
    stdin: Object.assign(stdin, { writable, end: vi.fn() }),
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

import { CliSessionRunner } from '../CliSessionRunner';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

const defaultOptions = {
  worktreePath: '/fake/worktree',
  model: undefined as string | undefined,
  allowedTools: ['Bash'],
};

beforeEach(() => {
  lastProc = null;
});

describe('CliSessionRunner.sendMessage — reports whether the write actually reached the process', () => {
  it('returns true and writes to stdin when the pipe is writable', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    const writeSpy = vi.spyOn(lastProc!.stdin, 'write');
    const delivered = runner.sendMessage('follow-up');

    expect(delivered).toBe(true);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining('follow-up'),
    );
  });

  it('returns false without attempting a write when stdin is not writable (closed pipe)', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    lastProc!.stdin.writable = false;
    const writeSpy = vi.spyOn(lastProc!.stdin, 'write');

    const delivered = runner.sendMessage('follow-up');

    expect(delivered).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('returns false when a synchronous stdin.write() throw occurs, instead of only logging it', async () => {
    const runner = new CliSessionRunner(SESSION_ID);
    void runner.run('hello', undefined, defaultOptions, () => {});
    await Promise.resolve();
    expect(lastProc).not.toBeNull();

    vi.spyOn(lastProc!.stdin, 'write').mockImplementation(() => {
      throw new Error('EPIPE: write after end');
    });

    const delivered = runner.sendMessage('follow-up');

    expect(delivered).toBe(false);
  });

  it('returns false when the process was never started (no proc)', () => {
    const runner = new CliSessionRunner(SESSION_ID);

    const delivered = runner.sendMessage('follow-up');

    expect(delivered).toBe(false);
  });
});
