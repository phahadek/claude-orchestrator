import {
  getProjectByGithubRepo,
  getProjectById,
  runtimeSettings,
} from '../config';
import { recordEvent } from '../audit/AuditLog';
import { closeFlakyRemediationTaskIfLinked } from '../audit/flakyRemediationFiling';
import { closeBaseHealthRemediationTaskIfLinked } from '../audit/baseHealthRemediationFiling';
import {
  getPRByNumber,
  setHeadSha,
  setPauseReason,
  updateMergeState,
  updatePRDraftStatus,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
  markLocalBranchMerged,
  setLocalBranchPauseReason,
  getSession,
  getOrphanMergeablePRs,
  getStaleAutoMergeFailedPRs,
  getConflictNudgeCandidates,
  upsertActiveMerge,
  deleteActiveMerge,
  getAllActiveMerges,
  markSessionDone,
  recordPrAnchoredCompletingSignal,
  getTaskCache,
  getPendingRoutedCommentCount,
  markReviewerRequested,
} from '../db/queries';
import type { GitHubClient, PRReviewDecision } from './GitHubClient';
import { GitHubApiError, GitHubRateLimitError } from './types';
import {
  isGitHubRateLimitActive,
  recordGitHubRateLimit,
} from './rateLimitBackoff';
import { getCorporateMode } from '../config/corporateMode';
import {
  pauseReasonFromCanonical,
  isMergeBlockingPause,
} from '../db/pauseReason';
import type { PRMergeWatcher } from './PRMergeWatcher';
import type { PullRequestRow } from '../db/types';
import type { ServerMessage } from '../ws/types';
import { emitTaskUpdated } from '../routes/tasks';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import { squashMergeLocal } from '../orchestration/localMergeRunner';
import { detectMergeConflict } from '../orchestration/localBranchHelpers';
import { formatMergeConflictFeedback } from './reviewUtils';
import { sendConflictNudge, type ConflictNudgeCause } from './conflictNudge';
import { logger } from '../logger';
import type { Scheduler } from '../orchestration/Scheduler';

const MIN_POLL_INTERVAL_MS = 5_000;
const PR_MERGE_SWEEP_INTERVAL_MS = 30_000;
const LOCAL_BRANCH_SWEEP_INTERVAL_MS = 15_000;
const CONFLICT_NUDGE_SWEEP_INTERVAL_MS = 120_000;
/**
 * Cap on candidates processed per conflictNudgeSweep() pass. respawnSession
 * (SessionManager.ts) no longer applies memory admission to resumes, so this
 * sweep's own fan-out over relaunchFixerForPR/sendOrResume must be bounded
 * here instead — an unLIMITed candidate list would otherwise be able to
 * trigger a resume per row in a single pass. Candidates beyond the cap are
 * simply picked up on the next scheduled pass (CONFLICT_NUDGE_SWEEP_INTERVAL_MS
 * later), so nothing is dropped, only deferred.
 */
const CONFLICT_NUDGE_SWEEP_BATCH_LIMIT = 20;

/**
 * Drives the post-approval auto-merge flow. After review reaches an approved
 * verdict and CI turns green, squash-merges the PR to dev and lets
 * PRMergeWatcher complete the lifecycle. On any other outcome the task is
 * paused with a pause_reason so a human picks it up.
 *
 * Per-project — only runs for projects with `autoMergeEnabled === true`.
 * Skips PRs paused for a merge-blocking reason. A pause classified as
 * non-blocking (PAUSE_REASON_REGISTRY[reason].blocks_merge === false, e.g.
 * test_report_acquisition_failed) is advisory — it stays visible for
 * operators but does not stop the merge. See isMergeBlockingPause().
 */
export class AutoMerger {
  /** In-flight auto-merge loops keyed by `${repo}#${prNumber}` to prevent double-runs. */
  private active = new Set<string>();

  constructor(
    private github: GitHubClient,
    private mergeWatcher: PRMergeWatcher,
    private broadcast: (msg: ServerMessage) => void,
    private sessions?: SessionManager,
  ) {
    this.bootSweep();
  }

  private key(prNumber: number, repo: string): string {
    return `${repo}#${prNumber}`;
  }

  private handleRateLimit(err: GitHubRateLimitError): void {
    recordGitHubRateLimit(err, '[AutoMerger]', this.broadcast);
  }

