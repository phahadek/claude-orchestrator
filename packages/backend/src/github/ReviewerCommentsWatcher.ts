import { logger } from '../logger';
import type { GitHubClient } from './GitHubClient';
import type { SessionManager } from '../session/SessionManager';
import { GitHubRateLimitError } from './types';
import type { Scheduler } from '../orchestration/Scheduler';
import {
  getAllOpenPRs,
  getRoutedCommentIds,
  markCommentsRouted,
  setPauseReason,
  getSession,
} from '../db/queries';
import { typedGetSetting } from '../config/settings';
import { getProjectByGithubRepo } from '../config';
import { isTerminalStalePR } from './pollUtils';
import { formatHumanReviewFeedback, type HumanComment } from './reviewUtils';
import type { PullRequestRow } from '../db/types';
import type { ServerMessage } from '../ws/types';

const WATCHABLE_PAUSE_REASONS: ReadonlySet<string | null> = new Set([
  null,
  'awaiting_human_approval',
  'human_changes_requested',
]);

function getAIReviewerUsernames(): Set<string> {
  return new Set(typedGetSetting('ai_reviewer_usernames'));
}

export function isBotAuthor(
  author: string,
  authorType: string,
  denyList: ReadonlySet<string>,
  allowList: ReadonlySet<string>,
): boolean {
  if (allowList.has(author)) return false;
  if (denyList.has(author)) return true;
  return authorType === 'Bot' || author.endsWith('[bot]');
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
  private pausedUntil: Date | null = null;
  private rateLimitBroadcasted = false;

  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
    private broadcast: (msg: ServerMessage) => void = () => {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'reviewer_comments_watcher',
      intervalMs: 10_000,
      runOnBoot: false,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.pollAll();
      },
      onError: (err: unknown) =>
        logger.warn(
          '[ReviewerCommentsWatcher] pollAll error:',
          (err as Error).message,
        ),
    });
  }

  private handleRateLimit(err: GitHubRateLimitError): void {
    this.pausedUntil = err.resetAt;
    if (!this.rateLimitBroadcasted) {
      this.rateLimitBroadcasted = true;
      logger.warn(
        `[ReviewerCommentsWatcher] GitHub rate-limited; backing off until ${err.resetAt.toISOString()}`,
      );
      this.broadcast({
        type: 'github_rate_limit_hit',
        resetAt: err.resetAt.toISOString(),
        limit: err.limit,
        used: err.used,
      });
    }
  }

  async pollAll(): Promise<void> {
    if (this.pausedUntil !== null) {
      if (Date.now() < this.pausedUntil.getTime()) return;
      this.pausedUntil = null;
      this.rateLimitBroadcasted = false;
      this.broadcast({ type: 'github_rate_limit_cleared' });
    }
    const openPRs = getAllOpenPRs();
    const watchable = openPRs.filter(
      (pr) =>
        pr.session_id !== null &&
        WATCHABLE_PAUSE_REASONS.has(pr.pause_reason) &&
        getProjectByGithubRepo(pr.repo) !== null &&
        !isTerminalStalePR(pr),
    );
    for (const pr of watchable) {
      try {
        await this.pollPR(pr);
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          this.handleRateLimit(err);
          return;
        }
        logger.warn(
          `[ReviewerCommentsWatcher] poll failed for PR #${pr.pr_number} in ${pr.repo}:`,
          (err as Error).message,
        );
      }
    }
  }

  private async pollPR(pr: PullRequestRow): Promise<void> {
    const aiUsernames = getAIReviewerUsernames();
    const botDenyList = new Set(typedGetSetting('bot_comment_deny_list'));
    const botAllowList = new Set(typedGetSetting('bot_comment_allow_list'));
    const routedIds = getRoutedCommentIds(pr.pr_number, pr.repo);

    const shouldExclude = (author: string, authorType: string): boolean =>
      aiUsernames.has(author) ||
      isBotAuthor(author, authorType, botDenyList, botAllowList);

    const [reviews, reviewComments, issueComments] = await Promise.all([
      this.github.listPRReviews(pr.pr_number, pr.repo),
      this.github.listPRReviewComments(pr.pr_number, pr.repo),
      this.github.listPRIssueComments(pr.pr_number, pr.repo),
    ]);

    const humanReviews = reviews.filter(
      (r) => !shouldExclude(r.author, r.authorType),
    );

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
      if (shouldExclude(c.author, c.authorType)) continue;
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
      if (shouldExclude(c.author, c.authorType)) continue;
      const id = `ic_${c.id}`;
      if (!routedIds.has(id)) {
        newComments.push({ id, author: c.author, body: c.body });
      }
    }

    if (hasChangesRequested && pr.pause_reason === 'awaiting_human_approval') {
      setPauseReason(pr.pr_number, pr.repo, 'human_changes_requested');
      logger.info(
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
      logger.warn(
        `[ReviewerCommentsWatcher] PR #${pr.pr_number}: session ${sessionId.slice(0, 8)} is not alive — skipping comment routing`,
      );
      return;
    }

    const feedback = formatHumanReviewFeedback(
      pr.pr_number,
      newComments,
      hasChangesRequested,
    );
    // Use sendOrResume so idle sessions (submitted PR and exited) are respawned
    // to receive the feedback. send() is a no-op for non-live sessions and would
    // silently drop the comments even though they get marked as routed below.
    await this.sessions.sendOrResume(sessionId, feedback);
    markCommentsRouted(
      pr.pr_number,
      pr.repo,
      newComments.map((c) => c.id),
    );

    logger.info(
      `[ReviewerCommentsWatcher] routed ${newComments.length} new human comment(s) to session ${sessionId.slice(0, 8)} for PR #${pr.pr_number}`,
    );
  }
}
