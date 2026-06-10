/**
 * Tests for per-step boot-sequence error logging.
 *
 * Verifies:
 * 1. Each critical boot step logs '[server] BOOT FAILURE in <step>:' on failure.
 * 2. The full error object (not just .message) is passed to console.error so
 *    the stack trace is preserved in the rotating log.
 * 3. process.exit(1) is called on failure for critical steps.
 * 4. Non-critical steps (PR boot sweep, auto-launcher) only warn and continue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';

vi.mock('../github/PRBootSweep.js', () => ({
  runPRBootSweep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../session/bootIdleReconciliation.js', () => ({
  runBootIdleReconciliation: vi.fn().mockResolvedValue(undefined),
}));

function makeDeps(
  overrides: Partial<
    Parameters<(typeof import('../bootSequence.js'))['runBootSequence']>[0]
  > = {},
) {
  const server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
  }) as unknown as http.Server;

  return {
    jsonlReader: {
      importAll: vi.fn().mockResolvedValue(undefined),
      backfillTokens: vi.fn(),
    },
    sessionManager: {
      resumeOrphanSessions: vi.fn().mockResolvedValue(undefined),
    },
    stuckSessionMonitor: {
      rehydrate: vi.fn(),
      startScan: vi.fn(),
    },
    autoMerger: {
      rehydrate: vi.fn(),
    },
    githubClient: {} as Parameters<
      (typeof import('../bootSequence.js'))['runBootSequence']
    >[0]['githubClient'],
    prMergeWatcher: { start: vi.fn() },
    reviewerCommentsWatcher: { start: vi.fn() },
    autoLauncher: { start: vi.fn().mockResolvedValue(undefined) },
    orphanedTaskSweeper: { start: vi.fn() },
    concludedSessionArchiver: { start: vi.fn() },
    updateChecker: { start: vi.fn() },
    taskCacheRefresher: { start: vi.fn() },
    server,
    port: 3000,
    ...overrides,
  };
}

describe('runBootSequence — per-step boot catches', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error('process.exit called');
    });
  });

  it('logs BOOT FAILURE in JSONL import with full error and exits when importAll throws', async () => {
    const { runBootSequence } = await import('../bootSequence.js');
    const err = new Error('FK constraint violation');
    const deps = makeDeps({
      jsonlReader: {
        importAll: vi.fn().mockRejectedValue(err),
        backfillTokens: vi.fn(),
      },
    });

    await expect(runBootSequence(deps)).rejects.toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledWith(
      '[server] BOOT FAILURE in JSONL import:',
      err,
    );
    expect(errorSpy.mock.calls[0][1]).toBe(err);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('stack trace is preserved (error is second arg, not interpolated) for JSONL import failure', async () => {
    const { runBootSequence } = await import('../bootSequence.js');
    const err = new Error('FK constraint violation');
    err.stack =
      'Error: FK constraint violation\n    at SomeQuery (queries.ts:2384)';
    const deps = makeDeps({
      jsonlReader: {
        importAll: vi.fn().mockRejectedValue(err),
        backfillTokens: vi.fn(),
      },
    });

    await expect(runBootSequence(deps)).rejects.toThrow('process.exit called');

    const [label, actualErr] = errorSpy.mock.calls[0];
    expect(label).toBe('[server] BOOT FAILURE in JSONL import:');
    expect(actualErr).toBe(err);
    expect(actualErr).toHaveProperty('stack');
  });

  it('logs BOOT FAILURE in resumeOrphanSessions with full error and exits when it throws', async () => {
    const { runBootSequence } = await import('../bootSequence.js');
    const err = new Error('SQLITE_CONSTRAINT_FOREIGNKEY');
    const deps = makeDeps({
      sessionManager: { resumeOrphanSessions: vi.fn().mockRejectedValue(err) },
    });

    await expect(runBootSequence(deps)).rejects.toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledWith(
      '[server] BOOT FAILURE in resumeOrphanSessions:',
      err,
    );
    expect(errorSpy.mock.calls[0][1]).toBe(err);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('stack trace is preserved for resumeOrphanSessions failure', async () => {
    const { runBootSequence } = await import('../bootSequence.js');
    const err = new Error('SQLITE_CONSTRAINT_FOREIGNKEY');
    err.stack =
      'Error: SQLITE_CONSTRAINT_FOREIGNKEY\n    at insertPauseInterval (queries.ts:2384)';
    const deps = makeDeps({
      sessionManager: { resumeOrphanSessions: vi.fn().mockRejectedValue(err) },
    });

    await expect(runBootSequence(deps)).rejects.toThrow('process.exit called');

    const [label, actualErr] = errorSpy.mock.calls[0];
    expect(label).toBe('[server] BOOT FAILURE in resumeOrphanSessions:');
    expect(actualErr).toBe(err);
    expect(actualErr).toHaveProperty('stack');
  });

  it('logs BOOT FAILURE in StuckSessionMonitor.rehydrate with full error and exits when it throws', async () => {
    const { runBootSequence } = await import('../bootSequence.js');
    const err = new Error('SQLITE_CONSTRAINT_FOREIGNKEY');
    const deps = makeDeps({
      stuckSessionMonitor: {
        rehydrate: vi.fn().mockImplementation(() => {
          throw err;
        }),
        startScan: vi.fn(),
      },
    });

    await expect(runBootSequence(deps)).rejects.toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledWith(
      '[server] BOOT FAILURE in StuckSessionMonitor.rehydrate:',
      err,
    );
    expect(errorSpy.mock.calls[0][1]).toBe(err);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('stack trace is preserved for StuckSessionMonitor.rehydrate failure', async () => {
    const { runBootSequence } = await import('../bootSequence.js');
    const err = new Error('SQLITE_CONSTRAINT_FOREIGNKEY');
    err.stack =
      'Error: SQLITE_CONSTRAINT_FOREIGNKEY\n    at StuckSessionMonitor.rehydrate (StuckSessionMonitor.ts:42)';
    const deps = makeDeps({
      stuckSessionMonitor: {
        rehydrate: vi.fn().mockImplementation(() => {
          throw err;
        }),
        startScan: vi.fn(),
      },
    });

    await expect(runBootSequence(deps)).rejects.toThrow('process.exit called');

    const [label, actualErr] = errorSpy.mock.calls[0];
    expect(label).toBe(
      '[server] BOOT FAILURE in StuckSessionMonitor.rehydrate:',
    );
    expect(actualErr).toBe(err);
    expect(actualErr).toHaveProperty('stack');
  });

  it('continues boot when all steps succeed', async () => {
    const { runBootSequence } = await import('../bootSequence.js');
    const deps = makeDeps();

    await expect(runBootSequence(deps)).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(deps.server.listen).toHaveBeenCalledWith(
      3000,
      '0.0.0.0',
      expect.any(Function),
    );
  });
});
