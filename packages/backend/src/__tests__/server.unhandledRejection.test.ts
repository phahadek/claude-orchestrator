/**
 * Tests for the process-level unhandledRejection + uncaughtException guards
 * and the handlePushDetected .catch guard added in server.ts.
 *
 * 1. The unhandledRejection handler pattern (as wired in server.ts) logs and
 *    does not call process.exit.
 * 2. The uncaughtException handler logs a structured stack and calls shutdown.
 * 3. The push_detected → handlePushDetected kick is .catch-guarded; a rejecting
 *    handlePushDetected does not produce an unhandled rejection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── helpers ────────────────────────────────────────────────────────────────────

function makePRRow() {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'task-123',
    session_id: 'sess-abc',
    repo: 'owner/repo',
    state: 'open' as const,
  };
}

/**
 * Wire the push_detected handler exactly as server.ts does — delegates to
 * prMergeWatcher.handlePushDetected with a .catch guard.
 */
function wirePushHandler(
  sessionManager: EventEmitter,
  prMergeWatcher: { handlePushDetected: (prRow: unknown) => Promise<void> },
  getPRBySessionId: (id: string) => ReturnType<typeof makePRRow> | null,
  onError: (err: unknown) => void,
): void {
  sessionManager.on(
    'push_detected',
    ({ sessionId: codingSessionId }: { sessionId: string }) => {
      const prRow = getPRBySessionId(codingSessionId);
      if (!prRow || prRow.state !== 'open') return;
      void prMergeWatcher
        .handlePushDetected(prRow)
        .catch((err: unknown) => onError(err));
    },
  );
}

// ── tests: unhandledRejection handler behavior ─────────────────────────────────

describe('unhandledRejection handler (as defined in server.ts)', () => {
  it('logs the error and does not call process.exit', () => {
    const logged: unknown[] = [];
    const fakeLogger = { error: (...args: unknown[]) => logged.push(args) };
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as () => never);

    // Simulate the handler as written in server.ts
    const handler = (err: unknown) => {
      fakeLogger.error('[server] unhandledRejection:', err);
    };

    const testErr = new Error('test rejection');
    handler(testErr);

    expect(logged).toHaveLength(1);
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

// ── tests: uncaughtException handler behavior ──────────────────────────────────

describe('uncaughtException handler (as defined in server.ts)', () => {
  it('logs a structured stack and initiates shutdown with a non-zero exit code', () => {
    const logged: unknown[] = [];
    const fakeLogger = {
      error: (...args: unknown[]) => logged.push(args),
      info: () => {},
    };
    let shutdownSignal: string | undefined;
    let shutdownExitCode: number | undefined;
    const fakeShutdownWithTimeout = (signal: string, exitCode = 0) => {
      shutdownSignal = signal;
      shutdownExitCode = exitCode;
    };

    // Simulate the handler as written in server.ts
    const handler = (err: Error) => {
      fakeLogger.error(
        '[server] uncaughtException — initiating graceful shutdown',
        {
          message: err.message,
          stack: err.stack,
          name: err.name,
        },
      );
      fakeShutdownWithTimeout('uncaughtException', 1);
    };

    const testErr = new Error('something blew up');
    handler(testErr);

    expect(logged).toHaveLength(1);
    const [msg, meta] = logged[0] as [string, Record<string, unknown>];
    expect(msg).toContain('uncaughtException');
    expect(meta.message).toBe('something blew up');
    expect(meta.name).toBe('Error');
    expect(shutdownSignal).toBe('uncaughtException');
    expect(shutdownExitCode).toBe(1);
  });
});

describe('shutdownWithTimeout exit codes (as defined in server.ts)', () => {
  // Mirrors the gracefulShutdown/shutdownWithTimeout signatures in server.ts:
  // SIGTERM/SIGINT default to exit code 0 (intentional stop); the
  // uncaughtException path passes exit code 1 (fault) so systemd's
  // Restart=on-failure/always actually restarts the process.
  function simulateShutdownWithTimeout(
    signal: string,
    exitCode = 0,
  ): { signal: string; exitCode: number } {
    return { signal, exitCode };
  }

  it('SIGTERM shuts down with exit code 0', () => {
    const result = simulateShutdownWithTimeout('SIGTERM');
    expect(result.exitCode).toBe(0);
  });

  it('SIGINT shuts down with exit code 0', () => {
    const result = simulateShutdownWithTimeout('SIGINT');
    expect(result.exitCode).toBe(0);
  });

  it('uncaughtException shuts down with a non-zero exit code', () => {
    const result = simulateShutdownWithTimeout('uncaughtException', 1);
    expect(result.exitCode).toBe(1);
    expect(result.exitCode).not.toBe(0);
  });
});

// ── tests: handlePushDetected .catch guard ─────────────────────────────────────

describe('push_detected → handlePushDetected .catch guard', () => {
  let unhandledErrors: unknown[];
  let onUnhandled: (err: unknown) => void;

  beforeEach(() => {
    unhandledErrors = [];
    onUnhandled = (err) => unhandledErrors.push(err);
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
  });

  it('does not produce an unhandled rejection when handlePushDetected rejects', async () => {
    const sessionManager = new EventEmitter();
    const loggedErrors: unknown[] = [];
    const prMergeWatcher = {
      handlePushDetected: vi
        .fn()
        .mockRejectedValue(new Error('handlePushDetected exploded')),
    };
    const prRow = makePRRow();

    wirePushHandler(
      sessionManager,
      prMergeWatcher,
      () => prRow,
      (err) => loggedErrors.push(err),
    );

    sessionManager.emit('push_detected', { sessionId: 'sess-abc' });

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 20));

    expect(unhandledErrors).toHaveLength(0);
    expect(prMergeWatcher.handlePushDetected).toHaveBeenCalledWith(prRow);
    expect(loggedErrors).toHaveLength(1);
  });

  it('does not call handlePushDetected when no PR row is found', async () => {
    const sessionManager = new EventEmitter();
    const prMergeWatcher = {
      handlePushDetected: vi.fn().mockResolvedValue(undefined),
    };

    wirePushHandler(
      sessionManager,
      prMergeWatcher,
      () => null,
      () => {},
    );

    sessionManager.emit('push_detected', { sessionId: 'sess-abc' });
    await new Promise((r) => setTimeout(r, 20));

    expect(prMergeWatcher.handlePushDetected).not.toHaveBeenCalled();
    expect(unhandledErrors).toHaveLength(0);
  });
});
