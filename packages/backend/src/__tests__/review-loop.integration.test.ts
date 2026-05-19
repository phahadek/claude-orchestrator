/**
 * Integration test: re-review / re-fix orchestration loop
 *
 * Tests the full lifecycle:
 *   push_detected (before review session) → pending_push queued
 *   → initial review completes → pending_push triggers re-review
 *   → needs_changes → feedback sent to code session
 *   → another push → another re-review → iteration counter increments
 *   → escalation fires at configured cap
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks (must appear before any imports that transitively use them) ──

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

// ── Imports after mocks ────────────────────────────────────────────────────────

import { ReviewOrchestrator } from '../github/ReviewOrchestrator.js';
import { PRReviewService } from '../github/PRReviewService.js';
import {
  shouldAutoReview,
  formatReviewFeedback,
} from '../github/reviewUtils.js';
import * as queries from '../db/queries.js';
import type { PullRequestRow } from '../db/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { TaskTrackerBackend } from '../tasks/TaskTrackerBackend.js';
import type { PRReviewResult } from '../github/PRReviewService.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO = 'owner/repo';
const PR_NUMBER = 42;
const CODE_SESSION_ID = 'code-session-uuid';
const REVIEW_SESSION_ID = 'review-session-uuid';
const HEAD_SHA = 'abc123';
const NEW_SHA = 'def456';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    notion_task_id: 'notion-task-id',
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
    review_session_id: null,
    review_iteration: 0,
    head_sha: HEAD_SHA,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    pending_push: 0,
    pause_reason: null,
    ...overrides,
  };
}

function makeNeedsChangesResult(): PRReviewResult {
  return {
    prNumber: PR_NUMBER,
    repo: REPO,
    verdict: 'needs_changes',
    dimensions: [{ name: 'Tests', passed: false, notes: 'Missing unit tests' }],
    summary: 'Please add tests',
    reviewedAt: new Date().toISOString(),
  };
}

function makeApprovedResult(): PRReviewResult {
  return {
    prNumber: PR_NUMBER,
    repo: REPO,
    verdict: 'approved',
    dimensions: [],
    summary: 'Looks good',
    reviewedAt: new Date().toISOString(),
  };
}

/** Serialise a verdict into the format that PRReviewService.waitForVerdict() expects. */
function makeVerdictEventPayload(
  sessionId: string,
  verdict: PRReviewResult,
): object {
  return {
    type: 'session_event',
    sessionId,
    eventType: 'text',
    content: JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              verdict: verdict.verdict,
              dimensions: verdict.dimensions ?? [],
              summary: verdict.summary,
            }),
          },
        ],
      },
    }),
  };
}

// ── Mock SessionManager ───────────────────────────────────────────────────────

/**
 * Minimal SessionManager mock that extends EventEmitter and exposes the
 * methods that ReviewOrchestrator and PRReviewService call.
 */
class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn();
  isAlive = vi.fn().mockReturnValue(false);
  endSession = vi.fn();
  start = vi.fn();
}

// ── Mock GitHub and task backends ─────────────────────────────────────────────

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    fetchPR: vi.fn().mockResolvedValue({ headSha: NEW_SHA }),
    fetchDiff: vi
      .fn()
      .mockResolvedValue({ diff: 'diff --git a/foo.ts b/foo.ts' }),
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

// ── Re-review loop handler (mirrors server.ts push_detected handler) ──────────

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

/**
 * Sets up a push_detected listener on the given sessionManager, mirroring the
 * logic in server.ts. Returns a Set<string> (pendingReReviews) so tests can
 * inspect in-flight re-review state.
 */
