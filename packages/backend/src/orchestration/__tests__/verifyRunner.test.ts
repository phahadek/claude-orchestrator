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
import { runVerifyAsGate, tailOfLog } from '../verifyRunner';

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

describe('runVerifyAsGate() gate env scoping', () => {
  it('spawns with cacheEnv vars pointed inside the worktree when declared', async () => {
    const handlers = setupMockProc();
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const worktree = fs.mkdtempSync(
      path.join(os.tmpdir(), 'verifyrunner-cacheenv-'),
    );

    const promise = runVerifyAsGate(worktree, ['npm run lint'], undefined, {
      cacheEnv: { ESLINT_CACHE_LOCATION: '.cache/eslint' },
    });
    handlers.procHandlers['close']?.(0);
    await promise;

    const expectedPath = path.join(worktree, '.cache/eslint');
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'npm run lint',
      expect.objectContaining({
        env: expect.objectContaining({ ESLINT_CACHE_LOCATION: expectedPath }),
      }),
    );
    expect(fs.existsSync(expectedPath)).toBe(true);

    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('spawns with today\'s inherited environment when no cache_env is declared', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/repo', ['npm run lint']);
    handlers.procHandlers['close']?.(0);
    await promise;

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'npm run lint',
      expect.objectContaining({ env: process.env }),
    );
  });

  it('fails as a config failure, distinct from a code failure, on a toolchain version mismatch', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/repo', ['npm run lint'], undefined, {
      expectedToolVersions: [
        { version_command: 'eslint --version', expected: 'v9.9.9' },
      ],
    });

    // Drives the version-check subprocess (the only spawn call expected here).
    handlers.stdoutHandlers['data']?.(Buffer.from('v1.0.0'));
    handlers.procHandlers['close']?.(0);

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.isToolInfraFailure).toBe(true);
    expect(result.toolFailureReason).toContain('toolchain version mismatch');
    // The gate command itself must never be spawned once the toolchain check fails.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'eslint --version',
      expect.anything(),
    );
  });

  it('skips the toolchain check entirely when no expected version is declared', async () => {
    const handlers = setupMockProc();
    const promise = runVerifyAsGate('/repo', ['npm run lint']);
    handlers.procHandlers['close']?.(0);
    const result = await promise;

    expect(result.isToolInfraFailure).toBeUndefined();
    expect(result.passed).toBe(true);
  });
});

describe('tailOfLog()', () => {
  it('keeps the end of the log, not the head, so the two ci_failing writers agree', () => {
    const banner = 'startup banner\n' + 'plugin list\n'.repeat(100);
    const failure = 'FAILED test_the_real_failure — AssertionError\n';
    const output = banner + failure;

    // This module's own truncation (used by verifyRunner's ci_failing writer).
    const verifyRunnerExcerpt = tailOfLog(output);
    // PRMergeWatcher's ci_failing writer calls the same helper with its own cap.
    const prMergeWatcherExcerpt = tailOfLog(output, 1000);

    for (const excerpt of [verifyRunnerExcerpt, prMergeWatcherExcerpt]) {
      expect(excerpt).toContain('test_the_real_failure');
      expect(excerpt).not.toContain('startup banner');
    }
  });
});
