import type { GitHubClient } from './GitHubClient';
import type { SessionManager } from '../session/SessionManager';
import {
  getAllOpenPRs,
  getRoutedCommentIds,
  markCommentsRouted,
  setPauseReason,
  getSession,
  getSetting,
} from '../db/queries';
import { formatHumanReviewFeedback, type HumanComment } from './reviewUtils';
import type { PullRequestRow } from '../db/types';

const WATCHABLE_PAUSE_REASONS: ReadonlySet<string | null> = new Set([
  null,
  'awaiting_human_approval',
  'human_changes_requested',
]);

function getAIReviewerUsernames(): Set<string> {
  const raw = getSetting('ai_reviewer_usernames');
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
  } catch {
    /* ignore malformed */
  }
  return new Set();
}

/**
 * Polls open PRs for new human reviewer comments and routes them to the
 * corresponding coding session via SessionManager.send(). Deduplicates via
 * the pr_review_comments_routed table so comments are only sent once.
 *
 * Design: piggybacked on the AutoMerger poll cadence — pollAll() is called
 * from a setInterval in server.ts at ~5-10s so human feedback reaches the
 * coding session promptly without a separate poll infrastructure.
 */
export class ReviewerCommentsWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
  ) {}

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollAll().catch((err: unknown) =>
        console.warn(
          '[ReviewerCommentsWatcher] pollAll error:',
          (err as Error).message,
        ),
      );
    }, intervalMs);
    console.log(`[ReviewerCommentsWatcher] started (interval=${intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollAll(): Promise<void> {
    const openPRs = getAllOpenPRs();
    const watchable = openPRs.filter(
      (pr) =>
        pr.session_id !== null && WATCHABLE_PAUSE_REASONS.has(pr.pause_reason),
    );
    for (const pr of watchable) {
      try {
        await this.pollPR(pr);
      } catch (err) {
        console.warn(
          `[ReviewerCommentsWatcher] poll failed for PR #${pr.pr_number} in ${pr.repo}:`,
          (err as Error).message,
        );
      }
    }
  }

  private async pollPR(pr: PullRequestRow): Promise<void> {
    const aiUsernames = getAIReviewerUsernames();
    const routedIds = getRoutedCommentIds(pr.pr_number, pr.repo);

    const [reviews, reviewComments, issueComments] = await Promise.all([
      this.github.listPRReviews(pr.pr_number, pr.repo),
      this.github.listPRReviewComments(pr.pr_number, pr.repo),
      this.github.listPRIssueComments(pr.pr_number, pr.repo),
    ]);

    const humanReviews = reviews.filter((r) => !aiUsernames.has(r.author));

    const hasChangesRequested = humanReviews.some(
      (r) => r.state === 'CHANGES_REQUESTED',
    );

    const newComments: HumanComment[] = [];

    for (const review of humanReviews) {
      if (!review.body?.trim()) continue;
      const id = `rv_${review.id}`;
      if (!routedIds.has(id)) {
        newComments.push({ id, author: review.author, body: review.body });
      }
    }

    for (const c of reviewComments) {
      if (aiUsernames.has(c.author)) continue;
      const id = `rc_${c.id}`;
      if (!routedIds.has(id)) {
        newComments.push({
          id,
          author: c.author,
          body: c.body,
          path: c.path,
          line: c.line,
        });
      }
    }

    for (const c of issueComments) {
      if (aiUsernames.has(c.author)) continue;
      const id = `ic_${c.id}`;
      if (!routedIds.has(id)) {
        newComments.push({ id, author: c.author, body: c.body });
      }
    }

    if (hasChangesRequested && pr.pause_reason === 'awaiting_human_approval') {
      setPauseReason(pr.pr_number, pr.repo, 'human_changes_requested');
      console.log(
        `[ReviewerCommentsWatcher] PR #${pr.pr_number}: CHANGES_REQUESTED — transitioning awaiting_human_approval → human_changes_requested`,
      );
    }

    if (newComments.length === 0) return;

    const sessionId = pr.session_id!;
    const sessionRow = getSession(sessionId);
    if (
      !sessionRow ||
      sessionRow.status === 'done' ||
      sessionRow.status === 'error' ||
      sessionRow.status === 'killed'
    ) {
      console.warn(
        `[ReviewerCommentsWatcher] PR #${pr.pr_number}: session ${sessionId.slice(0, 8)} is not alive — skipping comment routing`,
      );
      return;
    }

    const feedback = formatHumanReviewFeedback(
      pr.pr_number,
      newComments,
      hasChangesRequested,
    );
    this.sessions.send(sessionId, feedback);
    markCommentsRouted(
      pr.pr_number,
      pr.repo,
      newComments.map((c) => c.id),
    );

    console.log(
      `[ReviewerCommentsWatcher] routed ${newComments.length} new human comment(s) to session ${sessionId.slice(0, 8)} for PR #${pr.pr_number}`,
    );
  }
}
