import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.spawn before importing the module under test
const mockProc = {
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
};

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc),
}));

import { spawn } from 'child_process';
import { runVerifyAsGate } from '../verifyRunner';

type CloseCallback = (code: number | null) => void;
type DataCallback = (data: Buffer) => void;

function setupMockProc() {
  const stdoutHandlers: Record<string, DataCallback> = {};
  const stderrHandlers: Record<string, DataCallback> = {};
  const procHandlers: Record<string, CloseCallback> = {};

  mockProc.stdout.on = vi.fn((event: string, handler: DataCallback) => {
    stdoutHandlers[event] = handler;
  });
  mockProc.stderr.on = vi.fn((event: string, handler: DataCallback) => {
    stderrHandlers[event] = handler;
  });
  mockProc.on = vi.fn((event: string, handler: CloseCallback) => {
    procHandlers[event] = handler;
  });

  return { stdoutHandlers, stderrHandlers, procHandlers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runVerifyAsGate()', () => {
  it('returns { passed: true } immediately when commands list is empty', async () => {
    const result = await runVerifyAsGate('/some/path', []);
    expect(result).toEqual({ passed: true });
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('returns { passed: true } when all commands exit 0', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/repo', ['npm run lint']);

    handlers.stdoutHandlers['data']?.(Buffer.from('lint ok'));
    handlers.procHandlers['close']?.(0);

    const result = await promise;
    expect(result).toEqual({ passed: true });
  });

  it('returns { passed: false, failedCommand, truncatedOutput } when command fails', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/repo', ['npm run lint']);

    handlers.stderrHandlers['data']?.(Buffer.from('error: lint failed'));
    handlers.procHandlers['close']?.(1);

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.failedCommand).toBe('npm run lint');
    expect(result.truncatedOutput).toContain('error: lint failed');
  });

  it('stops at first failing command and does not run subsequent ones', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/repo', ['fail-cmd', 'second-cmd']);

    handlers.procHandlers['close']?.(1);

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.failedCommand).toBe('fail-cmd');
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('truncates output longer than ~750 chars to the last portion', async () => {
    const handlers = setupMockProc();
    const longOutput = 'x'.repeat(1000);
    const promise = runVerifyAsGate('/repo', ['big-output-cmd']);

    handlers.stderrHandlers['data']?.(Buffer.from(longOutput));
    handlers.procHandlers['close']?.(1);

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.truncatedOutput!.length).toBeLessThanOrEqual(750);
    expect(result.truncatedOutput).toBe(
      longOutput.slice(longOutput.length - 750),
    );
  });

  it('does not truncate output that fits within the cap', async () => {
    const handlers = setupMockProc();
    const shortOutput = 'error: something failed\n';
    const promise = runVerifyAsGate('/repo', ['short-cmd']);

    handlers.stderrHandlers['data']?.(Buffer.from(shortOutput));
    handlers.procHandlers['close']?.(1);

    const result = await promise;
    expect(result.truncatedOutput).toBe(shortOutput);
  });

  it('combines stdout and stderr in truncated output', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/repo', ['mixed-cmd']);

    handlers.stdoutHandlers['data']?.(Buffer.from('stdout part '));
    handlers.stderrHandlers['data']?.(Buffer.from('stderr part'));
    handlers.procHandlers['close']?.(1);

    const result = await promise;
    expect(result.truncatedOutput).toContain('stdout part');
    expect(result.truncatedOutput).toContain('stderr part');
  });

  it('runs each command with the provided worktreePath as cwd', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/my/worktree', ['some-cmd']);

    handlers.procHandlers['close']?.(0);

    await promise;
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'some-cmd',
      expect.objectContaining({ cwd: '/my/worktree', shell: true }),
    );
  });

  it('runs multiple passing commands sequentially', async () => {
    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      callCount++;
      const proc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      // Schedule close with exit 0 asynchronously
      setTimeout(() => {
        const closeCall = proc.on.mock.calls.find(([e]) => e === 'close');
        (closeCall?.[1] as CloseCallback)?.(0);
      }, 0);
      return proc as any;
    });

    const result = await runVerifyAsGate('/repo', ['cmd1', 'cmd2', 'cmd3']);
    expect(result).toEqual({ passed: true });
    expect(callCount).toBe(3);
  });
});
