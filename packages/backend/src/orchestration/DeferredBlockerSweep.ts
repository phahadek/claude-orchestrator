import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import { getAllBoardCacheTasks } from '../db/queries';
import type { CachedBoardTaskEntry } from '../db/queries';
import { normalizeBoardId } from '../tasks/taskId';
import { recordEvent, hasDeferredBlockerSurfacedEvent } from '../audit/AuditLog';

const TERMINAL_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);
const DEFERRED_STATUS = '⏭️ Deferred';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Periodic catch-all for a task whose Depends On names an already-⏭️-Deferred
 * task. TaskWriteCommands.surfaceDependentsOfDeferredTask (see
 * task_deferred_blocks_dependents) only fires on a *future*
 * task.setStatus → Deferred transition — it never sees a task that was
 * already Deferred with a live dependent before that hook shipped, or a case
 * the write path otherwise missed (e.g. a break-glass Notion edit).
 *
 * This sweep scans every cached board task at a non-terminal, non-Done
 * status with at least one dependsOn entry, resolves each dependency's
 * status, and for any dependency at ⏭️ Deferred records the same
 * task_deferred_blocks_dependents audit event the write-path hook writes —
 * deduplicated via hasDeferredBlockerSurfacedEvent so the same
 * (deferredTaskId, dependentTaskId) pair is not re-surfaced every cycle.
 * Detection only: this never writes task status or dependsOn.
 */
export class DeferredBlockerSweep {
  constructor(
    private readonly options: {
      listBoardTasks?: () => CachedBoardTaskEntry[];
      intervalMs?: number;
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'deferred_blocker_sweep',
      intervalMs: () => this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        this.scanOnce();
      },
    });
  }

  scanOnce(): void {
    const listBoardTasks = this.options.listBoardTasks ?? getAllBoardCacheTasks;
    const boardTasks = listBoardTasks();
    if (boardTasks.length === 0) return;

    const byNormId = new Map<string, CachedBoardTaskEntry>();
    for (const task of boardTasks) {
      byNormId.set(normalizeBoardId(task.id), task);
    }

    for (const task of boardTasks) {
      if (TERMINAL_STATUSES.has(task.status)) continue;
      if (task.dependsOn.length === 0) continue;

      for (const depId of task.dependsOn) {
        const dep = byNormId.get(normalizeBoardId(depId));
        if (!dep) continue;
        if (dep.status !== DEFERRED_STATUS) continue;

        try {
          this.surface(dep.id, task.id);
        } catch (err) {
          logger.warn(
            `[DeferredBlockerSweep] surface failed for ${task.id} blocked by ${dep.id}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  private surface(deferredTaskId: string, dependentTaskId: string): void {
    if (hasDeferredBlockerSurfacedEvent(deferredTaskId, dependentTaskId)) {
      return;
    }

    recordEvent({
      event_type: 'task_deferred_blocks_dependents',
      actor_type: 'system',
      task_id: deferredTaskId,
      payload: {
        deferredTaskId,
        dependentTaskIds: [dependentTaskId],
      },
    });

    logger.warn(
      `[DeferredBlockerSweep] task ${dependentTaskId} blocked by already-Deferred ${deferredTaskId} — surfaced`,
    );
  }
}