function wirePushDetectedHandler(
  sessionManager: MockSessionManager,
  prReviewService: PRReviewService,
  githubClient: GitHubClient,
  getMaxIter: () => number = () => DEFAULT_MAX_REVIEW_ITERATIONS,
): Set<string> {
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
        // Fetch fresh PR state
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
          // swallow — continue with stale sha
        }

        const maxIter = getMaxIter();

        // Escalation check (emits review_escalated) — must happen before shouldAutoReview
        if (prRow.review_iteration >= maxIter) {
          const message = `Review loop for PR #${prRow.pr_number} reached ${maxIter} iterations without approval. Manual intervention needed.`;
          sessionManager.emit('message', {
            type: 'review_escalated',
            prNumber: prRow.pr_number,
            repo: prRow.repo,
            message,
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
        try {
          let result: PRReviewResult;
          try {
            result = await prReviewService.reReviewPR(
              prRow.pr_number,
              prRow.repo,
            );
          } catch (e) {
            const summary = e instanceof Error ? e.message : String(e);
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

          if (result.verdict === 'needs_changes') {
            await sessionManager.sendOrResume(
              codingSessionId,
              formatReviewFeedback(result, iteration),
            );
          }
        } finally {
          pendingReReviews.delete(codingSessionId);
        }
      })();
    },
  );

  return pendingReReviews;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. Push before review session → pending_push queued ───────────────────────

describe('push_detected before review_session_id is set', () => {
  it('queues pending_push when review session not yet established', () => {
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
    wirePushDetectedHandler(sessionManager, reviewService, github);

    const prRow = makePRRow({ review_session_id: null });
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });

    expect(vi.mocked(queries.setPendingPush)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      1,
    );
  });

  it('does NOT attempt re-review when review session is not set', () => {
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
    wirePushDetectedHandler(sessionManager, reviewService, github);

    const prRow = makePRRow({ review_session_id: null });
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });

    // reReviewPR should not have been called (no fetchDiff)
    expect(vi.mocked(github.fetchDiff)).not.toHaveBeenCalled();
  });
});

// ── 2. Initial review completes → pending_push triggers re-review ─────────────

describe('ReviewOrchestrator.executeReview → pending_push → re-review', () => {
  it('emits push_detected after initial review when pending_push is set', async () => {
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

    const _orchestrator = new ReviewOrchestrator(
      reviewService,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      1,
      true,
    );

    // Spy on emit to capture push_detected
    const emittedEvents: Array<{ event: string; payload: unknown }> = [];
    const origEmit = sessionManager.emit.bind(sessionManager);
    sessionManager.emit = vi
      .fn()
      .mockImplementation((event: string, ...args: unknown[]) => {
        emittedEvents.push({ event, payload: args[0] });
        return origEmit(event, ...args);
      });

    // DB state: PR row with pending_push=1 (push arrived during review)
    const prRowBeforeReview = makePRRow({
      review_session_id: null,
      pending_push: 0,
    });
    const prRowAfterReview = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      pending_push: 1,
      session_id: CODE_SESSION_ID,
    });

    vi.mocked(queries.getPRByNumber)
      .mockReturnValueOnce(prRowBeforeReview) // iteration cap check in executeReview
      .mockReturnValueOnce(prRowAfterReview) // feedback routing (needs_changes check)
      .mockReturnValue(prRowAfterReview); // post-review pending_push check

    // Mock reviewPR to resolve immediately with needs_changes
    const reviewSpy = vi
      .spyOn(reviewService, 'reviewPR')
      .mockResolvedValue(makeNeedsChangesResult());

    // Trigger the initial review
    sessionManager.emit('pr_opened', {
      prNumber: PR_NUMBER,
      repo: REPO,
      taskId: 'notion-task-id',
      contextUrl: '',
    });

    // Wait for async review to complete
    await vi.waitFor(() => {
      expect(reviewSpy).toHaveBeenCalled();
    });

    // Give async chain time to process pending_push
    await new Promise((r) => setTimeout(r, 10));

    const pushDetectedEvent = emittedEvents.find(
      (e) => e.event === 'push_detected',
    );
    expect(pushDetectedEvent).toBeDefined();
    expect(pushDetectedEvent?.payload).toMatchObject({
      sessionId: CODE_SESSION_ID,
    });
  });
});

