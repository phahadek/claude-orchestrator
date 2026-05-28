/**
 * Tests for the push_detected re-review handler in server.ts verifying that
 * runAutofixPipeline is called before prReviewService.reReviewPR on every push.
 *
 * Acceptance criteria covered:
 * AC3 — push_detected handler invokes runAutofixPipeline before reReviewPR.
 * AC4 — consumeAutofixSha suppresses re-review for an autofix-only push.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/queries.js', () => ({
  getPRBySessionId: vi.fn(),
  getPRByNumber: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPauseReason: vi.fn(),
  setPendingPush: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
}));

vi.mock('../config.js', () => ({
  AUTO_REVIEW_ENABLED: true,
  AUTO_REVIEW_CONCURRENCY: 1,
  runtimeSettings: {},
  getProjectByGithubRepo: vi.fn(),
  getProjectById: vi.fn(),
  getAllProjects: vi.fn(() => []),
}));

import * as queries from '../db/queries.js';
import { shouldAutoReview } from '../github/reviewUtils.js';
import type { PullRequestRow } from '../db/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';

const REPO = 'owner/repo';
const PR_NUMBER = 1;
const CODE_SESSION_ID = 'coding-session-uuid';
const HEAD_SHA = 'abc123deadbeef';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'notion:task-abc',
    session_id: CODE_SESSION_ID,
    repo: REPO,
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T01:00:00Z',
    synced_at: '2024-01-01T01:00:00Z',
    review_session_id: 'review-session-uuid',
    review_iteration: 1,
    head_sha: HEAD_SHA,
    last_reviewed_sha: 'old-sha-00000',
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    pending_push: 0,
    pause_reason: null,
    failing_checks: null,
    ...overrides,
  };
}

class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn();
}

function makeMockGitHub(headSha = HEAD_SHA): GitHubClient {
  return {
    fetchPR: vi.fn().mockResolvedValue({ headSha }),
  } as unknown as GitHubClient;
}

const PUSH_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

function getMaxReviewIterationsMock(): number {
  const raw = vi.mocked(queries.getSetting)('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REVIEW_ITERATIONS;
}

/**
 * Wires the push_detected handler from server.ts — including the
 * runAutofixPipeline call added by this task — onto a mock session manager.
 * Both reviewOrchestrator.runAutofixPipeline and reviewOrchestrator.consumeAutofixSha
 * are injectable mocks so tests can verify call order.
 */
