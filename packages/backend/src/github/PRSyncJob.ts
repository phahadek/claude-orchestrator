import { config } from '../config.js';
import { upsertPullRequest } from '../db/queries.js';
import type { GitHubClient } from './GitHubClient.js';

export class PRSyncJob {
  constructor(private github: GitHubClient) {}

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
            review_result: null,
            review_at: null,
            created_at: pr.createdAt,
            updated_at: pr.updatedAt,
            synced_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn(`[PRSyncJob] sync failed for ${repo}:`, (err as Error).message);
      }
    }
  }
}
