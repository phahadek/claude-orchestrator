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
  getLatestOpsSessionByTaskId,
  getLatestDocsSessionByTaskId,
  hasActiveSessionForTask,
  hasNonTerminalPlanningSessionForTask,
  isSessionAwaitingCapabilityDisposition,
  isSessionAwaitingOperatorDecision,
  isOperatorDecisionPastWindow,
  isNoOpSuppressed,
  getPRByNotionTaskId,
  getLocalBranchBySession,
  setSessionPauseReason,
  getSessionLastActivityMs,
  upsertPullRequest,
  getTaskRepoAssignment,
} from '../db/queries';
import { sessionDidWork } from '../session/sessionLifecycle';
import { isUsageAdmitted } from './usageAdmission';
import {
  recordEvent,
  countNudgeEvents,
  getLatestNudgeTimestamp,
} from '../audit/AuditLog';
import type { Session } from '../db/types';
import { GitHubClient } from '../github/GitHubClient';
import type { PullRequest } from '../github/types';
import { NotionApiError } from '../notion/types';

/**
 * True for a revert-write failure that can never succeed on retry — the
 * source page is archived/trashed, so every identical retry reproduces the
 * exact same 400 forever. Distinguishes this from a transient failure
 * (network blip, rate limit) that's still worth retrying next tick.
 */
function isPermanentRevertFailure(err: unknown): boolean {
  return (
    err instanceof NotionApiError &&
    err.statusCode === 400 &&
    /archived/i.test(err.message)
  );
}

/** Task types the orchestrator moves to In Progress itself on dispatch — eligible for orphan sweep. */
const SWEEPABLE_TYPES = new Set([
  '💻 Code',
  '🔧 Operational',
  '🔎 Investigation',
  '📝 Docs',
]);

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
/**
 * Bounded window a session may sit awaiting an operator decision before it
 * is surfaced instead of parked forever — see isOperatorDecisionPastWindow.
 */