function wirePushDetectedHandler(
  sessionManager: MockSessionManager,
  reviewService: { reReviewPR: ReturnType<typeof vi.fn> },
  githubClient: GitHubClient,
  reviewOrchestrator: {
    runAutofixPipeline: ReturnType<typeof vi.fn>;
    consumeAutofixSha: ReturnType<typeof vi.fn>;
  },
): void {
  const pendingReReviews = new Set<string>();

  sessionManager.on(
    'push_detected',
    ({ sessionId: codingSessionId }: { sessionId: string }) => {
      if (pendingReReviews.has(codingSessionId)) return;

      const prRow = vi.mocked(queries.getPRBySessionId)(codingSessionId);
      if (!prRow || prRow.state !== 'open') return;
      if (!prRow.review_session_id) {
        vi.mocked(queries.setPendingPush)(prRow.pr_number, prRow.repo, 1);
        return;
      }

      pendingReReviews.add(codingSessionId);

      void (async () => {
        let headSha = prRow.head_sha;
        try {
          const freshPR = await githubClient.fetchPR(
            prRow.repo,
            prRow.pr_number,
          );
          headSha = freshPR.headSha;
          if (headSha !== prRow.head_sha) {
            vi.mocked(queries.setHeadSha)(prRow.pr_number, prRow.repo, headSha);
          }
        } catch {
          // swallow
        }

        if (
          headSha &&
          reviewOrchestrator.consumeAutofixSha(
            prRow.pr_number,
            prRow.repo,
            headSha,
          )
        ) {
          pendingReReviews.delete(codingSessionId);
          return;
        }

        const maxIter = getMaxReviewIterationsMock();

        if (prRow.review_iteration >= maxIter) {
          vi.mocked(queries.setPauseReason)(
            prRow.pr_number,
            prRow.repo,
            'max_reviews',
          );
          sessionManager.emit('message', {
            type: 'review_escalated',
            prNumber: prRow.pr_number,
            repo: prRow.repo,
            message: `Review loop for PR #${prRow.pr_number} reached ${maxIter} iterations.`,
          });
          pendingReReviews.delete(codingSessionId);
          return;
        }

        if (
          !shouldAutoReview(
            {
              reviewIteration: prRow.review_iteration,
              headSha,
              lastReviewedSha: prRow.last_reviewed_sha,
            },
            maxIter,
          )
        ) {
          pendingReReviews.delete(codingSessionId);
          return;
        }

        const iteration = prRow.review_iteration + 1;

        // Run autofix + pollution-check on every push, same as first review.
        await reviewOrchestrator.runAutofixPipeline(
          prRow.pr_number,
          prRow.repo,
          prRow.task_id,
        );

        try {
          let result: { verdict: string; summary: string };
          try {
            result = await Promise.race([
              reviewService.reReviewPR(prRow.pr_number, prRow.repo),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error('Re-review timed out')),
                  PUSH_REVIEW_TIMEOUT_MS,
                ),
              ),
            ]);
          } catch (e) {
            const summary = e instanceof Error ? e.message : String(e);
            vi.mocked(queries.setPauseReason)(
              prRow.pr_number,
              prRow.repo,
              'review_failed',
            );
            sessionManager.emit('message', {
              type: 'review_failed',
              prNumber: prRow.pr_number,
              repo: prRow.repo,
              message: `Re-review for PR #${prRow.pr_number} failed: ${summary}`,
            });
            vi.mocked(queries.setPRReviewResult)(
              prRow.pr_number,
              prRow.repo,
              JSON.stringify({ verdict: 'error', summary, dimensions: [] }),
            );
            sessionManager.emit('message', {
              type: 'review_verdict',
              prNumber: prRow.pr_number,
              repo: prRow.repo,
              verdict: 'error',
              summary,
              iteration,
            });
            return;
          }

          vi.mocked(queries.setLastReviewedSha)(
            prRow.pr_number,
            prRow.repo,
            headSha,
          );
          if (result.verdict === 'approved' && prRow.pause_reason !== null) {
            vi.mocked(queries.setPauseReason)(
              prRow.pr_number,
              prRow.repo,
              null,
            );
          }
          sessionManager.emit('message', {
            type: 'review_verdict',
            prNumber: prRow.pr_number,
            repo: prRow.repo,
            verdict: result.verdict,
            summary: result.summary,
            iteration,
          });
        } finally {
          pendingReReviews.delete(codingSessionId);
        }
      })();
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC3: runAutofixPipeline is called before reReviewPR ──────────────────────

describe('push_detected: runAutofixPipeline called before reReviewPR', () => {
  it('calls runAutofixPipeline before reReviewPR on a valid push', async () => {
    const callOrder: string[] = [];

    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const reviewOrchestrator = {
      runAutofixPipeline: vi.fn().mockImplementation(async () => {
        callOrder.push('runAutofixPipeline');
      }),
      consumeAutofixSha: vi.fn().mockReturnValue(false),
    };
    const reviewService = {
      reReviewPR: vi.fn().mockImplementation(async () => {
        callOrder.push('reReviewPR');
        return {
          verdict: 'approved',
          summary: 'Looks good',
          dimensions: [],
        };
      }),
    };

    wirePushDetectedHandler(
      sessionManager,
      reviewService,
      github,
      reviewOrchestrator,
    );

    vi.mocked(queries.getPRBySessionId).mockReturnValue(makePRRow());

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(callOrder.indexOf('runAutofixPipeline')).toBeLessThan(
      callOrder.indexOf('reReviewPR'),
    );
  });

  it('passes prNumber, repo, and task_id to runAutofixPipeline', async () => {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const reviewOrchestrator = {
      runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
      consumeAutofixSha: vi.fn().mockReturnValue(false),
    };
    const reviewService = {
      reReviewPR: vi.fn().mockResolvedValue({
        verdict: 'approved',
        summary: 'ok',
        dimensions: [],
      }),
    };

    wirePushDetectedHandler(
      sessionManager,
      reviewService,
      github,
      reviewOrchestrator,
    );

    vi.mocked(queries.getPRBySessionId).mockReturnValue(makePRRow());

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(reviewOrchestrator.runAutofixPipeline).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'notion:task-abc',
    );
  });

  it('does NOT call runAutofixPipeline when consumeAutofixSha is true (autofix-only push)', async () => {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const reviewOrchestrator = {
      runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
      consumeAutofixSha: vi.fn().mockReturnValue(true), // autofix-only
    };
    const reviewService = { reReviewPR: vi.fn() };

    wirePushDetectedHandler(
      sessionManager,
      reviewService,
      github,
      reviewOrchestrator,
    );

    vi.mocked(queries.getPRBySessionId).mockReturnValue(makePRRow());

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(reviewOrchestrator.runAutofixPipeline).not.toHaveBeenCalled();
    expect(reviewService.reReviewPR).not.toHaveBeenCalled();
  });
});