  /**
   * On boot, trigger AutoMerger for any PR that is already in the approved +
   * mergeable + clean state but received no event post-restart. These rows are
   * missed by the event-driven path because AutoMerger only fires on fresh
   * verdict=approved events or ci_failing → clean transitions.
   *
   * Also fires conflictNudgeSweep() asynchronously to re-nudge sessions for
   * conflict/auto_merge_failed PRs that were missed before this notifier existed.
   */
  bootSweep(): void {
    const orphans = getOrphanMergeablePRs();
    for (const row of orphans) {
      logger.info(
        `[AutoMerger] boot sweep: triggering merge for orphan PR #${row.pr_number} in ${row.repo}`,
      );
      this.attempt(row.pr_number, row.repo);
    }
    if (orphans.length > 0) {
      logger.info(
        `[AutoMerger] boot sweep complete — triggered ${orphans.length} orphan PR(s)`,
      );
    }
    void this.conflictNudgeSweep().catch((err: unknown) =>
      logger.warn(
        `[AutoMerger] conflictNudgeSweep error on boot: ${(err as Error).message}`,
      ),
    );
  }

  /**
   * Clear stale auto_merge_failed pauses and retry merging. Only clears
   * auto_merge_failed (transient 405 race); never touches human-actionable
   * pause reasons (max_reviews, ci_failing, ci_billing_blocked, pr_body_invalid).
   * Threshold is runtimeSettings.auto_merge_failed_clear_minutes.
   */
  clearStalePauses(): void {
    const thresholdMs =
      Math.max(1, runtimeSettings.auto_merge_failed_clear_minutes) * 60_000;
    const stale = getStaleAutoMergeFailedPRs(thresholdMs);
    for (const row of stale) {
      logger.info(
        `[AutoMerger] clearing stale auto_merge_failed pause for PR #${row.pr_number} in ${row.repo} (>${runtimeSettings.auto_merge_failed_clear_minutes}m old) — retrying`,
      );
      setPauseReason(row.pr_number, row.repo, null);
      this.attempt(row.pr_number, row.repo);
    }
  }

  /**
   * Re-nudge sessions for PRs that are still conflicted/blocked but whose
   * conflict notification was never delivered — either because the pause
   * predates the notifier (auto_merge_failed rows with no conflict_nudge_sha)
   * or because PRMergeWatcher recorded the conflict while the session was
   * not being polled (merge_state='dirty'/'blocked', no pause).
   *
   * Guards: session must be idle; GitHub mergeability is re-checked so PRs
   * whose conflict resolved while the backend was down are not re-nudged.
   * SHA dedup in sendConflictNudge prevents double-nudging. Processes at
   * most CONFLICT_NUDGE_SWEEP_BATCH_LIMIT candidates per pass — this is the
   * one sweep with unbounded fan-out over respawnSession (via
   * relaunchFixerForPR/sendOrResume), so it carries its own cap rather than
   * relying on memory admission at the resume transition.
   */
  async conflictNudgeSweep(): Promise<void> {
    if (!this.sessions) return;
    if (isGitHubRateLimitActive(this.broadcast)) return;
    const allCandidates = getConflictNudgeCandidates();
    if (allCandidates.length === 0) return;
    const candidates = allCandidates.slice(0, CONFLICT_NUDGE_SWEEP_BATCH_LIMIT);
    if (allCandidates.length > candidates.length) {
      logger.info(
        `[AutoMerger] conflictNudgeSweep: ${allCandidates.length} candidate(s) found, processing ${candidates.length} this pass (batch cap) — remainder picked up next pass`,
      );
    }

    logger.info(
      `[AutoMerger] conflictNudgeSweep: checking ${candidates.length} candidate(s)`,
    );
    let nudged = 0;

    for (const { pr_number, repo } of candidates) {
      const pr = getPRByNumber(pr_number, repo);
      if (!pr?.session_id) continue;

      const session = getSession(pr.session_id);
      if (!session) continue;
      const isDeadSession =
        session.status === 'done' ||
        session.status === 'error' ||
        session.status === 'killed';
      // Live sessions that aren't idle are legitimately busy — leave them alone.
      if (session.status !== 'idle' && !isDeadSession) continue;

      let category;
      try {
        category = await this.github.categorizeMergeability(pr_number, repo);
      } catch (err) {
        logger.warn(
          `[AutoMerger] conflictNudgeSweep: categorizeMergeability failed for PR #${pr_number}: ${(err as Error).message}`,
        );
        continue;
      }

      if (category.category !== 'conflict' && category.category !== 'blocked')
        continue;

      // The DB row may predate a push the session already made (webhook/poll
      // lag) — sync head_sha from this live GitHub read so the nudge (and its
      // SHA dedup) reflects the PR's real current state, not a stale one.
      if (category.headSha && category.headSha !== pr.head_sha) {
        setHeadSha(pr_number, repo, category.headSha);
        pr.head_sha = category.headSha;
      }

      if (isDeadSession) {
        // The implementing session is dead — the live-session nudge path
        // (sendOrResume) can't reach it. Relaunch a coding fixer bound to the
        // PR's existing branch instead, with a rebase prompt.
        if (!this.sessions) continue;
        const prompt = formatMergeConflictFeedback({
          branchName: pr.head_branch,
          baseBranch: pr.base_branch ?? 'dev',
        });
        await this.sessions.relaunchFixerForPR(pr, prompt);
        recordEvent({
          event_type: 'conflict_nudge_sent',
          actor_type: 'system',
          actor_id: null,
          project_id: null,
          task_id: pr.task_id ?? null,
          payload: {
            pr_number: pr.pr_number,
            repo: pr.repo,
            head_sha: pr.head_sha,
            cause: 'dead_session_fixer_relaunch',
          },
        });
        nudged++;
        continue;
      }

      const cause: ConflictNudgeCause =
        category.category === 'conflict' &&
        category.rawMergeableState === 'behind'
          ? 'behind'
          : category.category === 'blocked'
            ? 'blocked'
            : 'conflict';

      await sendConflictNudge(this.sessions, pr, cause);
      nudged++;
    }

    if (nudged > 0) {
      logger.info(
        `[AutoMerger] conflictNudgeSweep complete — nudged ${nudged} session(s)`,
      );
    }
  }

