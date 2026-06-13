import { logger } from '../logger';
import { runtimeSettings } from '../config';
import { archiveConcludedSessionsOlderThan } from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodic sweep that auto-archives concluded sessions (status IN
 * ('done','error','killed'), archived=0) whose ended_at is older than a
 * configurable grace period. Driven by three runtimeSettings:
 *   - auto_archive_enabled: master toggle
 *   - auto_archive_grace_minutes: grace window (default 30)
 *   - auto_archive_sweep_interval_minutes: cadence (default 5)
 */
export class ConcludedSessionArchiver {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private sweepRunning = false;

  constructor(
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly options: {
      nowFn?: () => number;
      intervalMs?: number;
    } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const intervalMs =
      this.options.intervalMs ??
      (runtimeSettings.auto_archive_sweep_interval_minutes * 60 * 1000 ||
        DEFAULT_SWEEP_INTERVAL_MS);
    this.timer = setTimeout(() => {
      void this.sweepOnce().finally(() => this.scheduleNext());
    }, intervalMs);
    this.timer.unref?.();
  }

  async sweepOnce(): Promise<void> {
    if (this.sweepRunning) return;
    if (!runtimeSettings.auto_archive_enabled) return;
    this.sweepRunning = true;
    try {
      const now = this.options.nowFn ? this.options.nowFn() : Date.now();
      const cutoffMs =
        now - runtimeSettings.auto_archive_grace_minutes * 60 * 1000;

      const archivedIds = archiveConcludedSessionsOlderThan(cutoffMs);

      if (archivedIds.length === 0) return;

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
    } catch (err) {
      logger.error(`[ConcludedSessionArchiver] sweep error: ${err}`);
    } finally {
      this.sweepRunning = false;
    }
  }
}
