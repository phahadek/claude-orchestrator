import { logger } from '../logger';
import type { SessionManager } from '../session/SessionManager';
import { WorktreeSetupError } from '../session/WorktreeSetupError';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { Scheduler } from './Scheduler';
import { getAllProjects, runtimeSettings } from '../config';
import type { ProjectConfig } from '../config';
import type { ResolvedTask } from '../notion/types';
import type { ServerMessage } from '../ws/types';
import {
  hasActiveSessionForTask,
  getPausedPrReasonForTask,
  getMergedPRForTask,
  setPauseReason,
  setTaskPauseReason,
  getTaskPauseReason,
  clearTaskPauseReason,
  clearPausedPrReasonForTask,
  resetTaskCrashCount,
  getTaskRepoAssignment,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { runWithConcurrency } from '../utils/concurrency';
import { getProjectRepos } from '../projects/ProjectService';

const READY_STATUS = '🗂️ Ready';
const DONE_STATUS = '✅ Done';
const CODE_TYPE = '💻 Code';
const MIN_POLL_INTERVAL_MS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;
const PROJECT_CONCURRENCY = 5;
const UPDATE_CONCURRENCY = 3;

export class AutoLauncherFetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoLauncherFetchTimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new AutoLauncherFetchTimeoutError(
              `${label} timed out after ${ms}ms`,
            ),
          ),
        ms,
      ),
    ),
  ]);
}

/**
 * Backend service that polls each enabled project's milestone for Ready 💻 Code
 * tasks with no unmet dependencies and launches sessions for them, up to a
 * configurable global concurrency cap.
 *
 * Polling is async-safe: cycles never overlap. Calls into SessionManager.start()
 * use the same code path as a manual UI launch.
 */