const AWAITING_OPERATOR_DECISION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Nudge message sent to a stalled idle session that hasn't opened a PR. */
const NO_PR_NUDGE_MESSAGE =
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
  /**
   * Task ids whose revert write failed permanently (source page
   * archived/trashed) — never re-attempted once recorded here. Cleared only
   * by process restart; the producer-side fix (TaskCacheRefresher evicting
   * the vanished task_cache row) is what actually retires the entry, since a
   * task once evicted no longer surfaces from listTasksByStatus at all.
   */
  private readonly permanentlyFailedTaskIds = new Set<string>();

  /**
   * Last non-permanent revert-check failure message per task id — used
   * only to suppress repeat logging for a task that fails identically
   * tick after tick. Cleared once the task reverts cleanly, so a later
   * failure logs again as a fresh transition.
   */
  private readonly lastRevertFailureMessage = new Map<string, string>();

  constructor(
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly options: {
      listProjects?: () => ProjectConfig[];
      resolveBackend?: (projectId: string) => TaskBackend;
      intervalMs?: number;
      /**
       * Shared nudge path — calls SessionManager.enqueueFeedback under the hood,
       * which routes the nudge through the turn-boundary-gated feedback inbox
       * instead of a raw stdin write (delivered at the next turn boundary for a
       * live session, or via a clean respawn for an idle/exited one).
       */
      enqueueFeedback?: (
        sessionId: string,
        source: string,
        payload: string,
      ) => Promise<void>;
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
      run: async () => this.sweepOnce(),
    });
  }

  async sweepOnce(): Promise<{ items_processed: number }> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    const seen = new Set<string>();
    const failedTaskIds: string[] = [];

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

        // Only sweep task types the orchestrator actually auto-dispatches (moving
        // them to In Progress itself). Design/Planning tasks are never auto-dispatched
        // the same way (a groom launch never moves its target), so In Progress with
        // no session there is normal, not orphaned — leave them alone.
        if (!SWEEPABLE_TYPES.has(resolved.task.type)) continue;

        // Already gave up on this task in a prior tick — the source page
        // can't be edited, so retrying identically would just reproduce the
        // same permanent failure forever.
        if (this.permanentlyFailedTaskIds.has(taskId)) continue;

        try {
          await this.maybeRevertTask(
            taskId,
            project.id,
            resolved.task.type,
            backend,
          );
          this.lastRevertFailureMessage.delete(taskId);
        } catch (err) {
          // A single task's revert check failing must not throw the whole
          // tick — that would mark every other task's work (which already
          // completed above) as failed too, and would repeat forever for
          // an unrevertable task. Record it and move on; the tick itself
          // still succeeds.
          failedTaskIds.push(taskId);
          const message = (err as Error).message;
          if (isPermanentRevertFailure(err)) {
            this.permanentlyFailedTaskIds.add(taskId);
            this.lastRevertFailureMessage.delete(taskId);
            logger.error(
              `[OrphanedTaskSweeper] revert check for ${taskId} failed permanently (source page archived/trashed) — giving up, will not retry: ${message}`,
            );
          } else {
            // Log only on the first occurrence or when the failure reason
            // changes — an unrevertable task otherwise logs identically
            // every tick forever.
            const isRepeat =
              this.lastRevertFailureMessage.get(taskId) === message;
            this.lastRevertFailureMessage.set(taskId, message);
            if (!isRepeat) {
              logger.warn(
                `[OrphanedTaskSweeper] revert check failed for ${taskId}: ${message}`,
              );
            }
          }
          recordEvent({
            event_type: 'task_revert_check_failed',
            actor_type: 'system',
            project_id: project.id,
            task_id: taskId,
            payload: { message, permanent: isPermanentRevertFailure(err) },
          });
        }
      }
    }

    return { items_processed: seen.size };
  }

  private async maybeRevertTask(
    taskId: string,
    projectId: string,
    taskType: string,
    backend: TaskBackend,
  ): Promise<void> {
    // A committed planning.noOp still stands for this task — a session
    // already declared its work satisfied elsewhere and drove it to Done
    // (see routes/stagedIntents.ts's maybeAutoResolveCodeNoOp). Never revert
    // that decision back to Ready; it retires automatically the moment the
    // task is next edited (see isNoOpSuppressed in db/queries.ts).
    if (isNoOpSuppressed(taskId)) return;

    // Docs is the one non-Code sweepable type that opens its own session and
    // can open a PR (human_merge_only) — resolve its own-type session here so
    // the PR-exemption and idle-nudge logic below (written against 'standard'
    // sessions) actually sees it, instead of always finding undefined via
    // getLatestCodeSessionByNotionTaskId (which only ever resolves 'standard'
    // sessions). Ops/Investigation never open a PR and are left as-is —
    // their own-type session is resolved separately, further down.
    const latestSession =
      taskType === '📝 Docs'
        ? getLatestDocsSessionByTaskId(taskId)
        : getLatestCodeSessionByNotionTaskId(taskId);

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

    // Skip if any non-terminal session exists for this task — except when the
    // latest session is idle past its grace window: idle is a live, resumable
    // status (hasActiveSessionForTask reports it active), but this function has
    // its own idle-specific handling below (the stalled-PR nudge) that must run
    // rather than being short-circuited here.
    if (latestSession?.status !== 'idle' && hasActiveSessionForTask(taskId)) {
      return;
    }

    // Planning sessions (groom/design) are legitimately idle awaiting operator
    // disposition (no abandonment timeout — see Q1-B) — never treat one as an
    // orphan. getLatestCodeSessionByNotionTaskId/hasActiveSessionForTask above
    // only ever see 'standard' sessions, so an idle planning session would
    // otherwise fall through to the revert/nudge paths below unnoticed.
    if (hasNonTerminalPlanningSessionForTask(taskId)) return;

    // An idle session parked awaiting a capability disposition is always
    // legitimate — it is not stalled, not abandoned, and not a candidate for
    // any terminal action (nudge, revert-to-Ready, surface-to-operator) or
    // crash-budget accounting. It is the system working: the session asked
    // and is waiting for an answer only the operator can give.
    if (
      latestSession?.status === 'idle' &&
      isSessionAwaitingCapabilityDisposition(latestSession)
    ) {
      return;
    }

    // Same shape, generalized: an idle session parked awaiting an operator
    // decision (a question only they can answer, not a capability grant) is
    // equally legitimate — it is the system working, not a stall. Unlike the
    // capability case, this park is not indefinite: a session left waiting
    // past AWAITING_OPERATOR_DECISION_WINDOW_MS falls through to the normal
    // surface-to-operator path below instead of being protected forever.
    if (
      latestSession?.status === 'idle' &&
      isSessionAwaitingOperatorDecision(latestSession)
    ) {
      if (
        !isOperatorDecisionPastWindow(
          latestSession,
          AWAITING_OPERATOR_DECISION_WINDOW_MS,
        )
      ) {
        return;
      }
      // Surface-once: already escalated on a prior sweep tick — the question
      // itself is left in place (still answerable, still retrievable) but
      // this branch must not re-fire task_orphan_surfaced every cycle.
      if (latestSession.pause_reason === 'stalled_idle') {
        return;
      }
      this.surfaceToOperator(
        latestSession.session_id,
        taskId,
        latestSession.project_id ??
          getTaskRepoAssignment(taskId)?.project_id ??
          projectId,
        'awaiting_operator_decision_timeout',
      );
      return;
    }

    // Orphan confirmed: Notion shows In Progress, no live session.
    const lastSeenAt =
      latestSession?.ended_at ?? latestSession?.started_at ?? null;

    // Resolve the authoritative project ID: prefer the session's own project_id
    // so that tasks from project "polimarket" aren't attributed to "claude-dashboard"
    // just because that project's loop encountered the task first. Once the
    // session row is gone (deleted anchor), fall back to the task's own
    // durable repo assignment before the sweep loop's current project.
    const effectiveProjectId =
      latestSession?.project_id ??
      getTaskRepoAssignment(taskId)?.project_id ??
      projectId;

    // Resolve the task's PR by the task's own id — not solely via
    // latestSession.session_id — so an open PR still protects the task once
    // its implementing session row has been deleted (see the session-anchor-
    // durability fix; pull_requests.task_id survives a session-row deletion
    // that pull_requests.session_id alone can no longer be joined through).
    const taskPR = getPRByNotionTaskId(taskId);

    // If the task has an open PR, the session did its job — skip revert.
    // (Merged/closed PRs fall through to the Done path below.)
    // No idle nudge here: review/CI feedback is delivered to the session via
    // SessionManager.enqueueFeedback's inbox, never discovered by the session
    // "checking" for it, so a bare elapsed-idle-time nudge asks it to perform
    // an action it has no channel to accomplish. StalledPRReconciler's
    // session_inert path is the sole mechanism that wakes an idle
    // implementing session about an open PR — it only fires once the session
    // has gone silent past session_inert_threshold_seconds *and*
    // countUndeliveredInboxItems confirms there is actually something
    // undelivered waiting for it.
    if (taskPR && taskPR.state !== 'merged' && taskPR.state !== 'closed') {
      return;
    }

    // taskPR reaching here is either absent or already merged/closed (the
    // open case returned above), so no fresh getPRBySessionId lookup is
    // needed. Loose falsy check — a real (unmocked) db lookup miss surfaces
    // as `undefined`, not the `null` the return type declares.
    const localBranch =
      latestSession !== undefined
        ? getLocalBranchBySession(latestSession.session_id)
        : undefined;

    // Merged is the only signal that means "finished work" — mark Done so the
    // task doesn't get re-dispatched over top of it. A squash-merged PR can
    // report state='closed' on GitHub while local_branches still records the
    // merge commit, so the merged check must win over the closed check below
    // even when both signals are present on the same session.
    const isMerged =
      taskPR?.state === 'merged' || localBranch?.status === 'merged';

    if (isMerged) {
      await this.revertTask(
        taskId,
        projectId,
        effectiveProjectId,
        lastSeenAt,
        backend,
        DONE_STATUS,
        'merged',
      );
      return;
    }

    // Closed-without-merging means the attempt was abandoned, not completed —
    // e.g. the operator's close-and-relaunch remedy for a wedged PR. Revert to
    // Ready (not Done) so the task returns to the backlog for re-grooming
    // instead of silently reading as finished work.
    const isClosedUnmerged =
      taskPR?.state === 'closed' || localBranch?.status === 'abandoned';

    if (isClosedUnmerged) {
      await this.revertTask(
        taskId,
        projectId,
        effectiveProjectId,
        lastSeenAt,
        backend,
        READY_STATUS,
        'closed_unmerged',
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
        NO_PR_NUDGE_MESSAGE,
      );
      return;
    }

    // Ops/Investigation sessions never open a PR, and once they exit cleanly
    // their session status is terminal ('done') rather than idle — so they
    // fall through every PR/idle exemption above and land here alongside a
    // genuinely abandoned task. Their session_type ('ops') is also invisible
    // to getLatestCodeSessionByNotionTaskId/hasActiveSessionForTask (standard-
    // session-only), so latestSession is typically undefined too. What
    // distinguishes "finished, awaiting operator disposition" from
    // "abandoned" is sessionDidWork: a stage-only ops session that staged a
    // decision (even with its ops_journal still 'pending' or missing), or
    // one whose ops_journal has advanced past 'pending' with nothing staged,
    // both count as having done its job — leave the task In Progress rather
    // than silently returning it to the dispatch pool. Neither signal true
    // is still a genuine orphan.
    if (taskType !== '💻 Code') {
      // Docs already resolved its own-type session into latestSession above;
      // Ops/Investigation never open a PR, so their session is only ever
      // looked up here, for this fallback judgment.
      const nonCodeSession =
        taskType === '📝 Docs'
          ? latestSession
          : getLatestOpsSessionByTaskId(taskId);
      if (nonCodeSession && sessionDidWork(nonCodeSession.session_id)) {
        return;
      }
    }

    // Genuine orphan (non-idle, no PR, no active session) — revert to Ready.
    await this.revertTask(
      taskId,
      projectId,
      effectiveProjectId,
      lastSeenAt,
      backend,
      READY_STATUS,
      'orphan',
    );
  }

  /** Nudge a stalled idle session or surface it to the operator if nudges are exhausted. */
  private async maybeNudgeIdleSession(
    session: Session,
    taskId: string,
    effectiveProjectId: string,
    nudgeMessage: string,
  ): Promise<void> {
    const { session_id, worktree_path } = session;

    // Plan usage is exhausted account-wide: a nudge sent now would only
    // deliver a limit response, not real work, yet would still burn a slot
    // of the finite nudge budget and eventually escalate the session to the
    // operator as "stalled" for the wrong reason. Skip entirely — leave the
    // nudge count and pause_reason untouched — so the next sweep tick (after
    // the persisted usage_deferral expires) retries with a clean slate.
    if (!isUsageAdmitted().allowed) {
      return;
    }

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
    const latestEventTs = getSessionLastActivityMs(session_id);
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

    const enqueueFeedback = this.options.enqueueFeedback;
    if (!enqueueFeedback) {
      // No enqueueFeedback injected — log and skip (shouldn't happen in production).
      logger.warn(
        `[OrphanedTaskSweeper] enqueueFeedback not injected — cannot nudge session ${session_id} for task ${taskId}`,
      );
      return;
    }

    try {
      await enqueueFeedback(session_id, 'system:nudge', nudgeMessage);
    } catch (err) {
      logger.warn(
        `[OrphanedTaskSweeper] enqueueFeedback failed for session ${session_id}: ${(err as Error).message}`,
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

  /**
   * Revert a task to the given Notion status. Used for merged PRs (→ Done),
   * closed-unmerged PRs and genuine orphans (→ Ready). `reason` distinguishes
   * the merged case from the closed-unmerged one in the audit trail, so a
   * closed-unmerged revert cannot read as normal completion.
   */
  private async revertTask(
    taskId: string,
    projectId: string,
    effectiveProjectId: string,
    lastSeenAt: number | null,
    backend: TaskBackend,
    newStatus: string,
    reason: 'merged' | 'closed_unmerged' | 'orphan',
  ): Promise<void> {
    await backend.updateStatus(taskId, newStatus);

    recordEvent({
      event_type: 'task_orphan_reverted',
      actor_type: 'system',
      project_id: effectiveProjectId,
      task_id: taskId,
      payload: { taskId, projectId: effectiveProjectId, lastSeenAt, reason },
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
