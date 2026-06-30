import { logger } from '../logger';
import type { GitHubClient } from './GitHubClient';
import type { SessionManager } from '../session/SessionManager';
import { GitHubRateLimitError } from './types';
import type { Scheduler } from '../orchestration/Scheduler';
import {
  getAllOpenPRs,
  getRoutedCommentIds,
  markCommentsPending,
  enqueueFeedbackItem,
  setPauseReason,
  getSession,
} from '../db/queries';
import { typedGetSetting } from '../config/settings';
import { getProjectByGithubRepo } from '../config';
import { isTerminalStalePR } from './pollUtils';
import {
  formatCoalescedHumanBatch,
  type HumanComment,
} from './reviewUtils';
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

interface BufferEntry {
  prNumber: number;
  repo: string;
  sessionId: string;
  author: string;
  comments: HumanComment[];
  hasChangesRequested: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Polls open PRs for new human reviewer comments and coalesces them into a
 * per-source quiescence buffer. Comments from the same reviewer are held until
 * no new comment arrives within the quiescence window (default 2 min, sliding),
 * then flushed as one batch into the per-session feedback inbox.
 *
 * Deduplication lives in pr_review_comments_routed (marked only on flush).
 * A restart mid-window re-discovers un-flushed comments from the DB — no loss.
 */
export class ReviewerCommentsWatcher {
  private pausedUntil: Date | null = null;
  private rateLimitBroadcasted = false;
  private readonly buffer = new Map<string, BufferEntry>();

  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
    private broadcast: (msg: ServerMessage) => void = () => {},
    private _setTimeout: (
      fn: () => void,
      ms: number,
    ) => ReturnType<typeof setTimeout> = globalThis.setTimeout.bind(globalThis),
    private _clearTimeout: (
      id: ReturnType<typeof setTimeout>,
    ) => void = globalThis.clearTimeout.bind(globalThis),
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

    if (hasChangesRequested && pr.pause_reason === 'awaiting_human_approval') {
      setPauseReason(pr.pr_number, pr.repo, 'human_changes_requested');
      logger.info(
        `[ReviewerCommentsWatcher] PR #${pr.pr_number}: CHANGES_REQUESTED — transitioning awaiting_human_approval → human_changes_requested`,
      );
    }

    // Accumulate new comments per source (reviewer login)
    const newByAuthor = new Map<
      string,
      { comments: HumanComment[]; hasChangesRequested: boolean }
    >();

    const addToAuthor = (
      author: string,
      comment: HumanComment,
      changesRequested: boolean,
    ): void => {
      const entry = newByAuthor.get(author);
      if (entry) {
        entry.comments.push(comment);
        entry.hasChangesRequested = entry.hasChangesRequested || changesRequested;
      } else {
        newByAuthor.set(author, {
          comments: [comment],
          hasChangesRequested: changesRequested,
        });
      }
    };

    for (const review of humanReviews) {
      if (!review.body?.trim()) continue;
      const id = `rv_${review.id}`;
      if (routedIds.has(id)) continue;
      addToAuthor(
        review.author,
        { id, author: review.author, body: review.body },
        review.state === 'CHANGES_REQUESTED',
      );
    }

    for (const c of reviewComments) {
      if (shouldExclude(c.author, c.authorType)) continue;
      const id = `rc_${c.id}`;
      if (routedIds.has(id)) continue;
      addToAuthor(
        c.author,
        {
          id,
          author: c.author,
          body: c.body,
          path: c.path,
          line: c.line,
          pullRequestReviewId: c.pullRequestReviewId,
        },
        false,
      );
    }

    for (const c of issueComments) {
      if (shouldExclude(c.author, c.authorType)) continue;
      const id = `ic_${c.id}`;
      if (routedIds.has(id)) continue;
      addToAuthor(c.author, { id, author: c.author, body: c.body }, false);
    }

    if (newByAuthor.size === 0) return;

    const quiescenceMs = typedGetSetting('reviewer_comment_quiescence_ms');

    for (const [author, { comments, hasChangesRequested: authorCR }] of newByAuthor) {
      const bufferKey = `${pr.pr_number}:${pr.repo}:${author}`;
      const existing = this.buffer.get(bufferKey);

      if (existing) {
        // Reset sliding window: clear old timer, merge new comments (dedup by id)
        this._clearTimeout(existing.timer);
        const existingIds = new Set(existing.comments.map((c) => c.id));
        for (const c of comments) {
          if (!existingIds.has(c.id)) existing.comments.push(c);
        }
        existing.hasChangesRequested =
          existing.hasChangesRequested || authorCR;
        existing.timer = this._setTimeout(
          () => void this.flush(bufferKey),
          quiescenceMs,
        );
      } else {
        const timer = this._setTimeout(
          () => void this.flush(bufferKey),
          quiescenceMs,
        );
        this.buffer.set(bufferKey, {
          prNumber: pr.pr_number,
          repo: pr.repo,
          sessionId: pr.session_id!,
          author,
          comments,
          hasChangesRequested: authorCR,
          timer,
        });
      }

      logger.debug(
        `[ReviewerCommentsWatcher] buffered ${comments.length} comment(s) from @${author} for PR #${pr.pr_number} (quiescence ${quiescenceMs}ms)`,
      );
    }
  }

  private async flush(bufferKey: string): Promise<void> {
    const entry = this.buffer.get(bufferKey);
    if (!entry) return;
    this.buffer.delete(bufferKey);

    const { prNumber, repo, sessionId, author, comments, hasChangesRequested } =
      entry;

    const sessionRow = getSession(sessionId);
    if (
      !sessionRow ||
      sessionRow.status === 'done' ||
      sessionRow.status === 'error' ||
      sessionRow.status === 'killed'
    ) {
      logger.warn(
        `[ReviewerCommentsWatcher] PR #${prNumber}: session ${sessionId.slice(0, 8)} is not alive — discarding ${comments.length} buffered comment(s) from @${author}`,
      );
      return;
    }

    const payload = formatCoalescedHumanBatch(
      prNumber,
      author,
      comments,
      hasChangesRequested,
    );
    markCommentsPending(
      prNumber,
      repo,
      comments.map((c) => c.id),
    );
    enqueueFeedbackItem(sessionId, `human:${author}`, payload);

    logger.info(
      `[ReviewerCommentsWatcher] flushed ${comments.length} comment(s) from @${author} for PR #${prNumber} → inbox for session ${sessionId.slice(0, 8)}`,
    );
  }
}