export class AutoLauncher {
  private pollLastStartedAt: number | null = null;
  private cycleCounter = 0;
  private notionUpdateAttempts = new Map<
    string,
    { count: number; nextRetryAt: number; lastError: string }
  >();
  /** Per-task in-memory cooldown for launch_failed events (separate from crash budget). */
  private launchFailedAttempts = new Map<
    string,
    { count: number; nextRetryAt: number }
  >();
  /**
   * Task IDs observed as Ready in the previous poll cycle. Null until the first
   * poll completes — used to skip transition-based clearing on the very first
   * cycle (no prior state available). After the first poll it is a Set of task
   * IDs seen as Ready; tasks absent from this set that appear in a subsequent
   * cycle are treated as external → Ready transitions and have stale pauses
   * cleared (the loop-safety guard for launch_failed escalation).
   */
  private lastPollReadyTaskIds: Set<string> | null = null;
  private static readonly BACKOFF_SCHEDULE_MS = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
  ];
  private static readonly MAX_ATTEMPTS_BEFORE_AUDIT = 5;
  /** Backoff schedule for launch_failed cooldown (separate from crash budget). */
  private static readonly LAUNCH_FAILED_BACKOFF_MS = [
    30_000,
    2 * 60_000,
    10 * 60_000,
  ];
  /** After this many consecutive launch_failed events, escalate to needs_attention. */
  private static readonly LAUNCH_FAILED_ESCALATE_AFTER = 3;

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
  ) {
    // Subscribe to SessionManager events so launch_failed notifications trigger
    // per-task cooldown without relying on the crash budget counter.
    const sm = sessionManager as unknown as {
      on?: (event: string, handler: (msg: ServerMessage) => void) => void;
    };
    if (typeof sm.on === 'function') {
      sm.on('message', (msg: ServerMessage) => {
        if (msg.type === 'session_launch_failed') {
          this.onSessionLaunchFailed(
            (msg as { type: string; taskId: string }).taskId,
          );
        }
      });
    }
  }

  /**
   * Called when a session_launch_failed event is received from SessionManager.
   * Tracks consecutive pre-spawn failures per task and applies escalating
   * cooldown so AutoLauncher backs off rather than hammering a flaky host.
   * After LAUNCH_FAILED_ESCALATE_AFTER consecutive failures the task is
   * escalated to needs_attention so a human can investigate.
   */
  private onSessionLaunchFailed(taskId: string): void {
    const prev = this.launchFailedAttempts.get(taskId);
    const count = (prev?.count ?? 0) + 1;
    const backoffMs =
      AutoLauncher.LAUNCH_FAILED_BACKOFF_MS[
        Math.min(count - 1, AutoLauncher.LAUNCH_FAILED_BACKOFF_MS.length - 1)
      ];
    const nextRetryAt = Date.now() + backoffMs;
    this.launchFailedAttempts.set(taskId, { count, nextRetryAt });

    if (count >= AutoLauncher.LAUNCH_FAILED_ESCALATE_AFTER) {
      logger.warn(
        `[AutoLauncher] task ${taskId} hit ${count} consecutive launch failures — escalating to needs_attention`,
      );
      // launch_failed canonical reason → severity: needs_attention, retry_strategy: manual_action
      setTaskPauseReason(taskId, 'launch_failed', 'launch_failed_escalated');
      recordEvent({
        event_type: 'task_launch_escalated',
        actor_type: 'system',
        actor_id: null,
        project_id: null,
        task_id: taskId,
        payload: { consecutiveFailures: count, reason: 'launch_failed' },
      });
    } else {
      logger.warn(
        `[AutoLauncher] task ${taskId} launch_failed (attempt ${count}) — cooldown ${backoffMs / 1000}s`,
      );
    }
  }

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'auto_launcher',
      intervalMs: () =>
        Math.max(
          MIN_POLL_INTERVAL_MS,
          runtimeSettings.auto_launch_poll_interval_ms,
        ),
      concurrency: 'skip-if-running',
      run: async () => {
        await this.pollOnce();
      },
    });
  }

  /**
   * Run a single poll cycle. Called directly on boot (after resumeOrphanSessions)
   * and periodically by the Scheduler thereafter.
   */
  async pollOnce(): Promise<void> {
    const cycleId = ++this.cycleCounter;
    this.pollLastStartedAt = Date.now();
    logger.info(`[AutoLauncher] poll start cycle=${cycleId}`);
    let eligibleCount = 0;
    let launchedCount = 0;
    let skippedCount = 0;
    try {
      const listProjects = this.options.listProjects ?? getAllProjects;
      const projects = listProjects().filter((p) => p.autoLaunchEnabled);
      const projectResults = await runWithConcurrency(
        projects,
        PROJECT_CONCURRENCY,
        (project) =>
          this.processProject(project).catch((err) => {
            logger.error(`[AutoLauncher] project ${project.id} failed:`, err);
            return {
              eligible: 0,
              launched: 0,
              skipped: 0,
              readyTaskIds: [] as string[],
            };
          }),
      );
      const newReadyTaskIds = new Set<string>();
      for (const counts of projectResults) {
        eligibleCount += counts.eligible;
        launchedCount += counts.launched;
        skippedCount += counts.skipped;
        for (const id of counts.readyTaskIds) {
          newReadyTaskIds.add(id);
        }
      }
      this.lastPollReadyTaskIds = newReadyTaskIds;
    } finally {
      const elapsedMs = Date.now() - (this.pollLastStartedAt ?? Date.now());
      logger.info(
        `[AutoLauncher] poll complete cycle=${cycleId} (eligible=${eligibleCount}, launched=${launchedCount}, skipped=${skippedCount}) durationMs=${elapsedMs}`,
      );
    }
  }

  private async processProject(project: ProjectConfig): Promise<{
    eligible: number;
    launched: number;
    skipped: number;
    readyTaskIds: string[];
  }> {
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    const backend = resolveBackend(project.id);

    if (backend.type === 'local') {
      return { eligible: 0, launched: 0, skipped: 0, readyTaskIds: [] };
    }

    let milestoneId: string | null = null;
    if (backend.type === 'notion' || backend.type === 'github') {
      milestoneId = this.resolveMilestoneId(project);
      if (!milestoneId) {
        logger.warn(
          `[AutoLauncher] project ${project.id}: no milestone configured — skipping`,
        );
        return { eligible: 0, launched: 0, skipped: 0, readyTaskIds: [] };
      }
    }

    const milestoneTasks = await withTimeout(
      backend.fetchReadyTasks(
        milestoneId,
        backend.type === 'notion' ? true : undefined,
      ),
      FETCH_TIMEOUT_MS,
      `fetchReadyTasks(${project.id})`,
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
        logger.warn(
          `[AutoLauncher] project ${project.id}: fetchNonMilestoneReadyTasks failed: ${err}`,
        );
      }
    }

    const allTasks = [...milestoneTasks, ...nonMilestoneTasks];

    // Catch-up pass: if a task is still Ready in Notion but its PR was already
    // merged (the merge-handler fired silently), mark it Done now and skip launch.
    // Idempotency guard: already-Done tasks are skipped to avoid runaway writes.
    // Backoff guard: tasks still in cooldown from a previous failure are skipped.
    const catchUpTasks = allTasks.filter((resolved) => {
      if (resolved.task.status === DONE_STATUS) return false;
      if (!getMergedPRForTask(resolved.task.id)) return false;
      const attempt = this.notionUpdateAttempts.get(resolved.task.id);
      return !(attempt && Date.now() < attempt.nextRetryAt);
    });
    await runWithConcurrency(
      catchUpTasks,
      UPDATE_CONCURRENCY,
      async (resolved) => {
        const mergedPR = getMergedPRForTask(resolved.task.id)!;
        const attempt = this.notionUpdateAttempts.get(resolved.task.id);
        logger.warn(
          `[AutoLauncher] task "${resolved.task.title}" (${resolved.task.id}) skipped — PR #${mergedPR.pr_number} (${mergedPR.pr_url}) is already merged; updating task status to Done`,
        );
        try {
          await withTimeout(
            backend.updateStatus(resolved.task.id, DONE_STATUS),
            FETCH_TIMEOUT_MS,
            `updateStatus(${resolved.task.id})`,
          );
          this.notionUpdateAttempts.delete(resolved.task.id);
        } catch (err) {
          const next = attempt ? attempt.count + 1 : 1;
          const backoffMs =
            AutoLauncher.BACKOFF_SCHEDULE_MS[
              Math.min(next - 1, AutoLauncher.BACKOFF_SCHEDULE_MS.length - 1)
            ];
          this.notionUpdateAttempts.set(resolved.task.id, {
            count: next,
            nextRetryAt: Date.now() + backoffMs,
            lastError: String(err),
          });
          logger.warn(
            `[AutoLauncher] failed to update task ${resolved.task.id} to Done (attempt ${next}, next retry in ${backoffMs / 1000}s): ${err}`,
          );
          if (next === AutoLauncher.MAX_ATTEMPTS_BEFORE_AUDIT) {
            recordEvent({
              event_type: 'auto_launch_done_update_stuck',
              actor_type: 'system',
              actor_id: null,
              project_id: project.id,
              task_id: resolved.task.id,
              payload: {
                pr_number: mergedPR.pr_number,
                last_error: String(err),
                attempts: next,
              },
            });
            setPauseReason(
              mergedPR.pr_number,
              mergedPR.repo,
              'notion_done_update_stuck',
            );
          }
        }
      },
    );

    const readyTaskIds = allTasks.map((r) => r.task.id);

    // Transition detection: clear stale pause state for tasks that just moved
    // into Ready from a non-Ready status. Only fires when the task was NOT in
    // lastPollReadyTaskIds (i.e. it wasn't Ready last cycle), which means either
    // the operator changed the Notion status or this is the first poll after
    // startup. Steady-state Ready tasks (already in the set) are intentionally
    // skipped to avoid wiping launch_failed escalations → relaunch loop.
    for (const resolved of allTasks) {
      this.maybeClearStaleReadyTransitionPauses(resolved.task.id);
    }

    const candidates = allTasks.filter((t) => this.isLaunchCandidate(t));
    if (candidates.length === 0)
      return { eligible: 0, launched: 0, skipped: 0, readyTaskIds };

    let launched = 0;
    for (const candidate of candidates) {
      if (!this.hasCapacity()) {
        break;
      }
      // Non-milestone tasks have no milestoneId — they branch off dev directly.
      const isNonMilestone = nonMilestoneTasks.includes(candidate);
      if (
        await this.launchTask(
          project,
          candidate,
          isNonMilestone ? null : milestoneId,
          isNonMilestone ? 'non_milestone' : 'milestone',
        )
      ) {
        launched++;
      }
    }

    return {
      eligible: candidates.length,
      launched,
      skipped: candidates.length - launched,
      readyTaskIds,
    };
  }

  /**
   * Clear stale pause state when a task transitions into Ready from a non-Ready
   * Notion status. Skipped on the first poll cycle (lastPollReadyTaskIds === null)
   * because no prior state is available — all existing pauses on startup are
   * treated as legitimate. After the first cycle, fires only when the task was
   * absent from lastPollReadyTaskIds (not Ready last cycle), which is the
   * operator's "I cleaned this up and changed it to Ready" signal. Tasks already
   * in the set are steady-state Ready and must NOT be cleared (loop-safety guard
   * for launch_failed escalation).
   */
  private maybeClearStaleReadyTransitionPauses(taskId: string): void {
    if (this.lastPollReadyTaskIds === null) return; // First cycle — no prior state
    if (this.lastPollReadyTaskIds.has(taskId)) return; // Steady-state Ready
    const hadPause = getTaskPauseReason(taskId) != null;
    const hadPrPause = getPausedPrReasonForTask(taskId) != null;
    if (!hadPause && !hadPrPause) return;
    clearTaskPauseReason(taskId);
    clearPausedPrReasonForTask(taskId);
    resetTaskCrashCount(taskId);
    this.launchFailedAttempts.delete(taskId);
    logger.info(
      `[AutoLauncher] task ${taskId} transitioned to Ready — cleared stale pause state (task_pause=${hadPause}, pr_pause=${hadPrPause})`,
    );
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
    // Skip tasks blocked by the crash budget or escalated to needs_attention (persisted).
    if (getTaskPauseReason(task.id) != null) return false;
    // Skip tasks in launch_failed cooldown (in-memory, resets on process restart).
    const launchFailed = this.launchFailedAttempts.get(task.id);
    if (launchFailed && Date.now() < launchFailed.nextRetryAt) return false;
    // Also skip if the task's most recent PR is paused (e.g. stuck_timeout)
    // so we don't relaunch a session that was force-paused.
    if (getPausedPrReasonForTask(task.id) != null) return false;
    // Skip if a merged PR already exists — the task is complete even if Notion
    // status wasn't updated yet. The Notion catch-up update is handled in
    // processProject so we have access to the backend.
    if (getMergedPRForTask(task.id) != null) return false;
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

  private async launchTask(
    project: ProjectConfig,
    resolved: ResolvedTask,
    milestoneId: string | null = null,
    taskKind: 'milestone' | 'non_milestone' = 'milestone',
  ): Promise<boolean> {
    const task = resolved.task;
    const taskUrl =
      task.notionUrl || `https://www.notion.so/${task.id.replace(/-/g, '')}`;

    // Skip if a session for this task is already active. Check both the
    // in-memory SessionManager (catches launches whose Notion status update
    // hasn't propagated back yet) and the DB (catches sessions in any
    // non-terminal state, including ones temporarily missing from memory).
    const liveSessionId = this.sessionManager.findLiveSessionIdForTask(task.id);
    if (liveSessionId) {
      logger.info(
        `[AutoLauncher] skip launch for task ${task.id} — live session ${liveSessionId} already exists`,
      );
      return false;
    }
    if (hasActiveSessionForTask(task.id)) return false;

    // Resolve the repo for this task launch.
    // Single-repo project: auto-resolve to the sole repo (preserves existing behavior).
    // Multi-repo project: look up task_repo_assignments; skip if no assignment exists.
    const repos = getProjectRepos(project);
    let resolvedRepo: string | undefined;
    if (repos.length === 1) {
      resolvedRepo = repos[0];
    } else if (repos.length > 1) {
      const assignment = getTaskRepoAssignment(task.id);
      if (!assignment) {
        logger.info(
          `[AutoLauncher] task ${task.id} is in a multi-repo project with no repo assignment — marking needs_repo and skipping`,
        );
        setTaskPauseReason(task.id, 'needs_repo', '');
        return false;
      }
      resolvedRepo = assignment.repo;
    }

    try {
      const sessionId = await this.sessionManager.start(
        taskUrl,
        project.contextUrl,
        {
          projectId: project.id,
          taskName: task.title || taskUrl,
          milestoneId,
          taskKind,
          taskId: task.id,
          repo: resolvedRepo,
        },
      );
      clearTaskPauseReason(task.id);
      this.launchFailedAttempts.delete(task.id);
      logger.info(
        `[AutoLauncher] launched session ${sessionId.slice(0, 8)} for task ${task.title || task.id} in project ${project.id}${resolvedRepo ? ` repo=${resolvedRepo}` : ''}`,
      );
      this.broadcast?.({
        type: 'auto_launch',
        projectId: project.id,
        taskId: task.id,
        taskTitle: task.title || task.id,
        sessionId,
      });
      return true;
    } catch (err) {
      const fullMsg =
        err instanceof WorktreeSetupError
          ? err.message
          : (err as Error).message;
      logger.warn(
        `[AutoLauncher] failed to launch task ${task.id}: ${fullMsg}`,
      );

      return false;
    }
  }
}
