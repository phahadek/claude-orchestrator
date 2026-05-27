import {
  getProjectByGithubRepo,
  getProjectById,
  runtimeSettings,
} from '../config';
import { recordEvent } from '../audit/AuditLog';
import {
  getPRByNumber,
  setPauseReason,
  updateMergeState,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
  markLocalBranchMerged,
  setLocalBranchPauseReason,
  getSession,
} from '../db/queries';
import type { GitHubClient, PRReviewDecision } from './GitHubClient';
import { GitHubApiError } from './types';
import { getCorporateMode } from '../config/corporateMode';
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

const MIN_POLL_INTERVAL_MS = 5_000;

/**
 * Drives the post-approval auto-merge flow. After review reaches an approved
 * verdict and CI turns green, squash-merges the PR to dev and lets
 * PRMergeWatcher complete the lifecycle. On any other outcome the task is
 * paused with a pause_reason so a human picks it up.
 *
 * Per-project — only runs for projects with `autoMergeEnabled === true`.
 * Skips PRs already paused (honors any existing pause_reason).
 */
export class AutoMerger {
  /** In-flight auto-merge loops keyed by `${repo}#${prNumber}` to prevent double-runs. */
  private active = new Set<string>();

  constructor(
    private github: GitHubClient,
    private mergeWatcher: PRMergeWatcher,
    private broadcast: (msg: ServerMessage) => void,
    private sessions?: SessionManager,
  ) {}

  private key(prNumber: number, repo: string): string {
    return `${repo}#${prNumber}`;
  }

  /**
   * Poll both pull_requests and local_branches for merge-ready items and
   * dispatch to the appropriate merge handler. PRs go through the existing
   * attempt() loop; local branches are squash-merged immediately.
   */
  async pollOnce(): Promise<void> {
    const approvedPRs = getApprovedOpenPRs();
    for (const pr of approvedPRs) {
      this.attempt(pr.pr_number, pr.repo);
    }

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
      console.warn(
        `[AutoMerger] local branch #${row.id} (${row.branch_name}): session ${row.session_id} not found — skipping`,
      );
      return;
    }

    const worktreePath = session.worktree_path;
    if (!worktreePath) {
      console.warn(
        `[AutoMerger] local branch #${row.id} (${row.branch_name}): no worktree_path on session — skipping`,
      );
      return;
    }

