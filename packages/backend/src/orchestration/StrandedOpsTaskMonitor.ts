import { logger } from '../logger';
import { getAllProjects } from '../config';
import type { Scheduler } from './Scheduler';
import type { ProjectConfig } from '../config';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ResolvedTask } from '../tasks/types';
import {
  getOpsJournalEntry,
  hasActiveSessionForTask,
  hasNonTerminalPlanningSessionForTask,
  hasPendingDecisionForTask,
} from '../db/queries';
import { recordEvent, hasStrandedOpsSurfacedEvent } from '../audit/AuditLog';

/** Task types this monitor watches — the two non-Code types OrphanedTaskSweeper exempts once their ops_journal advances past pending. */
const WATCHED_TYPES = new Set(['🔎 Investigation', '🔧 Operational']);

const IN_PROGRESS_STATUS = '🔄 In Progress';

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
/** Default staleness threshold: an ops_journal entry untouched this long with no pending decision is stranded, not "still working". */
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Periodic detector for a task stranded outside the only sweep that ever
 * looked at it. OrphanedTaskSweeper deliberately exempts a non-Code task
 * whose ops_journal has advanced past 'pending' — reverting a completed
 * investigation would be wrong — but that exemption is unconditional and
 * silent: nothing else on the board looks at the gap it opens.
 *
 * This monitor reports, and never reverts, a 🔎 Investigation or
 * 🔧 Operational task that is:
 *   - 🔄 In Progress
 *   - backed by a non-terminal (not 'resolved') ops_journal entry
 *   - with no live session (standard or planning) for the task
 *   - with no pending operator decision (no staged_intent in
 *     staged/needs_revision/pending_verification)
 *   - whose journal entry has not been updated in longer than the threshold
 *
 * The age threshold is what separates "legitimately waiting on the
 * operator" (never reported, however old) from "nothing exists that can
 * move this" (reported once stale). On a match it records a
 * task_ops_stranded_surfaced audit event; it never writes task status,
 * never writes ops_journal, and never dispatches a session.
 */
export class StrandedOpsTaskMonitor {
  constructor(
    private readonly options: {
      listProjects?: () => ProjectConfig[];
      resolveBackend?: (projectId: string) => TaskBackend;
      intervalMs?: number;
      /** Override staleness threshold (ms). Defaults to DEFAULT_STALE_THRESHOLD_MS. */
      staleThresholdMs?: number;
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'stranded_ops_task_monitor',
      intervalMs: () => this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.scanOnce();
      },
    });
  }

  async scanOnce(): Promise<void> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    const seen = new Set<string>();

    for (const project of listProjects()) {
      let backend: TaskBackend;
      try {
        backend = resolveBackend(project.id);
      } catch (err) {
        logger.warn(
          `[StrandedOpsTaskMonitor] skipping project ${project.id}: ${(err as Error).message}`,
        );
        continue;
      }

      let tasks: ResolvedTask[];
      try {
        tasks = await backend.listTasksByStatus(IN_PROGRESS_STATUS);
      } catch (err) {
        logger.warn(
          `[StrandedOpsTaskMonitor] listTasksByStatus failed for project ${project.id}: ${(err as Error).message}`,
        );
        continue;
      }

      for (const resolved of tasks) {
        const taskId = resolved.task.id;
        if (!taskId || seen.has(taskId)) continue;
        seen.add(taskId);

        if (!WATCHED_TYPES.has(resolved.task.type)) continue;

        try {
          this.checkTask(taskId, project.id);
        } catch (err) {
          logger.warn(
            `[StrandedOpsTaskMonitor] check failed for ${taskId}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  private checkTask(taskId: string, projectId: string): void {
    const journalEntry = getOpsJournalEntry(taskId);
    if (!journalEntry || journalEntry.state === 'resolved') return;

    // No live session — standard (shouldn't apply to ops types, but harmless
    // to check) or planning (groom/design/ops, which is how these dispatch).
    if (hasActiveSessionForTask(taskId)) return;
    if (hasNonTerminalPlanningSessionForTask(taskId)) return;

    // A genuine pending operator decision is never stale, however old.
    if (hasPendingDecisionForTask(taskId)) return;

    const updatedAtMs = Date.parse(journalEntry.updated_at);
    const ageMs = Number.isNaN(updatedAtMs) ? 0 : Date.now() - updatedAtMs;
    const staleThresholdMs =
      this.options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    if (ageMs < staleThresholdMs) return;

    // Dedup: don't re-surface the same stranded entry every cycle.
    if (hasStrandedOpsSurfacedEvent(taskId, journalEntry.updated_at)) return;

    recordEvent({
      event_type: 'task_ops_stranded_surfaced',
      actor_type: 'system',
      project_id: projectId,
      task_id: taskId,
      payload: {
        taskId,
        journalState: journalEntry.state,
        journalUpdatedAt: journalEntry.updated_at,
        ageMs,
      },
    });

    logger.warn(
      `[StrandedOpsTaskMonitor] task ${taskId} stranded at ops_journal state '${journalEntry.state}' (age ${Math.round(ageMs / 60000)}m) — surfaced, not reverted`,
    );
  }
}
