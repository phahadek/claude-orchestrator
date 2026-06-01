import type { PullRequestRow } from '../db/types';

/**
 * True when a PR is in a terminal-stale state: the review session produced an
 * 'incomplete' verdict AND no new push has arrived since (head_sha unchanged).
 *
 * These PRs cannot self-improve — the reviewer gave up and no agent has pushed
 * a fix. Polling their GitHub state every cycle wastes quota. Wave 2
 * periodic-recovery will eventually pick them up when a human intervenes.
 */
export function isTerminalStalePR(pr: PullRequestRow): boolean {
  if (!pr.review_result || !pr.head_sha) return false;
  let verdict: string | undefined;
  try {
    verdict = (JSON.parse(pr.review_result) as { verdict?: string }).verdict;
  } catch {
    return false;
  }
  return verdict === 'incomplete' && pr.head_sha === pr.last_reviewed_sha;
}