  /**
   * Poll both pull_requests and local_branches for merge-ready items and
   * dispatch to the appropriate merge handler. PRs go through the existing
   * attempt() loop; local branches are squash-merged immediately.
   *
   * Scheduled as the auto_merger_pr_merge_sweep job via register() — this is
   * the backstop that ensures an approved, unpaused, mergeable PR always
   * eventually merges even if the event that would normally drive it
   * (verdict=approved, ci_failing -> clean) fired before the PR was actually
   * mergeable. The local-branch and conflict-nudge sweeps it also performs
   * here are each independently scheduled at their own cadence via
   * register(), so this call is redundant-but-harmless for those two paths;
   * only the PR-attempt path above is otherwise undriven between events.
   */
  async pollOnce(): Promise<void> {
    if (isGitHubRateLimitActive(this.broadcast)) return;
    const approvedPRs = getApprovedOpenPRs();
    for (const pr of approvedPRs) {
      // run() checks pause_reason too, but filtering here avoids spawning the
      // active-set entry for a goroutine that would exit immediately.
      if (isMergeBlockingPause(pr.pause_reason)) continue;
      this.attempt(pr.pr_number, pr.repo);
    }

    await this.sweepApprovedLocalBranches();

    await this.conflictNudgeSweep();
  }

  /**
   * Registers the PR merge-attempt sweep, the local-branch merge sweep, and
   * the conflict-nudge sweep with the Scheduler.
   *
   * The PR merge-attempt sweep (getApprovedOpenPRs -> attempt(), via
   * pollOnce()) is a backstop for the event-driven path
   * (PRMergeWatcher/PRReviewService): if the triggering event fires before
   * the PR is actually mergeable — approval landing while CI still runs, a
   * pause clearing after the per-PR loop already exited — nothing re-attempts
   * it, and it can strand indefinitely with no visible blocker. attempt() is
   * idempotent per PR via the `active` set, so this sweep never double-runs
   * or double-merges a PR the event-driven path (or an operator) is already
   * handling.
   *
   * The conflict-nudge sweep is scheduled here because attempt() deliberately
   * no-ops on category='conflict' — conflictNudgeSweep() is the only
   * component that re-nudges a live session, and without a recurring job it
   * only ran at boot.
   */
  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'auto_merger_pr_merge_sweep',
      intervalMs: PR_MERGE_SWEEP_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.pollOnce();
      },
    });
    scheduler.register({
      name: 'auto_merger_local_branch_sweep',
      intervalMs: LOCAL_BRANCH_SWEEP_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.sweepApprovedLocalBranches();
      },
    });
    scheduler.register({
      name: 'auto_merger_conflict_nudge_sweep',
      intervalMs: CONFLICT_NUDGE_SWEEP_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.conflictNudgeSweep();
      },
    });
  }

  /**
   * Squash-merges every approved local branch (project auto_merge_enabled,
   * review approved, no pause_reason). The only code path that drives
   * handleLocalBranchMerge() for local-only projects — see register().
   */
  async sweepApprovedLocalBranches(): Promise<void> {
    const approvedLocalBranches = getApprovedLocalBranches();
    for (const row of approvedLocalBranches) {
      await this.handleLocalBranchMerge(row);
    }
  }

  private async handleLocalBranchMerge(
    row: ReturnType<typeof getApprovedLocalBranches>[number],
  ): Promise<void> {
    const session = row.session_id ? getSession(row.session_id) : undefined;
    if (!session) {
      logger.warn(
        `[AutoMerger] local branch #${row.id} (${row.branch_name}): session ${row.session_id} not found — skipping`,
      );
      return;
    }

    const worktreePath = session.worktree_path;
    if (!worktreePath) {
      logger.warn(
        `[AutoMerger] local branch #${row.id} (${row.branch_name}): no worktree_path on session — skipping`,
      );
      return;
    }

    const hasConflict = await detectMergeConflict(
      worktreePath,
      row.base_branch,
      row.branch_name,
    ).catch((err: unknown) => {
      logger.warn(
        `[AutoMerger] local branch #${row.id}: detectMergeConflict failed: ${(err as Error).message}`,
      );
      return false;
    });

    if (hasConflict) {
      setLocalBranchPauseReason(row.id, 'merge_conflict');
      if (this.sessions && session.session_id) {
        this.sessions
          .sendOrResume(
            session.session_id,
            formatMergeConflictFeedback({
              branchName: row.branch_name,
              baseBranch: row.base_branch,
            }),
          )
          .catch((err: unknown) =>
            logger.warn(
              `[AutoMerger] local branch #${row.id}: sendOrResume failed: ${(err as Error).message}`,
            ),
          );
      }
      return;
    }

    const taskName = session.task_name ?? row.branch_name;

    const result = await squashMergeLocal({
      worktreePath,
      baseBranch: row.base_branch,
      featureBranch: row.branch_name,
      taskName,
    }).catch((err: unknown) => {
      logger.warn(
        `[AutoMerger] local branch #${row.id}: squashMergeLocal threw: ${(err as Error).message}`,
      );
      return { merged: false as const, conflict: false };
    });

    if (!result.merged) {
      if (result.conflict) {
        setLocalBranchPauseReason(row.id, 'merge_conflict');
        if (this.sessions && session.session_id) {
          this.sessions
            .sendOrResume(
              session.session_id,
              formatMergeConflictFeedback({
                branchName: row.branch_name,
                baseBranch: row.base_branch,
              }),
            )
            .catch((err: unknown) =>
              logger.warn(
                `[AutoMerger] local branch #${row.id}: sendOrResume failed: ${(err as Error).message}`,
              ),
            );
        }
      }
      return;
    }

    const commitSha = result.commitSha ?? null;

    markLocalBranchMerged(row.id, commitSha);

    recordEvent({
      event_type: 'pr_merged',
      actor_type: 'system',
      actor_id: null,
      project_id: row.project_id ?? null,
      task_id: session.task_id ?? null,
      payload: {
        branch_name: row.branch_name,
        base_branch: row.base_branch,
        merge_sha: commitSha,
        local_branch_id: row.id,
        source: 'auto-merger',
      },
    });

    if (this.sessions && session.session_id) {
      this.sessions.endSession(session.session_id);
    }

    if (session.task_id) {
      const project = getProjectById(row.project_id);
      if (project) {
        const backend = getTaskBackend(row.project_id);
        backend
          .updateStatus(session.task_id, '✅ Done')
          .then(() => {
            closeFlakyRemediationTaskIfLinked(
              session.task_id!,
              new Date().toISOString(),
            );
            closeBaseHealthRemediationTaskIfLinked(
              session.task_id!,
              new Date().toISOString(),
            );
          })
          .catch((err: unknown) =>
            logger.warn(
              `[AutoMerger] local branch #${row.id}: updateStatus failed: ${(err as Error).message}`,
            ),
          );
      }
    }

    this.broadcast({
      type: 'local_branch_merged',
      projectId: row.project_id,
      sessionId: session.session_id,
      branchName: row.branch_name,
      commitSha,
    });

    logger.info(
      `[AutoMerger] local branch ${row.branch_name} squash-merged into ${row.base_branch} (${commitSha ?? 'no sha'})`,
    );
  }

  /**
   * Try to auto-merge the given PR. Returns immediately (does not await the
   * polling loop). The loop runs to completion in the background.
   */
  attempt(
    prNumber: number,
    repo: string,
    options?: { bypassToggle?: boolean },
  ): void {
    const k = this.key(prNumber, repo);
    if (this.active.has(k)) return;
    this.active.add(k);
    upsertActiveMerge(k, repo, prNumber);
    void this.run(prNumber, repo, options).finally(() => {
      this.active.delete(k);
      deleteActiveMerge(k);
    });
  }

  /**
   * Restore in-flight merge loops from the active_merges table after a restart.
   * Called from server.ts alongside StuckSessionMonitor.rehydrate().
   *
   * Persistence pattern (shared with StuckSessionMonitor.timers and
   * ReviewOrchestrator.pendingSyncs): a SQLite table acts as the durable store;
   * rehydrate() re-creates the in-memory state on boot.
   *
   * Deliberately NOT persisted:
   * - SessionManager._lastDisplayStatus — broadcast de-dup cache; empty-on-boot
   *   is correct (status re-derives on the next incoming message).
   * - AgentSession tool-call Maps (pendingGHToolUseIds, pendingBashCommands,
   *   pendingPushFileToolUseIds) — per-session, per-message transient state that
   *   is correctly discarded on session resume.
   *
   * bootSweep() remains as belt-and-suspenders for PRs that became mergeable
   * while the server was down; rehydrate() handles truly in-flight loops.
   * The attempt() idempotent guard (active.has(k)) prevents double-runs when
   * both paths target the same PR.
   */
  rehydrate(): void {
    const rows = getAllActiveMerges();
    for (const row of rows) {
      logger.info(
        `[AutoMerger] rehydrate: resuming in-flight merge for PR #${row.pr_number} in ${row.repo}`,
      );
      this.attempt(row.pr_number, row.repo);
    }
    if (rows.length > 0) {
      logger.info(
        `[AutoMerger] rehydrate complete — resumed ${rows.length} in-flight merge(s)`,
      );
    }
  }

  private async run(
    prNumber: number,
    repo: string,
    options?: { bypassToggle?: boolean },
  ): Promise<void> {
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      logger.info(
        `[AutoMerger] PR #${prNumber}: no project for repo ${repo} — skipping`,
      );
      return;
    }
    if (!options?.bypassToggle && !project.autoMergeEnabled) return;

    const initialRow = getPRByNumber(prNumber, repo);
    if (!initialRow) return;
    if (isMergeBlockingPause(initialRow.pause_reason)) {
      logger.info(
        `[AutoMerger] PR #${prNumber}: paused (${initialRow.pause_reason}) — skipping`,
      );
      return;
    }
    if (initialRow.state !== 'open') return;
    // Independent re-check of the docs execution flow's never-auto-merged
    // gate — attempt()/run() is invoked directly by PRReviewService,
    // routes/prs.ts, routes/projects.ts's bypassToggle path, and rehydrate(),
    // all of which bypass getApprovedOpenPRs (and its own human_merge_only
    // exclusion) entirely. This is the one choke point every merge attempt
    // actually funnels through, so it is the only place this can be enforced
    // unconditionally, regardless of caller.
    if (initialRow.human_merge_only) {
      logger.info(
        `[AutoMerger] PR #${prNumber}: human_merge_only — never auto-merged, waiting for a human merge`,
      );
      return;
    }

    const ciCheckNames = loadOrchestratorConfig(
      project.projectDir,
    ).ci_check_name;

    const intervalSec = Math.max(1, runtimeSettings.ci_poll_interval_seconds);
    const intervalMs = Math.max(intervalSec * 1000, MIN_POLL_INTERVAL_MS);
    const deadline =
      Date.now() + Math.max(1, runtimeSettings.ci_poll_max_minutes) * 60_000;

    let etag: string | null = null;

    logger.info(
      `[AutoMerger] starting for PR #${prNumber} in ${repo} (interval=${intervalSec}s, max=${runtimeSettings.ci_poll_max_minutes}m)`,
    );

    while (Date.now() < deadline) {
      // Re-read the PR row each iteration so external pause/close updates are honored.
      const row = getPRByNumber(prNumber, repo);
      if (!row) return;
      if (isMergeBlockingPause(row.pause_reason)) {
        logger.info(
          `[AutoMerger] PR #${prNumber}: pause_reason set to '${row.pause_reason}' externally — aborting`,
        );
        return;
      }

      let poll;
      try {
        poll = await this.github.fetchPRStatusConditional(
          prNumber,
          repo,
          etag,
          ciCheckNames,
        );
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          this.handleRateLimit(err);
          return;
        }
        logger.warn(
          `[AutoMerger] PR #${prNumber}: status fetch failed: ${(err as Error).message}`,
        );
        await sleep(intervalMs);
        continue;
      }

      if (poll.status === 'not_modified') {
        await sleep(intervalMs);
        continue;
      }

      etag = poll.etag;

      if (poll.state === 'merged') {
        // PRMergeWatcher's regular poll will pick up the merged state; nothing to do here.
        return;
      }
      if (poll.state === 'closed') {
        await this.pauseWithReason(row, 'pr_closed');
        return;
      }

      const category = poll.mergeability.category;
      switch (category) {
        case 'clean': {
          const corpMode = getCorporateMode();
          if (corpMode.gates.requireHumanApproval) {
            let reviewDecision: PRReviewDecision | null;
            try {
              reviewDecision = await this.github.getReviewState(prNumber, repo);
            } catch (err) {
              if (err instanceof GitHubRateLimitError) {
                this.handleRateLimit(err);
                return;
              }
              logger.warn(
                `[AutoMerger] PR #${prNumber}: getReviewState failed: ${(err as Error).message}`,
              );
              await sleep(intervalMs);
              continue;
            }
            if (reviewDecision === 'CHANGES_REQUESTED') {
              await this.pauseWithReason(row, 'human_changes_requested');
              return;
            }
            if (reviewDecision !== 'APPROVED') {
              await this.maybeRequestReviewers(row);
              await this.pauseWithReason(row, 'awaiting_human_approval');
              return;
            }
          }
          await this.attemptMerge(row, ciCheckNames);
          return;
        }
        case 'ci_failed': {
          const headSha = poll.mergeability.headSha;
          if (headSha) {
            const billingBlock = await this.github.detectBillingBlock(
              headSha,
              repo,
            );
            if (billingBlock.blocked) {
              await this.pauseAsBillingBlocked(row, billingBlock.message ?? '');
              return;
            }
          }
          await this.pauseWithReason(
            row,
            'ci_failing',
            poll.mergeability.failingChecks.map((c) => c.name),
          );
          return;
        }
        case 'conflict':
          // Existing merge-conflict handling owns this case (see PRMergeWatcher
          // and the /merge route) — agent gets a rebase message; we don't pause.
          logger.info(
            `[AutoMerger] PR #${prNumber}: conflict — leaving to existing handling`,
          );
          return;
        case 'blocked':
          if (this.sessions) {
            await sendConflictNudge(this.sessions, row, 'blocked');
          }
          await this.pauseWithReason(row, 'auto_merge_failed');
          return;
        case 'unknown':
        default:
          await sleep(intervalMs);
          continue;
      }
    }

    // Timed out waiting for CI. Every branch above that observed an actual
    // CI failure ('ci_failed' category, or a 409/405 merge failure that
    // categorizes as ci_failed) already paused as 'ci_failing' and returned —
    // so reaching here means CI simply never finished reporting within the
    // deadline (still running/pending/unknown), not that it failed. Pause
    // with the non-blocking ci_not_completing reason so this loop's exit
    // frees the goroutine without stranding the PR as falsely CI-failed and
    // blocked — the scheduled sweep (register()) keeps re-attempting it
    // regardless of what this per-PR loop did.
    const finalRow = getPRByNumber(prNumber, repo);
    if (finalRow && !isMergeBlockingPause(finalRow.pause_reason)) {
      logger.info(
        `[AutoMerger] PR #${prNumber}: timed out after ${runtimeSettings.ci_poll_max_minutes}m — pausing as ci_not_completing`,
      );
      await this.pauseWithReason(finalRow, 'ci_not_completing');
    }
  }

  private async attemptMerge(
    pr: PullRequestRow,
    ciCheckNames: string[] = [],
  ): Promise<void> {
    // The docs execution flow's never-auto-merged output gate — re-checked
    // here, immediately before the actual GitHub merge API call, so no code
    // path through attemptMerge (however it got here) can ever merge a
    // human_merge_only PR.
    if (pr.human_merge_only) {
      logger.info(
        `[AutoMerger] PR #${pr.pr_number}: human_merge_only — refusing to merge, waiting for a human`,
      );
      return;
    }
    const commitTitle = pr.title ?? `Merge PR #${pr.pr_number}`;
    try {
      const result = await this.github.mergePR(
        pr.pr_number,
        commitTitle,
        pr.repo,
      );
      await this.mergeWatcher.handleMerged(pr, result.sha ?? null);
      this._concludeSessions(pr);
      recordEvent({
        event_type: 'pr_merged',
        actor_type: 'system',
        actor_id: null,
        project_id: getProjectByGithubRepo(pr.repo)?.id ?? null,
        task_id: pr.task_id ?? null,
        payload: {
          pr_number: pr.pr_number,
          repo: pr.repo,
          merge_sha: result.sha ?? null,
          source: 'poll',
        },
      });
      logger.info(
        `[AutoMerger] PR #${pr.pr_number}: squash-merged to ${pr.base_branch ?? 'dev'}`,
      );
    } catch (err) {
      // Still-draft retry: 405 "Pull Request is still a draft" → markPRReady then retry once.
      if (
        err instanceof GitHubApiError &&
        err.status === 405 &&
        /still a draft/i.test(err.body)
      ) {
        logger.warn(
          `[AutoMerger] PR #${pr.pr_number}: 405 still-draft — retrying markPRReady then merge`,
        );
        try {
          await this.github.markPRReady(pr.repo, pr.pr_number);
          updatePRDraftStatus(pr.pr_number, pr.repo, 0);
          const retryResult = await this.github.mergePR(
            pr.pr_number,
            commitTitle,
            pr.repo,
          );
          await this.mergeWatcher.handleMerged(pr, retryResult.sha ?? null);
          this._concludeSessions(pr);
          recordEvent({
            event_type: 'pr_merged',
            actor_type: 'system',
            actor_id: null,
            project_id: getProjectByGithubRepo(pr.repo)?.id ?? null,
            task_id: pr.task_id ?? null,
            payload: {
              pr_number: pr.pr_number,
              repo: pr.repo,
              merge_sha: retryResult.sha ?? null,
              source: 'ingest',
            },
          });
          logger.info(
            `[AutoMerger] PR #${pr.pr_number}: squash-merged to ${pr.base_branch ?? 'dev'}`,
          );
          return;
        } catch (retryErr) {
          logger.error(
            `[AutoMerger] PR #${pr.pr_number}: retry after markPRReady failed:`,
            retryErr,
          );
          if (this.sessions) {
            await sendConflictNudge(this.sessions, pr, 'draft_failed');
          }
          await this.pauseWithReason(pr, 'auto_merge_failed');
          return;
        }
      }

      const status: number | null =
        err instanceof GitHubApiError
          ? err.status
          : typeof (err as { status?: unknown }).status === 'number'
            ? (err as { status: number }).status
            : null;
      if (status === 409 || status === 405) {
        // Merge blocked — categorize so conflict / ci_failed get their normal handling.
        let category;
        try {
          category = await this.github.categorizeMergeability(
            pr.pr_number,
            pr.repo,
            ciCheckNames,
          );
        } catch {
          category = null;
        }
        if (category?.category === 'conflict') {
          if (category.rawMergeableState === 'behind') {
            // "Base branch was modified" race — pause and notify the code session.
            // clearStalePauses() will retry automatically after the configured delay.
            if (this.sessions) {
              await sendConflictNudge(this.sessions, pr, 'behind');
            }
            await this.pauseWithReason(pr, 'auto_merge_failed');
            return;
          }
          logger.info(
            `[AutoMerger] PR #${pr.pr_number}: merge failed — conflict, leaving to existing handling`,
          );
          return;
        }
        if (category?.category === 'ci_failed') {
          const headSha = category.headSha;
          if (headSha) {
            const billingBlock = await this.github.detectBillingBlock(
              headSha,
              pr.repo,
            );
            if (billingBlock.blocked) {
              await this.pauseAsBillingBlocked(pr, billingBlock.message ?? '');
              return;
            }
          }
          await this.pauseWithReason(
            pr,
            'ci_failing',
            category.failingChecks.map((c) => c.name),
          );
          return;
        }
      }
      logger.warn(
        `[AutoMerger] PR #${pr.pr_number}: merge failed: ${(err as Error).message}`,
      );
      await this.pauseWithReason(pr, 'auto_merge_failed');
    }
  }

  /**
   * Transition the coding session and paired review session from idle → done
   * immediately after a successful merge. Calling markSessionDone here (in the
   * AutoMerger merge-success path) is the single authoritative transition point
   * for auto-merged PRs, ensuring ConcludedSessionArchiver can reap them on the
   * next sweep without waiting for a backend restart.
   */
  private _concludeSessions(pr: PullRequestRow): void {
    const now = Date.now();
    if (pr.session_id) {
      markSessionDone(pr.session_id, now, pr.pr_url ?? null, 'auto_merger');
      recordPrAnchoredCompletingSignal(pr.session_id, 'pr_merged', now);
    }
    if (pr.review_session_id) {
      markSessionDone(
        pr.review_session_id,
        now,
        pr.pr_url ?? null,
        'auto_merger',
      );
      recordPrAnchoredCompletingSignal(pr.review_session_id, 'pr_merged', now);
    }
  }

  private async pauseAsBillingBlocked(
    pr: PullRequestRow,
    message: string,
  ): Promise<void> {
    setPauseReason(pr.pr_number, pr.repo, 'ci_billing_blocked');
    this.broadcast({
      type: 'ci_billing_blocked',
      prNumber: pr.pr_number,
      repo: pr.repo,
      message,
    });
    if (pr.task_id) {
      emitTaskUpdated(pr.task_id);
    }
    logger.info(
      `[AutoMerger] PR #${pr.pr_number}: billing/spending limit blocked — paused as ci_billing_blocked`,
    );
  }

  /**
   * Corporate-mode reviewer auto-assignment: when a PR is genuinely ready for
   * human eyes (CI-clean, AI-approved, no feedback still pending) and the
   * task names reviewers, un-draft the PR and request them. Fires once per PR
   * (reviewer_requested_at set-once marker) so the ~5s merge poll never
   * re-requests. Never throws — a bad username must not retry-storm the poller.
   */
  private async maybeRequestReviewers(pr: PullRequestRow): Promise<void> {
    if (pr.reviewer_requested_at !== null) return;

    let verdict: string | undefined;
    try {
      verdict = pr.review_result
        ? (JSON.parse(pr.review_result) as { verdict?: string }).verdict
        : undefined;
    } catch {
      verdict = undefined;
    }
    if (verdict !== 'approved') return;
    if (getPendingRoutedCommentCount(pr.pr_number, pr.repo) !== 0) return;

    const reviewers = this.resolveReviewers(pr.task_id);
    if (reviewers.length === 0) return;

    try {
      if (pr.draft === 1) {
        await this.github.markPRReady(pr.repo, pr.pr_number);
        updatePRDraftStatus(pr.pr_number, pr.repo, 0);
      }
      await this.github.requestReviewers(pr.repo, pr.pr_number, reviewers);
    } catch (err) {
      logger.warn(
        `[AutoMerger] PR #${pr.pr_number}: requestReviewers failed: ${(err as Error).message}`,
      );
    }
    markReviewerRequested(pr.pr_number, pr.repo);
  }

  /** Source-agnostic reviewer lookup: task_cache JSON carries reviewer regardless of task source. */
  private resolveReviewers(taskId: string | null): string[] {
    if (!taskId) return [];
    const cacheRow = getTaskCache(taskId);
    if (!cacheRow) return [];
    try {
      const task = JSON.parse(cacheRow.raw_json) as { reviewer?: string[] };
      return Array.isArray(task.reviewer) ? task.reviewer : [];
    } catch {
      return [];
    }
  }

  private async pauseWithReason(
    pr: PullRequestRow,
    reason:
      | 'ci_failing'
      | 'ci_not_completing'
      | 'auto_merge_failed'
      | 'pr_closed'
      | 'awaiting_human_approval'
      | 'human_changes_requested',
    failingCheckNames?: string[],
  ): Promise<void> {
    const struct = pauseReasonFromCanonical(reason);
    setPauseReason(pr.pr_number, pr.repo, reason);
    // ci_not_completing is source: 'ci' but semantically distinct from
    // ci_failing — CI hasn't reported a failure, it's just slow — so it must
    // not report a 'ci_failed' merge state (that would misreport the cause
    // and, per isMergeBlockingPause, is what the non-blocking classification
    // is specifically meant to avoid). Matched by capability
    // (source:'ci' + blocks_merge), not the 'ci_failing' literal, so a
    // future source:'ci'+blocking reason added to this function's param
    // union is reported as a real CI failure without this call site needing
    // its own update.
    const isCiFailurePause = struct.source === 'ci' && struct.blocks_merge;
    if (isCiFailurePause) {
      const names = failingCheckNames ?? [];
      updateMergeState(
        pr.pr_number,
        pr.repo,
        0,
        'ci_failed',
        names.length > 0 ? names : null,
      );
    } else if (struct.reason === 'auto_merge_failed') {
      // No native mergeability category to broadcast — just emit a message so
      // the dashboard surfaces the failure.
      updateMergeState(pr.pr_number, pr.repo, 0, 'unknown', null);
    }
    this.broadcast({
      type: 'pr_mergeability_changed',
      prNumber: pr.pr_number,
      repo: pr.repo,
      mergeable: !struct.blocks_merge,
      mergeState: isCiFailurePause ? 'ci_failed' : null,
      failingChecks:
        isCiFailurePause && failingCheckNames && failingCheckNames.length > 0
          ? failingCheckNames
          : undefined,
    });
    if (pr.task_id) {
      emitTaskUpdated(pr.task_id);
    }
    logger.info(
      `[AutoMerger] PR #${pr.pr_number}: paused with reason '${reason}'`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
