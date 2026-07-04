import { recordEvent } from './AuditLog';
import { logger } from '../logger';

export type ProcessFaultKind = 'uncaughtException' | 'unhandledRejection';

/**
 * Durably records a process-level fault (uncaughtException / unhandledRejection).
 * Never throws — fault-logging must not mask the original fault, since the
 * process may already be in a bad state when this runs.
 */
export function recordFault(
  kind: ProcessFaultKind,
  err: unknown,
  willShutdown: boolean,
): void {
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    recordEvent({
      event_type: 'process_fault',
      actor_type: 'system',
      payload: {
        kind,
        name: error.name,
        message: error.message,
        stack: error.stack,
        willShutdown,
      },
    });
  } catch (recordErr) {
    logger.error('[recordFault] failed to record process fault:', recordErr);
  }
}

/**
 * uncaughtException wiring: records the fault then shuts down. Shutdown
 * behavior/exit code is unchanged — recordFault failing must not prevent it.
 */
export function handleUncaughtException(
  err: Error,
  shutdown: (signal: string, exitCode?: number) => void,
): void {
  recordFault('uncaughtException', err, true);
  shutdown('uncaughtException', 1);
}

/** unhandledRejection wiring: records the fault; the process keeps running. */
export function handleUnhandledRejection(err: unknown): void {
  recordFault('unhandledRejection', err, false);
}
