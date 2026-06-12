import { recordEvent } from '../audit/AuditLog';
import { setConflictNudgeSha } from '../db/queries';
import type { SessionManager } from '../session/SessionManager';
import type { PullRequestRow } from '../db/types';
import {
  formatBaseBranchModifiedFeedback,
  formatMergeConflictFeedback,
} from './reviewUtils';

export type ConflictNudgeCause =
  | 'conflict'
  | 'behind'
  | 'blocked'
  | 'draft_failed';

function buildNudgeMessage(
  pr: PullRequestRow,
  cause: ConflictNudgeCause,
): string {
  const baseBranch = pr.base_branch ?? 'dev';
  const headBranch = pr.head_branch ?? `feature/pr-${pr.pr_number}`;
  switch (cause) {
    case 'behind':
      return formatBaseBranchModifiedFeedback({
        prNumber: pr.pr_number,
        baseBranch,
      });
    case 'draft_failed':
      return (
        `## Merge Paused — PR Could Not Be Marked Ready\n\n` +
        `PR #${pr.pr_number} failed to auto-merge because it could not be marked as ready for review.\n\n` +
        `**Action required:** Rebase onto \`${baseBranch}\`, resolve any conflicts, and push to retry the merge.`
      );
    case 'conflict':
    case 'blocked':
    default:
      return formatMergeConflictFeedback({
        branchName: headBranch,
        baseBranch,
      });
  }
}

/**
 * Send a conflict/rebase nudge to the code session for a PR that is paused
 * with an auto_merge_failed reason due to a session-actionable cause.
 *
 * SHA-keyed dedup via conflict_nudge_sha: if head_sha matches the last nudge
 * SHA the nudge is skipped. A new push that still conflicts correctly re-nudges;
 * clearStalePauses re-fail cycles do not re-nudge.
 *
 * Failed delivery emits an audit event (retryable by the catch-up sweep) instead
 * of just a console.warn.
 */
export async function sendConflictNudge(
  sessions: SessionManager,
  pr: PullRequestRow,
  cause: ConflictNudgeCause,
): Promise<void> {
  if (!pr.session_id || !pr.head_sha) return;
  if (pr.head_sha === pr.conflict_nudge_sha) return;

  // Record before send so a crash mid-delivery doesn't re-nudge for same SHA.
  setConflictNudgeSha(pr.pr_number, pr.repo, pr.head_sha);

  const message = buildNudgeMessage(pr, cause);
  try {
    await sessions.sendOrResume(pr.session_id, message);
  } catch (err) {
    recordEvent({
      event_type: 'conflict_nudge_delivery_failed',
      actor_type: 'system',
      actor_id: null,
      project_id: null,
      task_id: pr.task_id ?? null,
      payload: {
        pr_number: pr.pr_number,
        repo: pr.repo,
        session_id: pr.session_id,
        head_sha: pr.head_sha,
        cause,
        error: (err as Error).message,
      },
    });
  }
}
