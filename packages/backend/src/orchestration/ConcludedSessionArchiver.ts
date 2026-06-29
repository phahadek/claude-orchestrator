import { logger } from '../logger';
import { runtimeSettings } from '../config';
import { archiveConcludedSessionsOlderThan } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';
import type { Scheduler } from './Scheduler';

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodic sweep that auto-archives concluded sessions (status IN
 * ('done','error','killed'), archived=0) whose ended_at is older than a
 * configurable grace period. Driven by three runtimeSettings:
 *   - auto_archive_enabled: master toggle
 *   - auto_archive_grace_minutes: grace window (default 30)
 *   - auto_archive_sweep_interval_minutes: cadence (default 5)
 *
 * Cadence and reentrancy are managed by Scheduler; this class owns sweep logic only.
 */
export class ConcludedSessionArchiver {
  constructor(
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly options: {
      nowFn?: () => number;
      intervalMs?: number;
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'concluded_session_archiver',
      intervalMs: () =>
        this.options.intervalMs ??
        (runtimeSettings.auto_archive_sweep_interval_minutes * 60_000 ||
          DEFAULT_SWEEP_INTERVAL_MS),
      enabled: () => runtimeSettings.auto_archive_enabled,
      concurrency: 'skip-if-running',
      run: async () => {
        const items_processed = await this._doSweep();
        return { items_processed };
      },
    });
  }

  private async _doSweep(): Promise<number> {
    const now = this.options.nowFn ? this.options.nowFn() : Date.now();
    const cutoffMs =
      now - runtimeSettings.auto_archive_grace_minutes * 60 * 1000;

    const archivedIds = archiveConcludedSessionsOlderThan(cutoffMs);

    if (archivedIds.length === 0) return 0;

    for (const sessionId of archivedIds) {
      this.broadcast({ type: 'session_archived', sessionId });
    }

    recordEvent({
      event_type: 'sessions_auto_archived',
      actor_type: 'system',
      payload: {
        archived_count: archivedIds.length,
        session_ids: archivedIds,
      },
    });

    logger.info(
      `[ConcludedSessionArchiver] archived ${archivedIds.length} concluded session(s)`,
    );

    return archivedIds.length;
  }

  /** Public for tests: runs one sweep cycle, respecting the enabled flag. */
  async sweepOnce(): Promise<void> {
    if (!runtimeSettings.auto_archive_enabled) return;
    try {
      await this._doSweep();
    } catch (err) {
      logger.error(`[ConcludedSessionArchiver] sweep error: ${err}`);
    }
  }
}
