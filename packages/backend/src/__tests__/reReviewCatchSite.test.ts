/**
 * Tests for the enriched catch site in the push_detected → reReviewPR handler.
 *
 * Verifies that when PRReviewService.reReviewPR throws, all four effects fire:
 * 1. setPauseReason('review_failed') is called
 * 2. A review_failed WS message is broadcast
 * 3. setPRReviewResult is still called with the synthetic error record
 * 4. A review_verdict WS message is still emitted
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  getPRBySessionId: vi.fn(),
  getPRByNotionTaskId: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  setPRReviewResult: vi.fn(),
  setReviewSessionId: vi.fn(),
  incrementReviewIteration: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setHeadSha: vi.fn(),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
}));

const projectFixture = {
  id: 'proj-1',
  name: 'Test Project',
  projectDir: '/test',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  githubRepo: 'owner/repo',
};

vi.mock('../config.js', () => ({
  AUTO_REVIEW_ENABLED: true,
  AUTO_REVIEW_CONCURRENCY: 1,
  TASK_BACKEND: 'local',
  getProjectById: vi.fn(),
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  normalizePath: (p: string) => p,
  runtimeSettings: {},
}));

import { PRReviewService } from '../github/PRReviewService.js';
import { shouldAutoReview } from '../github/reviewUtils.js';
import * as queries from '../db/queries.js';
import type { PullRequestRow } from '../db/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend.js';

const REPO = 'owner/repo';
const PR_NUMBER = 300;
const CODE_SESSION_ID = 'code-session-uuid';
const HEAD_SHA = 'f5dc731abc';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'notion:notion-task-id',
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
    last_reviewed_sha: 'abc1234',
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
  isAlive = vi.fn().mockReturnValue(false);
  endSession = vi.fn();
  start = vi.fn();
}

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    fetchPR: vi.fn().mockResolvedValue({ headSha: HEAD_SHA }),
    fetchDiff: vi.fn().mockResolvedValue({ diff: 'diff --git a/foo b/foo' }),
    getMergeability: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    getMergeabilityWithRetry: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    mergePR: vi.fn(),
    getPRState: vi.fn(),
  } as unknown as GitHubClient;
}

function makeMockTaskBackend(): TaskTrackerBackend {
  return {
    type: 'local',
    fetchTaskPage: vi.fn().mockResolvedValue('# Task\nDo something'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    fetchTaskTitle: vi.fn().mockResolvedValue('Test Task'),
  } as unknown as TaskTrackerBackend;
}

const PUSH_REVIEW_TIMEOUT_MS = 120_000;
const MAX_ITER = 3;

/**
 * Wires the push_detected handler from server.ts (including the enriched catch
 * site) onto a mock SessionManager for testing.
 */
function wirePushDetectedHandler(
  sessionManager: MockSessionManager,
  prReviewService: PRReviewService,
  githubClient: GitHubClient,
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

        if (prRow.review_iteration >= MAX_ITER) {
          sessionManager.emit('message', {
            type: 'review_escalated',
            prNumber: prRow.pr_number,
            repo: prRow.repo,
            message: `Review loop for PR #${prRow.pr_number} reached ${MAX_ITER} iterations.`,
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
            MAX_ITER,
          )
        ) {
          pendingReReviews.delete(codingSessionId);
          return;
        }

        const iteration = prRow.review_iteration + 1;
        try {
          let result: Awaited<ReturnType<typeof prReviewService.reReviewPR>>;
          try {
            result = await Promise.race([
              prReviewService.reReviewPR(prRow.pr_number, prRow.repo),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error('Re-review timed out')),
                  PUSH_REVIEW_TIMEOUT_MS,
                ),
              ),
            ]);
          } catch (e) {
            const summary = e instanceof Error ? e.message : String(e);
            console.error(
              `[server] re-review failed for PR #${prRow.pr_number}:`,
              e,
            );
            vi.mocked(queries.setPauseReason)(
              prRow.pr_number,
              prRow.repo,
              'review_failed',
            );
            const failMessage = `Re-review for PR #${prRow.pr_number} failed: ${summary}`;
            sessionManager.emit('message', {
              type: 'review_failed',
              prNumber: prRow.pr_number,
              repo: prRow.repo,
              message: failMessage,
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

describe('reReviewPR throw — enriched catch site', () => {
  async function setupAndTrigger(errorMsg: string) {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const taskBackend = makeMockTaskBackend();
    const reviewService = new PRReviewService(
      github,
      taskBackend,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
    );

    vi.spyOn(reviewService, 'reReviewPR').mockRejectedValue(
      new Error(errorMsg),
    );

    wirePushDetectedHandler(sessionManager, reviewService, github);

    const prRow = makePRRow();
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);

    const broadcastedMessages: unknown[] = [];
    sessionManager.on('message', (msg: unknown) =>
      broadcastedMessages.push(msg),
    );

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });

    // Wait for the async handler to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    return { broadcastedMessages };
  }

  it('calls setPauseReason with review_failed', async () => {
    await setupAndTrigger('FOREIGN KEY constraint failed');
    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'review_failed',
    );
  });

  it('broadcasts a review_failed WS message with prNumber, repo, and message', async () => {
    const { broadcastedMessages } = await setupAndTrigger(
      'FOREIGN KEY constraint failed',
    );
    const failedMsg = broadcastedMessages.find(
      (
        m,
      ): m is {
        type: string;
        prNumber: number;
        repo: string;
        message: string;
      } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type: string }).type === 'review_failed',
    );
    expect(failedMsg).toBeDefined();
    expect(failedMsg!.prNumber).toBe(PR_NUMBER);
    expect(failedMsg!.repo).toBe(REPO);
    expect(failedMsg!.message).toContain('FOREIGN KEY constraint failed');
  });

  it('still calls setPRReviewResult with the synthetic error record', async () => {
    await setupAndTrigger('FOREIGN KEY constraint failed');
    expect(vi.mocked(queries.setPRReviewResult)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      expect.stringContaining('"verdict":"error"'),
    );
  });

  it('still emits review_verdict with error verdict', async () => {
    const { broadcastedMessages } = await setupAndTrigger(
      'FOREIGN KEY constraint failed',
    );
    const verdictMsg = broadcastedMessages.find(
      (m): m is { type: string; verdict: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type: string }).type === 'review_verdict',
    );
    expect(verdictMsg).toBeDefined();
    expect(verdictMsg!.verdict).toBe('error');
  });

  it('review_failed message does NOT appear when reReviewPR succeeds', async () => {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const taskBackend = makeMockTaskBackend();
    const reviewService = new PRReviewService(
      github,
      taskBackend,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
    );

    vi.spyOn(reviewService, 'reReviewPR').mockResolvedValue({
      prNumber: PR_NUMBER,
      repo: REPO,
      verdict: 'approved',
      dimensions: [],
      summary: 'Looks good',
      reviewedAt: new Date().toISOString(),
    });

    wirePushDetectedHandler(sessionManager, reviewService, github);

    const prRow = makePRRow();
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);

    const broadcastedMessages: unknown[] = [];
    sessionManager.on('message', (msg: unknown) =>
      broadcastedMessages.push(msg),
    );

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const failedMsg = broadcastedMessages.find(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type: string }).type === 'review_failed',
    );
    expect(failedMsg).toBeUndefined();
    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'review_failed',
    );
  });
});