// ── 3. Re-review with needs_changes → feedback to code session ─────────────────

describe('re-review needs_changes → feedback sent to code session', () => {
  it('calls sendOrResume with formatted feedback when verdict is needs_changes', async () => {
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

    wirePushDetectedHandler(sessionManager, reviewService, github);

    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      last_reviewed_sha: 'old-sha',
      head_sha: HEAD_SHA,
      review_iteration: 0,
    });
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    // Mock fetchPR to return a new SHA so shouldAutoReview passes
    vi.mocked(github.fetchPR).mockResolvedValue({
      headSha: NEW_SHA,
    } as ReturnType<typeof github.fetchPR> extends Promise<infer T>
      ? T
      : never);

    // Mock reReviewPR to resolve with needs_changes
    const reReviewSpy = vi
      .spyOn(reviewService, 'reReviewPR')
      .mockResolvedValue(makeNeedsChangesResult());

    sessionManager.sendOrResume = vi.fn().mockResolvedValue(CODE_SESSION_ID);

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });

    await vi.waitFor(() => {
      expect(reReviewSpy).toHaveBeenCalled();
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(sessionManager.sendOrResume).toHaveBeenCalledWith(
      CODE_SESSION_ID,
      expect.stringContaining('Review Feedback'),
    );
  });
});

// ── 4. Iteration counter increments correctly ─────────────────────────────────

describe('review iteration counter', () => {
  it('increments review_iteration after each reReviewPR call', async () => {
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

    // Mock the internal sendOrResume on sessionManager so that waitForVerdict gets a verdict
    sessionManager.sendOrResume = vi
      .fn()
      .mockImplementation(async (sessionId: string) => {
        // Emit verdict after a tick
        setTimeout(() => {
          sessionManager.emit(
            'message',
            makeVerdictEventPayload(sessionId, makeNeedsChangesResult()),
          );
        }, 0);
        return sessionId;
      });

    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      review_iteration: 0,
      last_reviewed_sha: 'old-sha',
      head_sha: HEAD_SHA,
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    await reviewService.reReviewPR(PR_NUMBER, REPO);

    expect(vi.mocked(queries.incrementReviewIteration)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
    );
    expect(vi.mocked(queries.incrementReviewIteration)).toHaveBeenCalledTimes(
      1,
    );
  });

  it('emits review_verdict with correct iteration number on push_detected re-review', async () => {
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
    wirePushDetectedHandler(sessionManager, reviewService, github);

    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      review_iteration: 1,
      last_reviewed_sha: 'old-sha',
      head_sha: HEAD_SHA,
    });
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);
    vi.mocked(github.fetchPR).mockResolvedValue({
      headSha: NEW_SHA,
    } as ReturnType<typeof github.fetchPR> extends Promise<infer T>
      ? T
      : never);

    const reReviewSpy = vi
      .spyOn(reviewService, 'reReviewPR')
      .mockResolvedValue(makeApprovedResult());
    sessionManager.sendOrResume = vi.fn().mockResolvedValue(CODE_SESSION_ID);

    const messages: object[] = [];
    sessionManager.on('message', (msg: object) => messages.push(msg));

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });

    await vi.waitFor(() => expect(reReviewSpy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));

    const verdictMsg = messages.find(
      (m: object) => (m as { type: string }).type === 'review_verdict',
    );
    expect(verdictMsg).toMatchObject({ type: 'review_verdict', iteration: 2 });
  });
});

// ── 5. Escalation fires at configured cap ────────────────────────────────────

