import type { GitHubClient } from './GitHubClient';
import { getAllProjects } from '../config';
import { getPRByNumber, upsertPullRequest, lookupSessionByBranch } from '../db/queries';

/**
 * Boot-time sweep that ensures every open GitHub PR has a row in pull_requests.
 * Runs once after the backend starts. For missing rows, also attempts to derive
 * session_id from the PR's head_branch via lookupSessionByBranch.
 */
export async function runPRBootSweep(github: GitHubClient): Promise<void> {
  const projects = getAllProjects().filter((p) => p.githubRepo);
  if (projects.length === 0) return;

  console.log(`[PRBootSweep] scanning ${projects.length} project(s) for missing PR rows`);

  let inserted = 0;
  for (const project of projects) {
    const repo = project.githubRepo!;
    let openPRs;
    try {
      openPRs = await github.listOpenPRs(repo);
    } catch (err) {
      console.warn(`[PRBootSweep] failed to list open PRs for ${repo}:`, (err as Error).message);
      continue;
    }

    const now = new Date().toISOString();
    for (const pr of openPRs) {
      const existing = getPRByNumber(pr.id, repo);
      if (existing) continue;

      const sessionMatch = lookupSessionByBranch(pr.headBranch);
      upsertPullRequest({
        pr_number: pr.id,
        pr_url: pr.url,
        task_id: sessionMatch?.task_id ?? null,
        session_id: sessionMatch?.session_id ?? null,
        repo,
        title: pr.title,
        body: pr.body ?? null,
        head_branch: pr.headBranch,
        base_branch: pr.baseBranch,
        state: pr.state,
        draft: pr.draft ? 1 : 0,
        review_result: null,
        review_at: null,
        created_at: pr.createdAt,
        updated_at: pr.updatedAt,
        synced_at: now,
        review_iteration: 0,
        review_session_id: null,
        head_sha: pr.headSha,
        last_reviewed_sha: null,
        node_id: pr.nodeId,
        merge_state: pr.mergeableState,
        merge_state_checked_at: now,
      });

      inserted++;
      if (sessionMatch) {
        console.log(
          `[PRBootSweep] inserted PR #${pr.id} (${repo}) and linked session ${sessionMatch.session_id.slice(0, 8)} via head_branch "${pr.headBranch}"`,
        );
      } else {
        console.log(`[PRBootSweep] inserted missing PR #${pr.id} (${repo}) — no session match for head_branch "${pr.headBranch}"`);
      }
    }
  }

  console.log(`[PRBootSweep] done — inserted ${inserted} missing PR row(s)`);
}
