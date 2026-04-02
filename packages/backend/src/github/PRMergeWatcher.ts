import type { GitHubClient } from './GitHubClient';
import type { SessionManager } from '../session/SessionManager';
import type { NotionClient } from '../notion/NotionClient';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import { getAllOpenPRs, updatePRState } from '../db/queries';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class PRMergeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
    private notion: NotionClient,
    private broadcast: (msg: ServerMessage) => void,
  ) {}

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