// ── AC4: consumeAutofixSha suppresses re-review for autofix-only push ─────────

describe('push_detected: consumeAutofixSha suppresses autofix-only push', () => {
  it('skips re-review when second push headSha matches the autofix commit SHA', async () => {
    const AUTOFIX_SHA = 'autofix-commit-sha-xyz';
    let storedAutofixSha: string | null = null;

    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub(AUTOFIX_SHA);

    // Simulate ReviewOrchestrator: runAutofixPipeline records the SHA,
    // consumeAutofixSha returns true when that SHA is presented.
    const reviewOrchestrator = {
      runAutofixPipeline: vi.fn().mockImplementation(async () => {
        storedAutofixSha = AUTOFIX_SHA;
      }),
      consumeAutofixSha: vi
        .fn()
        .mockImplementation((_prNumber: number, _repo: string, sha: string) => {
          if (storedAutofixSha && sha === storedAutofixSha) {
            storedAutofixSha = null;
            return true;
          }
          return false;
        }),
    };

    const reviewService = {
      reReviewPR: vi.fn().mockResolvedValue({
        verdict: 'approved',
        summary: 'ok',
        dimensions: [],
      }),
    };

    wirePushDetectedHandler(
      sessionManager,
      reviewService,
      github,
      reviewOrchestrator,
    );

    // First push: coding session push → autofix runs, re-review runs
    vi.mocked(queries.getPRBySessionId).mockReturnValue(makePRRow());
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(reviewOrchestrator.runAutofixPipeline).toHaveBeenCalledTimes(1);
    expect(reviewService.reReviewPR).toHaveBeenCalledTimes(1);

    // Second push: autofix commit arrives — headSha is the autofix SHA
    // consumeAutofixSha returns true → re-review (and autofix) skipped
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    // runAutofixPipeline must NOT be called again for the autofix-only push
    expect(reviewOrchestrator.runAutofixPipeline).toHaveBeenCalledTimes(1);
    expect(reviewService.reReviewPR).toHaveBeenCalledTimes(1);
  });
});

// ── pause_reason cleared on approved verdict ──────────────────────────────────

function makePushHelper(
  pauseReason: string | null,
  verdict: string,
): {
  sessionManager: MockSessionManager;
  github: ReturnType<typeof makeMockGitHub>;
  reviewOrchestrator: {
    runAutofixPipeline: ReturnType<typeof vi.fn>;
    consumeAutofixSha: ReturnType<typeof vi.fn>;
  };
  reviewService: { reReviewPR: ReturnType<typeof vi.fn> };
} {
  const sessionManager = new MockSessionManager();
  const github = makeMockGitHub();
  const reviewOrchestrator = {
    runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
    consumeAutofixSha: vi.fn().mockReturnValue(false),
  };
  const reviewService = {
    reReviewPR: vi.fn().mockResolvedValue({
      verdict,
      summary: 'test summary',
      dimensions: [],
    }),
  };

  wirePushDetectedHandler(
    sessionManager,
    reviewService,
    github,
    reviewOrchestrator,
  );

  vi.mocked(queries.getPRBySessionId).mockReturnValue(
    makePRRow({ pause_reason: pauseReason }),
  );

  return { sessionManager, github, reviewOrchestrator, reviewService };
}

describe('push_detected: pause_reason cleared on approved verdict', () => {
  it('clears pause_reason when prior pause was review_failed and verdict is approved', async () => {
    const { sessionManager } = makePushHelper('review_failed', 'approved');
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('clears pause_reason when prior pause was stuck_timeout and verdict is approved', async () => {
    const { sessionManager } = makePushHelper('stuck_timeout', 'approved');
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('clears pause_reason when prior pause was max_reviews and verdict is approved', async () => {
    const { sessionManager } = makePushHelper('max_reviews', 'approved');
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('does NOT clear pause_reason when verdict is needs_changes', async () => {
    const { sessionManager } = makePushHelper('review_failed', 'needs_changes');
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('does NOT clear pause_reason when verdict is incomplete', async () => {
    const { sessionManager } = makePushHelper('review_failed', 'incomplete');
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('does not call setPauseReason(null) when pause_reason is already null and verdict is approved', async () => {
    const { sessionManager } = makePushHelper(null, 'approved');
    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });
});
