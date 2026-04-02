import { config } from '../config';
import { upsertPullRequest, getOpenPRs, updatePRState } from '../db/queries';
import type { GitHubClient } from './GitHubClient';
import type { PRMergeWatcher } from './PRMergeWatcher';

export class PRSyncJob {
  private mergeWatcher: PRMergeWatcher | null = null;

  constructor(private github: GitHubClient) {}

  setMergeWatcher(watcher: PRMergeWatcher): void {
    this.mergeWatcher = watcher;
  }

  async run(): Promise<void> {
    for (const project of config.projects) {
      if (!project.githubRepo) continue;
      const repo = project.githubRepo;
      try {
        const prs = await this.github.listOpenPRs(repo);
        for (const pr of prs) {
          upsertPullRequest({
            pr_number: pr.id,
            pr_url: pr.url,
            notion_task_id: null,
            session_id: null,
            repo,
            title: pr.title,
            body: pr.body,
            head_branch: pr.headBranch,
            base_branch: pr.baseBranch,
            state: pr.state,
            draft: pr.draft ? 1 : 0,
            review_result: null,
            review_at: null,
            created_at: pr.createdAt,
            updated_at: pr.updatedAt,
            synced_at: new Date().toISOString(),
          });
        }

        // Reconcile stale local open PRs against GitHub
        const openNumbers = new Set(prs.map((p) => p.id));
        const localOpenPRs = getOpenPRs(repo);
        for (const pr of localOpenPRs) {
          if (!openNumbers.has(pr.pr_number)) {
            const state = await this.github.getPRState(pr.pr_number, repo);
            if (state === 'merged' && this.mergeWatcher) {
              // Delegate to PRMergeWatcher for full lifecycle (kill sessions, update Notion, broadcast)
              await this.mergeWatcher.handleMerged(pr, null);
            } else {
              updatePRState(pr.pr_number, repo, state);
            }
          }
        }
      } catch (err) {
        console.warn(`[PRSyncJob] sync failed for ${repo}:`, (err as Error).message);
      }
    }
  }
}
