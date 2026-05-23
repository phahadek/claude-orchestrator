import type { GitHubClient } from './GitHubClient';
import type { MergeabilityCategory } from './types';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getProjectByGithubRepo } from '../config';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import type { AutoMerger } from './AutoMerger';
import {
  getAllOpenPRs,
  updatePRState,
  updateMergeState,
  getPRByNumber,
  setPauseReason,
} from '../db/queries';
import { emitTaskUpdated } from '../routes/tasks';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class PRMergeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * True until the first poll after boot completes. On that first poll, PRs
   * that GitHub reports as already merged are state-transitioned in SQLite
   * without emitting pr_merged — otherwise a backend restart re-fires merge
   * notifications for every PR that closed while the backend was down.
   */
  private firstPollPending = true;
  private autoMerger: AutoMerger | undefined;

  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
    /**
     * Optional fixed task backend. When provided (typically by tests), all status
     * updates go through it. In production this is left undefined and the backend
     * is resolved per-call via getTaskBackend(project.id).
     */
    private taskBackendOverride: TaskBackend | undefined,
    private broadcast: (msg: ServerMessage) => void,
  ) {}

  setAutoMerger(autoMerger: AutoMerger): void {
    this.autoMerger = autoMerger;
  }

  private resolveBackendForRepo(repo: string): TaskBackend | undefined {
    if (this.taskBackendOverride) return this.taskBackendOverride;
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      console.warn(
        `[PRMergeWatcher] no project found for repo ${repo} — skipping task backend update`,
      );
      return undefined;
    }
    return getTaskBackend(project.id);
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((err: unknown) =>
        console.warn('[PRMergeWatcher] poll error:', (err as Error).message),
      );
    }, intervalMs);
    console.log(`[PRMergeWatcher] started (interval=${intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    const silentMerges = this.firstPollPending;
    const openPRs = getAllOpenPRs();
    for (const pr of openPRs) {
      await this.checkPR(pr, silentMerges);
    }
    this.firstPollPending = false;
  }

  private async checkPR(
    pr: PullRequestRow,
    silentMerges: boolean,
  ): Promise<void> {
    let state: string;
    try {
      state = await this.github.getPRState(pr.pr_number, pr.repo);
    } catch (err) {
      console.warn(
        `[PRMergeWatcher] getPRState failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return;
    }

    if (state === 'merged') {
      await this.handleMerged(pr, null, { silent: silentMerges });
    } else if (state === 'closed') {
      updatePRState(pr.pr_number, pr.repo, 'closed');
      this.broadcast({
        type: 'pr_closed',
        prNumber: pr.pr_number,
        repo: pr.repo,
      });
    } else {
      // PR is still open — check mergeability for approved PRs
      await this.checkMergeability(pr);
    }
  }

  private async checkMergeability(pr: PullRequestRow): Promise<void> {
    // Only poll mergeability for PRs that have an approved verdict
    if (!pr.review_result) return;
    let verdict: string | undefined;
    try {
      const parsed = JSON.parse(pr.review_result) as { verdict?: string };
      verdict = parsed.verdict;
    } catch {
      return;
    }
    if (verdict !== 'approved') return;
    await this.runMergeabilityCheck(pr);
  }

  /**
   * Run an immediate mergeability check for the given PR, regardless of verdict.
   * Called after a review completes with verdict 'approved' so the DB merge_state
   * and Merge button reflect current state without waiting for the next 5-min poll.
   */
  async checkMergeabilityNow(prNumber: number, repo: string): Promise<void> {
    const pr = getPRByNumber(prNumber, repo);
    if (!pr) return;
    await this.runMergeabilityCheck(pr);
  }

  private async runMergeabilityCheck(pr: PullRequestRow): Promise<void> {
    if (pr.state === 'merged' || pr.state === 'closed') return;

    let category: MergeabilityCategory;
    try {
      category = await this.github.categorizeMergeability(
        pr.pr_number,
        pr.repo,
      );
    } catch (err) {
      console.warn(
        `[PRMergeWatcher] categorizeMergeability failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return;
    }

    // Re-read DB after the network round-trip. If the PR merged or closed while
    // we were waiting on GitHub, suppress all downstream side effects — the
    // session was endSession()'d on merge and we must not sendOrResume it back to life.
    const fresh = getPRByNumber(pr.pr_number, pr.repo);
    if (fresh?.state === 'merged' || fresh?.state === 'closed') return;

    // Skip if GitHub hasn't computed mergeability yet
    if (category.category === 'unknown' && category.rawMergeableState === null)
      return;

    const failingNames = category.failingChecks.map((c) => c.name);
    const prevFailingNames = parseFailingChecksRaw(pr.failing_checks);
    const stateChanged = pr.merge_state !== category.mergeState;
    const failingChecksChanged = !arraysShallowEqual(
      prevFailingNames,
      failingNames,
    );

    // Only update + broadcast if something actually changed.
    if (!stateChanged && !failingChecksChanged) {
      this.tryCIFailingRecovery(pr, category.mergeState);
      return;
    }

    const mergeableInt = category.category === 'clean' ? 1 : 0;
    const failingNamesOrNull = failingNames.length > 0 ? failingNames : null;
    updateMergeState(
      pr.pr_number,
      pr.repo,
      mergeableInt,
      category.mergeState,
      failingNamesOrNull,
    );
    this.broadcast({
      type: 'pr_mergeability_changed',
      prNumber: pr.pr_number,
      repo: pr.repo,
      mergeable: category.category === 'clean',
      mergeState: category.mergeState,
      failingChecks: failingNamesOrNull,
    });
    if (pr.notion_task_id) {
      emitTaskUpdated(pr.notion_task_id);
    }

    this.tryCIFailingRecovery(pr, category.mergeState);

    // Send session messages only when the state itself transitioned, so the
    // agent doesn't get re-pinged every 5-minute poll for unchanged states.
    if (!stateChanged) return;

    if (category.category === 'conflict') {
      console.log(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} has merge conflicts`,
      );
      if (pr.session_id) {
        const baseBranch = pr.base_branch ?? 'dev';
        const msg = `PR #${pr.pr_number} has merge conflicts with the base branch. Rebase onto \`${baseBranch}\`, resolve the conflicts, and push the fixed branch.`;
        this.sessions
          .sendOrResume(pr.session_id, msg)
          .catch((err: unknown) =>
            console.warn(
              `[PRMergeWatcher] sendOrResume failed for session ${pr.session_id}:`,
              (err as Error).message,
            ),
          );
      }
    } else if (category.category === 'ci_failed') {
      console.log(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} has failing CI checks: ${failingNames.join(', ') || '(unknown)'}`,
      );
      if (pr.session_id) {
        const msg =
          failingNames.length > 0
            ? `PR #${pr.pr_number} cannot be merged because the following CI checks are failing: ${failingNames.join(', ')}. Investigate the failures and push a fix.`
            : `PR #${pr.pr_number} cannot be merged because required CI checks are failing. Investigate the failures and push a fix.`;
        this.sessions
          .sendOrResume(pr.session_id, msg)
          .catch((err: unknown) =>
            console.warn(
              `[PRMergeWatcher] sendOrResume failed for session ${pr.session_id}:`,
              (err as Error).message,
            ),
          );
      }
    } else if (category.category === 'blocked') {
      console.log(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} is blocked by branch protection`,
      );
    }
  }

  private tryCIFailingRecovery(
    pr: PullRequestRow,
    newMergeState: string,
  ): void {
    if (pr.pause_reason !== 'ci_failing' || newMergeState !== 'clean') return;
    setPauseReason(pr.pr_number, pr.repo, null);
    console.log(
      `[PRMergeWatcher] PR #${pr.pr_number} CI recovered to clean — clearing ci_failing pause and retrying AutoMerger`,
    );
    this.broadcast({
      type: 'pr_pause_cleared',
      prNumber: pr.pr_number,
      repo: pr.repo,
    });
    this.autoMerger?.attempt(pr.pr_number, pr.repo);
  }

  /**
   * @param options.silent When true, the SQLite state transition still happens
   *   (and sessions/Notion updates run) but the pr_merged broadcast is
   *   suppressed. Used by poll() on the first cycle after boot to avoid
   *   re-firing notifications for PRs that merged while the backend was down.
   */
  async handleMerged(
    pr: PullRequestRow,
    sha: string | null,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    updatePRState(pr.pr_number, pr.repo, 'merged');

    // End coding session gracefully (stdin close → clean CLI exit)
    if (pr.session_id) {
      this.sessions.endSession(pr.session_id);
    }

    // End review session gracefully (stdin close → clean CLI exit)
    if (pr.review_session_id) {
      this.sessions.endSession(pr.review_session_id);
    }

    // Update task to Done via the project-scoped task backend
    if (pr.notion_task_id) {
      const backend = this.resolveBackendForRepo(pr.repo);
      if (backend) {
        await backend
          .updateStatus(pr.notion_task_id, '✅ Done')
          .then(() => {
            this.broadcast({
              type: 'task_status_changed',
              notionTaskId: pr.notion_task_id!,
              newStatus: '✅ Done',
            });
            emitTaskUpdated(pr.notion_task_id!);
          })
          .catch((err: unknown) =>
            console.warn(
              `[PRMergeWatcher] task backend updateStatus failed:`,
              (err as Error).message,
            ),
          );
      }
    }

    if (!options.silent) {
      this.broadcast({
        type: 'pr_merged',
        prNumber: pr.pr_number,
        repo: pr.repo,
        sha: sha ?? '',
      });
    }
  }
}

function parseFailingChecksRaw(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function arraysShallowEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
