import fs from 'node:fs';
import { logger } from '../logger';
import { runtimeSettings, getAllProjects, GITHUB_REPO } from '../config';
import type { Scheduler } from './Scheduler';
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
  setSessionPauseReason,
  getLatestSessionEventTimestamp,
  upsertPullRequest,
} from '../db/queries';
import {
  recordEvent,
  countNudgeEvents,
  getLatestNudgeTimestamp,
} from '../audit/AuditLog';
import type { Session } from '../db/types';
import { GitHubClient } from '../github/GitHubClient';
import type { PullRequest } from '../github/types';

const IN_PROGRESS_STATUS = '🔄 In Progress';
const READY_STATUS = '🗂️ Ready';
const DONE_STATUS = '✅ Done';
const ANTI_RACE_MS = 5 * 60 * 1000;
/** Grace window after clean-exit: skip revert to let async post-exit work (PR creation) settle. */
const POST_CLEAN_EXIT_GRACE_MS = 2 * 60 * 1000;
/** Max nudge attempts before surfacing to the operator. */
const NUDGE_LIMIT = 2;
/** Skip nudge if the session emitted a session_events row less than this many ms ago. */
const RECENCY_GATE_MS = 10 * 60 * 1000;
/** Skip nudge if the previous nudge was less than this many ms ago. */
const MIN_NUDGE_SPACING_MS = 15 * 60 * 1000;
/** Nudge message sent to a stalled idle session that hasn't opened a PR. */
const IDLE_NUDGE_MESSAGE =
  'You appear to have finished your work but no PR was opened. Please open a draft PR now so your changes can be reviewed. If you are done with your task, follow the PR format in CLAUDE.md and emit the <pr-body>…</pr-body> marker.';

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
  constructor(
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly options: {
      listProjects?: () => ProjectConfig[];
      resolveBackend?: (projectId: string) => TaskBackend;
      intervalMs?: number;
      /** Shared nudge path — calls SessionManager.sendOrResume under the hood. */
      sendOrResume?: (
        sessionId: string,
        text: string,
      ) => Promise<string | null>;
      /** Override recency gate threshold (ms). Defaults to RECENCY_GATE_MS. */
      recencyGateMs?: number;
      /** Override minimum nudge spacing (ms). Defaults to MIN_NUDGE_SPACING_MS. */
      minNudgeSpacingMs?: number;
      /** GitHub client override for testing (defaults to a real GitHubClient). */
      githubClient?: { listOpenPRs(repo?: string): Promise<PullRequest[]> };
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'orphaned_task_sweeper',
      intervalMs: () =>
        this.options.intervalMs ?? runtimeSettings.auto_launch_poll_interval_ms,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.sweepOnce();
      },
    });
  }

  async sweepOnce(): Promise<void> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    const seen = new Set<string>();

    for (const project of listProjects()) {
      let backend: TaskBackend;
      try {
        backend = resolveBackend(project.id);
      } catch (err) {
        logger.warn(
          `[OrphanedTaskSweeper] skipping project ${project.id}: ${(err as Error).message}`,
        );
        continue;
      }

      let tasks: ResolvedTask[];
      try {
        tasks = await backend.listTasksByStatus(IN_PROGRESS_STATUS);
      } catch (err) {
        logger.warn(
          `[OrphanedTaskSweeper] listTasksByStatus failed for project ${project.id}: ${(err as Error).message}`,
        );
        continue;
      }

      for (const resolved of tasks) {
        const taskId = resolved.task.id;
        if (!taskId || seen.has(taskId)) continue;
        seen.add(taskId);

        // Only sweep Code tasks — non-Code types (Planning, Testing, Tooling) are
        // never auto-dispatched, so In Progress with no session is normal, not orphaned.
        if (resolved.task.type !== '💻 Code') continue;

        try {
          await this.maybeRevertTask(taskId, project.id, backend);
        } catch (err) {
          logger.warn(
            `[OrphanedTaskSweeper] revert check failed for ${taskId}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  private async maybeRevertTask(
    taskId: string,
    projectId: string,
    backend: TaskBackend,
  ): Promise<void> {
    const latestSession = getLatestCodeSessionByNotionTaskId(taskId);

    if (latestSession) {
      // error|killed sessions have no active presence — fall through to revert.
      // (The originally cited sibling fix was never landed.)
      const isTerminal =
        latestSession.status === 'error' || latestSession.status === 'killed';
      if (!isTerminal) {
        // Anti-race: skip if the most recent session started < 5 min ago.
        // This guards against a just-launched session that hasn't fully registered.
        if (Date.now() - latestSession.started_at < ANTI_RACE_MS) {
          return;
        }
        // Defense-in-depth: skip if the session ended cleanly (idle) within the
        // grace window — async PR creation (marker flow) may still be in flight.
        if (latestSession.status === 'idle') {
          const endedAt = latestSession.ended_at ?? latestSession.started_at;
          if (Date.now() - endedAt < POST_CLEAN_EXIT_GRACE_MS) {
            return;
          }
        }
      }
    }

    // Skip if any non-terminal session exists for this task.
    if (hasActiveSessionForTask(taskId)) return;

    // Orphan confirmed: Notion shows In Progress, no live session.
    const lastSeenAt =
      latestSession?.ended_at ?? latestSession?.started_at ?? null;

    // Resolve the authoritative project ID: prefer the session's own project_id
    // so that tasks from project "polimarket" aren't attributed to "claude-dashboard"
    // just because that project's loop encountered the task first.
    const effectiveProjectId = latestSession?.project_id ?? projectId;

    if (latestSession !== undefined) {
      const pr = getPRBySessionId(latestSession.session_id);
      // If the task has an open PR, the session did its job — skip revert.
      // (Merged/closed PRs fall through to the Done path below.)
      // Exception: an idle session with a parked/stalled open PR should still be
      // nudged — the StalledPRReconciler re-drives the review, but the idle
      // session may need a prompt to act on the incoming feedback.
      if (pr && pr.state !== 'merged' && pr.state !== 'closed') {
        if (latestSession.status === 'idle' && !latestSession.archived) {
          await this.maybeNudgeIdleSession(
            latestSession,
            taskId,
            effectiveProjectId,
          );
        }
        return;
      }
    }

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

    if (prMergedOrClosed) {
      await this.revertTask(
        taskId,
        projectId,
        effectiveProjectId,
        lastSeenAt,
        backend,
        DONE_STATUS,
      );
      return;
    }

    // An idle session with no PR is a recoverable asset — nudge rather than revert.
    // Exception: an archived idle session is no longer recoverable; fall through to revert.
    if (latestSession?.status === 'idle' && !latestSession.archived) {
      // Gate: check GitHub before sending the "no PR opened" nudge. Local git may be
      // dead/corrupt and miss a PR that's already open on GitHub.
      if (await this.checkAndBackfillGitHubPR(latestSession)) {
        return;
      }
      await this.maybeNudgeIdleSession(
        latestSession,
        taskId,
        effectiveProjectId,
      );
      return;
    }

    // Genuine orphan (non-idle, no PR, no active session) — revert to Ready.
    await this.revertTask(
      taskId,
      projectId,
      effectiveProjectId,
      lastSeenAt,
      backend,
      READY_STATUS,
    );
  }

  /** Nudge a stalled idle session or surface it to the operator if nudges are exhausted. */
  private async maybeNudgeIdleSession(
    session: Session,
    taskId: string,
    effectiveProjectId: string,
  ): Promise<void> {
    const { session_id, worktree_path } = session;

    // Unrecoverable: worktree is gone — surface to operator, no nudge possible.
    if (!worktree_path || !fs.existsSync(worktree_path)) {
      this.surfaceToOperator(
        session_id,
        taskId,
        effectiveProjectId,
        'worktree_missing',
      );
      return;
    }

    // Working-recency gate: skip if the session emitted events recently.
    // Covers escalation/resume windows where the session is legitimately mid-task.
    const latestEventTs = getLatestSessionEventTimestamp(session_id);
    const recencyGateMs = this.options.recencyGateMs ?? RECENCY_GATE_MS;
    if (latestEventTs !== null && Date.now() - latestEventTs < recencyGateMs) {
      return;
    }

    // Minimum nudge spacing: skip if the last nudge was too recent.
    const latestNudgeTs = getLatestNudgeTimestamp(session_id);
    const minNudgeSpacingMs =
      this.options.minNudgeSpacingMs ?? MIN_NUDGE_SPACING_MS;
    if (
      latestNudgeTs !== null &&
      Date.now() - latestNudgeTs < minNudgeSpacingMs
    ) {
      return;
    }

    // Total nudge count: all task_orphan_nudged events for this session.
    // A session that responds without resolving still exhausts NUDGE_LIMIT and surfaces.
    const nudgesAlready = countNudgeEvents(session_id);

    if (nudgesAlready >= NUDGE_LIMIT) {
      // Surface-once: skip if the session is already marked stalled_idle.
      if (session.pause_reason === 'stalled_idle') {
        return;
      }
      this.surfaceToOperator(
        session_id,
        taskId,
        effectiveProjectId,
        'nudge_limit_reached',
      );
      return;
    }

    const sendOrResume = this.options.sendOrResume;
    if (!sendOrResume) {
      // No sendOrResume injected — log and skip (shouldn't happen in production).
      logger.warn(
        `[OrphanedTaskSweeper] sendOrResume not injected — cannot nudge session ${session_id} for task ${taskId}`,
      );
      return;
    }

    try {
      await sendOrResume(session_id, IDLE_NUDGE_MESSAGE);
    } catch (err) {
      logger.warn(
        `[OrphanedTaskSweeper] sendOrResume failed for session ${session_id}: ${(err as Error).message}`,
      );
      return;
    }

    recordEvent({
      event_type: 'task_orphan_nudged',
      actor_type: 'system',
      actor_id: session_id,
      project_id: effectiveProjectId,
      task_id: taskId,
      payload: { taskId, sessionId: session_id, nudgeCount: nudgesAlready + 1 },
    });

    logger.info(
      `[OrphanedTaskSweeper] nudged idle session ${session_id} for task ${taskId} (nudge ${nudgesAlready + 1}/${NUDGE_LIMIT})`,
    );
  }

  /**
   * Check GitHub for an open PR whose head branch matches the session's tracked branch.
   * If found, backfill the pull_requests row and return true so the caller can skip
   * the "no PR opened" nudge — guards against broken local git missing a live PR.
   */
  private async checkAndBackfillGitHubPR(session: Session): Promise<boolean> {
    const lb = getLocalBranchBySession(session.session_id);
    const headBranch = lb?.branch_name;
    if (!headBranch) return false;

    const client = this.options.githubClient ?? new GitHubClient();
    let openPRs: PullRequest[];
    try {
      openPRs = await client.listOpenPRs();
    } catch (err) {
      logger.warn(
        `[OrphanedTaskSweeper] GitHub PR check failed for session ${session.session_id}: ${(err as Error).message}`,
      );
      return false;
    }

    const found = openPRs.find((pr) => pr.headBranch === headBranch);
    if (!found) return false;

    upsertPullRequest({
      pr_number: found.id,
      pr_url: found.url,
      task_id: session.task_id ?? null,
      session_id: session.session_id,
      repo: GITHUB_REPO,
      title: found.title,
      body: found.body,
      head_branch: found.headBranch,
      base_branch: found.baseBranch,
      state: found.state,
      draft: found.draft ? 1 : 0,
      review_result: null,
      review_at: null,
      created_at: found.createdAt,
      updated_at: found.updatedAt,
      synced_at: new Date().toISOString(),
      node_id: found.nodeId,
      head_sha: found.headSha,
      conflict_nudge_sha: null,
    });

    logger.info(
      `[OrphanedTaskSweeper] found open PR #${found.id} on GitHub for branch ${headBranch} — suppressing nudge and backfilling DB`,
    );
    return true;
  }

  /** Surface a stalled session to the operator (attention queue) without reverting the task. */
  private surfaceToOperator(
    sessionId: string,
    taskId: string,
    effectiveProjectId: string,
    reason: string,
  ): void {
    setSessionPauseReason(sessionId, 'stalled_idle');

    recordEvent({
      event_type: 'task_orphan_surfaced',
      actor_type: 'system',
      actor_id: sessionId,
      project_id: effectiveProjectId,
      task_id: taskId,
      payload: { taskId, sessionId, reason },
    });

    this.broadcast({
      type: 'task_status_changed',
      notionTaskId: taskId,
      newStatus: IN_PROGRESS_STATUS,
    });

    logger.info(
      `[OrphanedTaskSweeper] surfaced stalled session ${sessionId} for task ${taskId} to operator (reason: ${reason})`,
    );
  }

  /** Revert a task to the given Notion status. Used only for merged/closed PRs and genuine orphans. */
  private async revertTask(
    taskId: string,
    projectId: string,
    effectiveProjectId: string,
    lastSeenAt: number | null,
    backend: TaskBackend,
    newStatus: string,
  ): Promise<void> {
    await backend.updateStatus(taskId, newStatus);

    recordEvent({
      event_type: 'task_orphan_reverted',
      actor_type: 'system',
      project_id: effectiveProjectId,
      task_id: taskId,
      payload: { taskId, projectId: effectiveProjectId, lastSeenAt },
    });

    this.broadcast({
      type: 'task_status_changed',
      notionTaskId: taskId,
      newStatus,
    });

    logger.info(
      `[OrphanedTaskSweeper] reverted orphan task ${taskId} in project ${projectId} → ${newStatus}`,
    );
  }
}