    const hasConflict = await detectMergeConflict(
      worktreePath,
      row.base_branch,
      row.branch_name,
    ).catch((err: unknown) => {
      console.warn(
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
            console.warn(
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
      console.warn(
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
              console.warn(
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
          .catch((err: unknown) =>
            console.warn(
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

    console.log(
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
    void this.run(prNumber, repo, options).finally(() => this.active.delete(k));
  }

  private async run(
    prNumber: number,
    repo: string,
    options?: { bypassToggle?: boolean },
  ): Promise<void> {
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      console.log(
        `[AutoMerger] PR #${prNumber}: no project for repo ${repo} — skipping`,
      );
      return;
    }
    if (!options?.bypassToggle && !project.autoMergeEnabled) return;

    const initialRow = getPRByNumber(prNumber, repo);
    if (!initialRow) return;
    if (initialRow.pause_reason !== null) {
      console.log(
        `[AutoMerger] PR #${prNumber}: paused (${initialRow.pause_reason}) — skipping`,
      );
      return;
    }
    if (initialRow.state !== 'open') return;

    const ciCheckNames = loadOrchestratorConfig(
      project.projectDir,
    ).ci_check_name;

    const intervalSec = Math.max(1, runtimeSettings.ci_poll_interval_seconds);
    const intervalMs = Math.max(intervalSec * 1000, MIN_POLL_INTERVAL_MS);
    const deadline =
      Date.now() + Math.max(1, runtimeSettings.ci_poll_max_minutes) * 60_000;

    let etag: string | null = null;

    console.log(
      `[AutoMerger] starting for PR #${prNumber} in ${repo} (interval=${intervalSec}s, max=${runtimeSettings.ci_poll_max_minutes}m)`,
    );

    while (Date.now() < deadline) {
      // Re-read the PR row each iteration so external pause/close updates are honored.
      const row = getPRByNumber(prNumber, repo);
      if (!row) return;
      if (row.pause_reason !== null) {
        console.log(
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
        console.warn(
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
              console.warn(
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
              await this.pauseWithReason(row, 'awaiting_human_approval');
              return;
            }
          }
          await this.attemptMerge(row, ciCheckNames);
          return;
        }
        case 'ci_failed':
          await this.pauseWithReason(
            row,
            'ci_failing',
            poll.mergeability.failingChecks.map((c) => c.name),
          );
          return;
        case 'conflict':
          // Existing merge-conflict handling owns this case (see PRMergeWatcher
          // and the /merge route) — agent gets a rebase message; we don't pause.
          console.log(
            `[AutoMerger] PR #${prNumber}: conflict — leaving to existing handling`,
          );
          return;
        case 'blocked':
          await this.pauseWithReason(row, 'auto_merge_failed');
          return;
        case 'unknown':
        default:
          await sleep(intervalMs);
          continue;
      }
    }

    // Timed out waiting for CI — pause as ci_failing (semantically: CI did not pass).
    const finalRow = getPRByNumber(prNumber, repo);
    if (finalRow && finalRow.pause_reason === null) {
      console.log(
        `[AutoMerger] PR #${prNumber}: timed out after ${runtimeSettings.ci_poll_max_minutes}m — pausing`,
      );
      await this.pauseWithReason(finalRow, 'ci_failing');
    }
  }

  private async attemptMerge(
    pr: PullRequestRow,
    ciCheckNames: string[] = [],
  ): Promise<void> {
    const commitTitle = pr.title ?? `Merge PR #${pr.pr_number}`;
    try {
      const result = await this.github.mergePR(
        pr.pr_number,
        commitTitle,
        pr.repo,
      );
      await this.mergeWatcher.handleMerged(pr, result.sha ?? null);
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
        },
      });
      console.log(
        `[AutoMerger] PR #${pr.pr_number}: squash-merged to ${pr.base_branch ?? 'dev'}`,
      );
    } catch (err) {
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
          console.log(
            `[AutoMerger] PR #${pr.pr_number}: merge failed — conflict, leaving to existing handling`,
          );
          return;
        }
        if (category?.category === 'ci_failed') {
          await this.pauseWithReason(
            pr,
            'ci_failing',
            category.failingChecks.map((c) => c.name),
          );
          return;
        }
      }
      console.warn(
        `[AutoMerger] PR #${pr.pr_number}: merge failed: ${(err as Error).message}`,
      );
      await this.pauseWithReason(pr, 'auto_merge_failed');
    }
  }

  private async pauseWithReason(
    pr: PullRequestRow,
    reason:
      | 'ci_failing'
      | 'auto_merge_failed'
      | 'pr_closed'
      | 'awaiting_human_approval'
      | 'human_changes_requested',
    failingCheckNames?: string[],
  ): Promise<void> {
    setPauseReason(pr.pr_number, pr.repo, reason);
    if (reason === 'auto_merge_failed') {
      // No native mergeability category to broadcast — just emit a message so
      // the dashboard surfaces the failure.
      updateMergeState(pr.pr_number, pr.repo, 0, 'unknown', null);
    } else if (reason === 'ci_failing') {
      const names = failingCheckNames ?? [];
      updateMergeState(
        pr.pr_number,
        pr.repo,
        0,
        'ci_failed',
        names.length > 0 ? names : null,
      );
    }
    this.broadcast({
      type: 'pr_mergeability_changed',
      prNumber: pr.pr_number,
      repo: pr.repo,
      mergeable: false,
      mergeState: reason === 'ci_failing' ? 'ci_failed' : null,
      failingChecks:
        reason === 'ci_failing' &&
        failingCheckNames &&
        failingCheckNames.length > 0
          ? failingCheckNames
          : undefined,
    });
    if (pr.task_id) {
      emitTaskUpdated(pr.task_id);
    }
    console.log(
      `[AutoMerger] PR #${pr.pr_number}: paused with reason '${reason}'`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
