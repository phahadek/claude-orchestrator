import type { SessionManager } from '../session/SessionManager';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getTaskBackend } from '../tasks/TaskBackend';
import { getAllProjects, runtimeSettings } from '../config';
import type { ProjectConfig } from '../config';
import type { ResolvedTask } from '../notion/types';
import type { ServerMessage } from '../ws/types';
import {
  hasActiveSessionForTask,
  getPausedPrReasonForTask,
} from '../db/queries';

const READY_STATUS = '🗂️ Ready';
const CODE_TYPE = '💻 Code';
const MIN_POLL_INTERVAL_MS = 5_000;

/**
 * Backend service that polls each enabled project's milestone for Ready 💻 Code
 * tasks with no unmet dependencies and launches sessions for them, up to a
 * configurable global concurrency cap.
 *
 * Polling is async-safe: cycles never overlap. Calls into SessionManager.start()
 * use the same code path as a manual UI launch.
 */
export class AutoLauncher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = true;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly broadcast?: (msg: ServerMessage) => void,
    private readonly options: {
      /** Project lister — defaulted to getAllProjects for production. */
      listProjects?: () => ProjectConfig[];
      /** Task backend resolver — defaulted to getTaskBackend for production. */
      resolveBackend?: (projectId: string) => TaskBackend;
      /** Whether to immediately run a poll cycle when start() is called. Defaults to true. */
      pollOnStart?: boolean;
    } = {},
  ) {}

  /**
   * Begin polling. Returns immediately. The first poll runs synchronously
   * inside the start() body (after `await`) so callers can sequence it after
   * SessionManager.resumeOrphanSessions() and avoid races on this.sessions.size.
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.options.pollOnStart !== false) {
      await this.pollOnce();
    }
    this.scheduleNext();
  }

  /** Stop polling and clear any pending timer. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const interval = Math.max(
      MIN_POLL_INTERVAL_MS,
      runtimeSettings.auto_launch_poll_interval_ms,
    );
    this.timer = setTimeout(() => {
      void this.pollOnce().finally(() => this.scheduleNext());
    }, interval);
    this.timer.unref?.();
  }

  /**
   * Run a single poll cycle. Exposed for tests and for the initial in-line call
   * from start(). Guarded against overlap so a slow Notion fetch can't pile up.
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const listProjects = this.options.listProjects ?? getAllProjects;
      const projects = listProjects().filter((p) => p.autoLaunchEnabled);
      for (const project of projects) {
        try {
          await this.processProject(project);
        } catch (err) {
          console.error(`[AutoLauncher] project ${project.id} failed:`, err);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async processProject(project: ProjectConfig): Promise<void> {
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    const backend = resolveBackend(project.id);

    let milestoneId: string | null = null;
    if (backend.type === 'notion') {
      milestoneId = this.resolveMilestoneId(project);
      if (!milestoneId) {
        console.warn(
          `[AutoLauncher] project ${project.id}: no milestone configured — skipping`,
        );
        return;
      }
    }

    const milestoneTasks = await backend.fetchReadyTasks(
      milestoneId,
      backend.type === 'notion' ? true : undefined,
    );

    // Also fetch non-milestone tasks and merge into the eligible pool.
    let nonMilestoneTasks: ResolvedTask[] = [];
    const nmConfig = project.nonMilestoneSourceConfig ?? null;
    if (nmConfig) {
      try {
        nonMilestoneTasks = await backend.fetchNonMilestoneReadyTasks(
          nmConfig,
          project.id,
        );
      } catch (err) {
        console.warn(
          `[AutoLauncher] project ${project.id}: fetchNonMilestoneReadyTasks failed: ${err}`,
        );
      }
    }

    const allTasks = [...milestoneTasks, ...nonMilestoneTasks];
    const candidates = allTasks.filter((t) => this.isLaunchCandidate(t));
    if (candidates.length === 0) return;

    for (const candidate of candidates) {
      if (!this.hasCapacity()) {
        return;
      }
      // Non-milestone tasks have no milestoneId — they branch off dev directly.
      const isNonMilestone = nonMilestoneTasks.includes(candidate);
      this.launchTask(
        project,
        candidate,
        isNonMilestone ? null : milestoneId,
        isNonMilestone ? 'non_milestone' : 'milestone',
      );
    }
  }

  /**
   * Determine the milestone the launcher should poll for a project:
   * explicit `autoLaunchMilestoneId` wins; otherwise fall back to the first
   * milestone in display order with a non-empty sourceId.
   */
  private resolveMilestoneId(project: ProjectConfig): string | null {
    if (project.autoLaunchMilestoneId) return project.autoLaunchMilestoneId;
    const firstWithSource = project.boards?.find((b) => b.sourceId);
    return firstWithSource?.id ?? null;
  }

  /** Decide whether a ResolvedTask is eligible for auto-launch this cycle. */
  private isLaunchCandidate(resolved: ResolvedTask): boolean {
    const { task } = resolved;
    if (task.status !== READY_STATUS) return false;
    if (task.type !== CODE_TYPE) return false;
    // Skip if any direct or transitive Depends On entry isn't Done.
    if (resolved.blocked) return false;
    // Pause-reason metadata: when a Notion task has a non-null pause_reason
    // property, the user has explicitly held it back from auto-launch.
    const maybePauseReason = (task as { pause_reason?: string | null })
      .pause_reason;
    if (maybePauseReason != null && maybePauseReason !== '') return false;
    // Also skip if the task's most recent PR is paused (e.g. stuck_timeout)
    // so we don't relaunch a session that was force-paused.
    if (getPausedPrReasonForTask(task.id) != null) return false;
    return true;
  }

  /**
   * True when launching another session would not exceed the global cap. The
   * cap counts all live standard (non-review) sessions, including ones that
   * resumeOrphanSessions() restored at boot — this keeps the launcher from
   * racing with orphan-resume slot reservations.
   */
  private hasCapacity(): boolean {
    const cap = Math.max(0, runtimeSettings.auto_launch_concurrency);
    if (cap === 0) return false;
    const liveCodeSessions = this.countLiveCodeSessions();
    return liveCodeSessions < cap;
  }

  /** Count live (in-memory) standard sessions via SessionManager's public API. */
  private countLiveCodeSessions(): number {
    // SessionManager exposes only isAlive() publicly. We can't iterate, but the
    // launcher only needs a comparison against the cap. Fall back to a private
    // accessor: SessionManager#sessions is private, so go via the public-ish
    // sessions getter exposed for the AutoLauncher.
    return this.sessionManager.getLiveCodeSessionCount();
  }

  private launchTask(
    project: ProjectConfig,
    resolved: ResolvedTask,
    milestoneId: string | null = null,
    taskKind: 'milestone' | 'non_milestone' = 'milestone',
  ): void {
    const task = resolved.task;
    const taskUrl =
      task.notionUrl || `https://www.notion.so/${task.id.replace(/-/g, '')}`;

    // Skip if a session for this task is already active. Check both the
    // in-memory SessionManager (catches launches whose Notion status update
    // hasn't propagated back yet) and the DB (catches sessions in any
    // non-terminal state, including ones temporarily missing from memory).
    if (this.sessionManager.hasLiveSessionForTask(task.id)) return;
    if (hasActiveSessionForTask(task.id)) return;

    try {
      const sessionId = this.sessionManager.start(taskUrl, project.contextUrl, {
        projectId: project.id,
        taskName: task.title || taskUrl,
        milestoneId,
        taskKind,
      });
      console.log(
        `[AutoLauncher] launched session ${sessionId.slice(0, 8)} for task ${task.title || task.id} in project ${project.id}`,
      );
      this.broadcast?.({
        type: 'auto_launch',
        projectId: project.id,
        taskId: task.id,
        taskTitle: task.title || task.id,
        sessionId,
      });
    } catch (err) {
      console.warn(
        `[AutoLauncher] failed to launch task ${task.id} for project ${project.id}: ${(err as Error).message}`,
      );
    }
  }
}