describe('escalation at review iteration cap', () => {
  it('emits review_escalated when review_iteration >= maxIterations', async () => {
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
    const MAX_ITER = 3;
    wirePushDetectedHandler(
      sessionManager,
      reviewService,
      github,
      () => MAX_ITER,
    );

    // review_iteration is at cap — should escalate
    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      review_iteration: MAX_ITER,
      last_reviewed_sha: 'old-sha',
      head_sha: HEAD_SHA,
    });
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);
    vi.mocked(github.fetchPR).mockResolvedValue({
      headSha: NEW_SHA,
    } as ReturnType<typeof github.fetchPR> extends Promise<infer T>
      ? T
      : never);

    const messages: object[] = [];
    sessionManager.on('message', (msg: object) => messages.push(msg));

    const reReviewSpy = vi.spyOn(reviewService, 'reReviewPR');

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });

    await new Promise((r) => setTimeout(r, 20));

    const escalated = messages.find(
      (m) => (m as { type: string }).type === 'review_escalated',
    );
    expect(escalated).toBeDefined();
    expect(escalated).toMatchObject({
      type: 'review_escalated',
      prNumber: PR_NUMBER,
      repo: REPO,
    });

    // No re-review should be attempted
    expect(reReviewSpy).not.toHaveBeenCalled();
  });

  it('does not attempt re-review when at iteration cap', async () => {
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
    wirePushDetectedHandler(sessionManager, reviewService, github, () => 2);

    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      review_iteration: 2,
    });
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);
    vi.mocked(github.fetchPR).mockResolvedValue({
      headSha: NEW_SHA,
    } as ReturnType<typeof github.fetchPR> extends Promise<infer T>
      ? T
      : never);

    const reReviewSpy = vi.spyOn(reviewService, 'reReviewPR');

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });

    await new Promise((r) => setTimeout(r, 20));

    expect(reReviewSpy).not.toHaveBeenCalled();
  });

  it('ReviewOrchestrator emits review_escalated at cap for pr_opened path', async () => {
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

    const orchestrator = new ReviewOrchestrator(
      reviewService,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      1,
      true,
    );
    void orchestrator; // used implicitly via sessionManager event listeners

    // PR is already at the iteration cap
    const prRow = makePRRow({
      review_iteration: 3,
      review_session_id: REVIEW_SESSION_ID,
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);
    vi.mocked(queries.getSetting).mockReturnValue(null); // use default cap of 3

    const messages: object[] = [];
    sessionManager.on('message', (msg: object) => messages.push(msg));

    sessionManager.emit('pr_opened', {
      prNumber: PR_NUMBER,
      repo: REPO,
      taskId: 'task-id',
      contextUrl: '',
    });

    await new Promise((r) => setTimeout(r, 20));

    const escalated = messages.find(
      (m) => (m as { type: string }).type === 'review_escalated',
    );
    expect(escalated).toBeDefined();
    expect(escalated).toMatchObject({
      type: 'review_escalated',
      prNumber: PR_NUMBER,
      repo: REPO,
    });
  });
});

// ── 6. shouldAutoReview pure function checks ──────────────────────────────────

describe('shouldAutoReview', () => {
  it('returns false when iteration >= cap', () => {
    expect(
      shouldAutoReview(
        { reviewIteration: 3, headSha: 'abc', lastReviewedSha: 'old' },
        3,
      ),
    ).toBe(false);
  });

  it('returns false when headSha equals lastReviewedSha (no new commits)', () => {
    expect(
      shouldAutoReview(
        { reviewIteration: 0, headSha: 'same', lastReviewedSha: 'same' },
        3,
      ),
    ).toBe(false);
  });

  it('returns false when headSha is null', () => {
    expect(
      shouldAutoReview(
        { reviewIteration: 0, headSha: null, lastReviewedSha: 'old' },
        3,
      ),
    ).toBe(false);
  });

  it('returns true when new commits exist and under cap', () => {
    expect(
      shouldAutoReview(
        { reviewIteration: 1, headSha: 'new', lastReviewedSha: 'old' },
        3,
      ),
    ).toBe(true);
  });

  it('returns true when lastReviewedSha is null (first review)', () => {
    expect(
      shouldAutoReview(
        { reviewIteration: 0, headSha: 'abc', lastReviewedSha: null },
        3,
      ),
    ).toBe(true);
  });
});
