import type { GitHubClient } from './GitHubClient';
import type { SessionManager } from '../session/SessionManager';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import { getAllOpenPRs, updatePRState, updateMergeState } from '../db/queries';
import { emitTaskUpdated } from '../routes/tasks';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class PRMergeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
    private notion: NotionClient,
  ) {}

  private broadcast(msg: ServerMessage): void {
    this.sessions.emit('message', msg);
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
    const openPRs = getAllOpenPRs();
    for (const pr of openPRs) {
      await this.checkPR(pr);
    }
  }

  private async checkPR(pr: PullRequestRow): Promise<void> {
    let state: string;
    try {
      state = await this.github.getPRState(pr.pr_number, pr.repo);
    } catch (err) {
      console.warn(`[PRMergeWatcher] getPRState failed for PR #${pr.pr_number}:`, (err as Error).message);
      return;
    }

    if (state === 'merged') {
      await this.handleMerged(pr, null);
    } else if (state === 'closed') {
      updatePRState(pr.pr_number, pr.repo, 'closed');
      this.broadcast({ type: 'pr_closed', prNumber: pr.pr_number, repo: pr.repo });
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

    let mergeable: boolean | null;
    let mergeableState: string | null;
    try {
      ({ mergeable, mergeableState } = await this.github.getMergeability(pr.pr_number, pr.repo));
    } catch (err) {
      console.warn(`[PRMergeWatcher] getMergeability failed for PR #${pr.pr_number}:`, (err as Error).message);
      return;
    }

    // Skip if GitHub hasn't computed mergeability yet
    if (mergeable === null && mergeableState === null) return;

    const mergeableInt = mergeable === null ? null : (mergeable ? 1 : 0);
    const prevMergeState = pr.merge_state;
    const newMergeState = mergeableState;

    // Only update if state changed
    if (prevMergeState === newMergeState) return;

    updateMergeState(pr.pr_number, pr.repo, mergeableInt, newMergeState);
    this.broadcast({
      type: 'pr_state_changed',
      prNumber: pr.pr_number,
      repo: pr.repo,
      mergeable,
      mergeState: newMergeState,
    });
    if (pr.notion_task_id) {
      emitTaskUpdated(pr.notion_task_id);
    }

    if (newMergeState === 'dirty') {
      console.log(`[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} has merge conflicts`);
    }
  }

  async handleMerged(pr: PullRequestRow, sha: string | null): Promise<void> {
    updatePRState(pr.pr_number, pr.repo, 'merged');

    // End coding session gracefully (stdin close → clean CLI exit)
    if (pr.session_id) {
      this.sessions.endSession(pr.session_id);
    }

    // End review session gracefully (stdin close → clean CLI exit)
    if (pr.review_session_id) {
      this.sessions.endSession(pr.review_session_id);
    }

    // Update Notion task to Done
    if (pr.notion_task_id) {
      await this.notion.updateStatus(pr.notion_task_id, '✅ Done')
        .then(() => {
          this.broadcast({
            type: 'task_status_changed',
            notionTaskId: pr.notion_task_id!,
            newStatus: '✅ Done',
          });
          emitTaskUpdated(pr.notion_task_id!);
        })
        .catch((err: unknown) =>
          console.warn(`[PRMergeWatcher] Notion updateStatus failed:`, (err as Error).message),
        );
    }

    this.broadcast({
      type: 'pr_merged',
      prNumber: pr.pr_number,
      repo: pr.repo,
      sha: sha ?? '',
    });
  }
}
