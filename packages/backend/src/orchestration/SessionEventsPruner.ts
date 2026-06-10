import { db } from '../db/db';
import {
  getPruneEligibleSessions,
  getSystemEventBatch,
  pruneSystemEventBatch,
  markSessionEventsPruned,
  getEventsBySession,
  incrementTokens,
} from '../db/queries';

const BATCH_SIZE = 500;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

export class SessionEventsPruner {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private pruneRunning = false;

  constructor(
    private readonly options: {
      nowFn?: () => number;
      retentionDays?: number;
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
    const intervalMs = this.options.intervalMs ?? PRUNE_INTERVAL_MS;
    this.timer = setTimeout(() => {
      void this.pruneOnce().finally(() => this.scheduleNext());
    }, intervalMs);
    this.timer.unref?.();
  }

  async runAtBoot(): Promise<void> {
    await this.pruneOnce();
  }

  async pruneOnce(): Promise<void> {
    if (this.pruneRunning) return;
    this.pruneRunning = true;
    try {
      const now = this.options.nowFn ? this.options.nowFn() : Date.now();
      const retentionDays =
        this.options.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

      const sessions = getPruneEligibleSessions(cutoff, 1000);
      if (sessions.length === 0) return;

      let totalPruned = 0;
      for (const session of sessions) {
        const pruned = this._pruneSession(session.session_id, {
          totalInputTokens: session.total_input_tokens,
          totalOutputTokens: session.total_output_tokens,
          now,
        });
        totalPruned += pruned;
      }

      if (totalPruned > 0) {
        console.log(
          `[SessionEventsPruner] pruned ${totalPruned} system events across ${sessions.length} session(s)`,
        );
      }
    } catch (err) {
      console.error('[SessionEventsPruner] pruneOnce error:', err);
    } finally {
      this.pruneRunning = false;
    }
  }

  _pruneSession(
    sessionId: string,
    opts: {
      totalInputTokens: number;
      totalOutputTokens: number;
      now: number;
    },
  ): number {
    // Backfill tokens before pruning if session has zero token counts.
    if (opts.totalInputTokens === 0 && opts.totalOutputTokens === 0) {
      this._backfillTokensForSession(sessionId);
    }

    let afterId = 0;
    let totalUpdated = 0;

    while (true) {
      const batch = getSystemEventBatch(sessionId, afterId, BATCH_SIZE);
      if (batch.length === 0) break;

      const updates = batch.map((row) => ({
        id: row.id,
        payload: buildPruneStub(row.payload),
      }));

      pruneSystemEventBatch(updates);
      // Run incremental_vacuum after each batch to reclaim freed pages.
      db.pragma('incremental_vacuum');

      totalUpdated += batch.length;
      afterId = batch[batch.length - 1].id;

      if (batch.length < BATCH_SIZE) break;
    }

    markSessionEventsPruned(sessionId, opts.now);
    return totalUpdated;
  }

  private _backfillTokensForSession(sessionId: string): void {
    const events = getEventsBySession(sessionId);
    let totalInput = 0;
    let totalOutput = 0;
    let foundResult = false;

    for (const event of events) {
      try {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        if (payload.type === 'result') {
          const usage = payload.usage as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          if (usage) {
            totalInput = usage.input_tokens ?? 0;
            totalOutput = usage.output_tokens ?? 0;
            foundResult = true;
            break;
          }
        }
      } catch {
        /* ignore malformed payloads */
      }
    }

    if (!foundResult) {
      for (const event of events) {
        try {
          const payload = JSON.parse(event.payload) as Record<string, unknown>;
          const usage = payload.usage as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          if (usage) {
            totalInput += usage.input_tokens ?? 0;
            totalOutput += usage.output_tokens ?? 0;
          }
        } catch {
          /* ignore malformed payloads */
        }
      }
    }

    if (totalInput > 0 || totalOutput > 0) {
      incrementTokens(sessionId, totalInput, totalOutput);
    }
  }
}

/**
 * Builds a pruned stub preserving the json_extract paths used by queries.ts
 * ($.type for stuck-session detection, $.usage for token extraction).
 * text and user_message events are never passed here; only system events.
 */
export function buildPruneStub(rawPayload: string): string {
  try {
    const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
    const stub: Record<string, unknown> = { truncated: true };
    if (parsed.type !== undefined) stub.type = parsed.type;
    if (parsed.usage !== undefined) stub.usage = parsed.usage;
    return JSON.stringify(stub);
  } catch {
    return JSON.stringify({ truncated: true });
  }
}
