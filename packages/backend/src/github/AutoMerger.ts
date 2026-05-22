import { getProjectByGithubRepo, runtimeSettings } from '../config';
import { getPRByNumber, setPauseReason, updateMergeState } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import { GitHubApiError } from './types';
import type { PRMergeWatcher } from './PRMergeWatcher';
import type { PullRequestRow } from '../db/types';
import type { ServerMessage } from '../ws/types';
import { emitTaskUpdated } from '../routes/tasks';

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
  ) {}

  private key(prNumber: number, repo: string): string {
    return `${repo}#${prNumber}`;
  }

  /**
   * Try to auto-merge the given PR. Returns immediately (does not await the
   * polling loop). The loop runs to completion in the background.
   */
  attempt(prNumber: number, repo: string): void {
    const k = this.key(prNumber, repo);
    if (this.active.has(k)) return;
    this.active.add(k);
    void this.run(prNumber, repo).finally(() => this.active.delete(k));
  }

  private async run(prNumber: number, repo: string): Promise<void> {
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      console.log(
        `[AutoMerger] PR #${prNumber}: no project for repo ${repo} — skipping`,
      );
      return;
    }
    if (!project.autoMergeEnabled) return;

    const initialRow = getPRByNumber(prNumber, repo);
    if (!initialRow) return;
    if (initialRow.pause_reason !== null) {
      console.log(
        `[AutoMerger] PR #${prNumber}: paused (${initialRow.pause_reason}) — skipping`,
      );
      return;
    }
    if (initialRow.state !== 'open') return;

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
        poll = await this.github.fetchPRStatusConditional(prNumber, repo, etag);
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
        case 'clean':
          await this.attemptMerge(row);
          return;
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

  private async attemptMerge(pr: PullRequestRow): Promise<void> {
    const commitTitle = pr.title ?? `Merge PR #${pr.pr_number}`;
    try {
      const result = await this.github.mergePR(
        pr.pr_number,
        commitTitle,
        pr.repo,
      );
      await this.mergeWatcher.handleMerged(pr, result.sha ?? null);
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
    reason: 'ci_failing' | 'auto_merge_failed' | 'pr_closed',
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
    if (pr.notion_task_id) {
      emitTaskUpdated(pr.notion_task_id);
    }
    console.log(
      `[AutoMerger] PR #${pr.pr_number}: paused with reason '${reason}'`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
