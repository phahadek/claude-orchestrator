import { runtimeSettings, getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ResolvedTask } from '../tasks/types';
import type { ServerMessage } from '../ws/types';
import {
  getLatestCodeSessionByNotionTaskId,
  hasActiveSessionForTask,
  getPRBySessionId,
  getLocalBranchBySession,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';

const IN_PROGRESS_STATUS = '🔄 In Progress';
const READY_STATUS = '🗂️ Ready';
const DONE_STATUS = '✅ Done';
const ANTI_RACE_MS = 5 * 60 * 1000;

/**
 * Periodic sweep that detects tasks stuck at "🔄 In Progress" in Notion with no
 * corresponding live session in the DB and reverts them to "🗂️ Ready".
 *
 * This is the safety net for lifecycle bugs: even if a specific code path forgets
 * to update Notion on session death, the next sweep cycle will catch and fix it.
 *
 * Runs as a sibling to StuckSessionMonitor, sharing the auto_launch_poll_interval_ms
 * cadence so no additional timer is introduced to the system.
 */
export class OrphanedTaskSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly options: {
      listProjects?: () => ProjectConfig[];
      resolveBackend?: (projectId: string) => TaskBackend;
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
      this.options.intervalMs ?? runtimeSettings.auto_launch_poll_interval_ms;
    this.timer = setTimeout(() => {
      void this.sweepOnce().finally(() => this.scheduleNext());
    }, intervalMs);
    this.timer.unref?.();
  }

  async sweepOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const listProjects = this.options.listProjects ?? getAllProjects;
      const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
      const seen = new Set<string>();

      for (const project of listProjects()) {
        let backend: TaskBackend;
        try {
          backend = resolveBackend(project.id);
        } catch (err) {
          console.warn(
            `[OrphanedTaskSweeper] skipping project ${project.id}: ${(err as Error).message}`,
          );
          continue;
        }

        let tasks: ResolvedTask[];
        try {
          tasks = await backend.listTasksByStatus(IN_PROGRESS_STATUS);
        } catch (err) {
          console.warn(
            `[OrphanedTaskSweeper] listTasksByStatus failed for project ${project.id}: ${(err as Error).message}`,
          );
          continue;
        }

        for (const resolved of tasks) {
          const taskId = resolved.task.id;
          if (!taskId || seen.has(taskId)) continue;
          seen.add(taskId);

          try {
            await this.maybeRevertTask(taskId, project.id, backend);
          } catch (err) {
            console.warn(
              `[OrphanedTaskSweeper] revert check failed for ${taskId}: ${(err as Error).message}`,
            );
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async maybeRevertTask(
    taskId: string,
    projectId: string,
    backend: TaskBackend,
  ): Promise<void> {
    const latestSession = getLatestCodeSessionByNotionTaskId(taskId);

    if (latestSession) {
      // Skip tasks whose latest session already reached error|killed —
      // the sibling "non-zero / killed exit" fix handles those.
      if (
        latestSession.status === 'error' ||
        latestSession.status === 'killed'
      ) {
        return;
      }
      // Anti-race: skip if the most recent session started < 5 min ago.
      // This guards against a just-launched session that hasn't fully registered.
      if (Date.now() - latestSession.started_at < ANTI_RACE_MS) {
        return;
      }
    }

    // Skip if any non-terminal session exists for this task.
    if (hasActiveSessionForTask(taskId)) return;

    // Orphan confirmed: Notion shows In Progress, no live session.
    const lastSeenAt =
      latestSession?.ended_at ?? latestSession?.started_at ?? null;

    // If the task's PR is already merged or closed, mark Done rather than
    // reverting to Ready — re-dispatching a merged task would re-assign finished work.
    const prMergedOrClosed =
      latestSession !== undefined &&
      (() => {
        const pr = getPRBySessionId(latestSession.session_id);
        if (pr && (pr.state === 'merged' || pr.state === 'closed')) return true;
        const lb = getLocalBranchBySession(latestSession.session_id);
        return lb?.status === 'merged';
      })();

    const newStatus = prMergedOrClosed ? DONE_STATUS : READY_STATUS;

    await backend.updateStatus(taskId, newStatus);

    recordEvent({
      event_type: 'task_orphan_reverted',
      actor_type: 'system',
      project_id: projectId,
      task_id: taskId,
      payload: { taskId, projectId, lastSeenAt },
    });

    this.broadcast({
      type: 'task_status_changed',
      notionTaskId: taskId,
      newStatus,
    });

    console.log(
      `[OrphanedTaskSweeper] reverted orphan task ${taskId} in project ${projectId} → ${newStatus}`,
    );
  }
}
