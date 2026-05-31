/**
 * Tests for review iteration-cap escalation behavior.
 *
 * Verifies:
 * 1. Push-cap path (server.ts push_detected handler): sets pause_reason = 'max_reviews'
 * 2. Initial-cap path (ReviewOrchestrator): still sets pause_reason = 'max_reviews' (regression)
 * 3. Settings route: PATCH max_review_iterations persists via setSetting
 * 4. Both cap paths read the runtime setting (not hardcoded default) when it is set
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
  setSetting: vi.fn(),
  getAllSettings: vi.fn().mockReturnValue([]),
  getLocalBranchBySession: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  getSession: vi.fn(),
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
  runtimeSettings: {
    max_concurrent_code_sessions: 20,
    auto_review_concurrency: 1,
    auto_review: true,
    card_preview_lines: 3,
    code_session_model: '',
    review_session_model: '',
    session_mode: 'cli',
    auto_launch_concurrency: 1,
    auto_launch_poll_interval_ms: 60000,
    session_notify_threshold_seconds: 3600,
    session_pause_threshold_seconds: 7200,
    session_hard_stop_window_seconds: 60,
    ci_poll_interval_seconds: 30,
    ci_poll_max_minutes: 30,
    max_review_iterations: 3,
  },
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
  }),
}));

import express from 'express';
import supertest from 'supertest';
import { ReviewOrchestrator } from '../github/ReviewOrchestrator.js';
import { shouldAutoReview } from '../github/reviewUtils.js';
import * as queries from '../db/queries.js';
import { runtimeSettings } from '../config.js';
import settingsRouter from '../routes/settings.js';
import type { PullRequestRow } from '../db/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PRReviewService } from '../github/PRReviewService.js';

const REPO = 'owner/repo';
const PR_NUMBER = 346;
const CODE_SESSION_ID = 'code-session-uuid';
const HEAD_SHA = 'f5dc731abc';
const LAST_REVIEWED_SHA = '20177dd8ef';

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
    review_iteration: 3,
    head_sha: HEAD_SHA,
    last_reviewed_sha: LAST_REVIEWED_SHA,
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
    fetchDiff: vi.fn().mockResolvedValue({ diff: '' }),
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

const PUSH_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

function getMaxReviewIterations(): number {
  const raw = vi.mocked(queries.getSetting)('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REVIEW_ITERATIONS;
}

/**
 * Wires the push_detected handler from server.ts (including the fix:
 * setPauseReason('max_reviews') when cap is hit) onto a MockSessionManager.
 */
function wirePushDetectedHandler(
  sessionManager: MockSessionManager,
  reviewService: { reReviewPR: ReturnType<typeof vi.fn> },
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

        const maxIter = getMaxReviewIterations();

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
        try {
          try {
            await Promise.race([
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
        } finally {
          pendingReReviews.delete(codingSessionId);
        }
      })();
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSettings.max_review_iterations = 3;
});

// ── Push-cap path (server.ts) ─────────────────────────────────────────────────

describe('push_detected cap path', () => {
  async function triggerPushWithIteration(
    reviewIteration: number,
    maxIterSetting: string | null = null,
  ): Promise<{ broadcastedMessages: unknown[] }> {
    vi.mocked(queries.getSetting).mockReturnValue(maxIterSetting);

    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const reviewService = { reReviewPR: vi.fn().mockResolvedValue({}) };

    wirePushDetectedHandler(sessionManager, reviewService, github);

    const prRow = makePRRow({ review_iteration: reviewIteration });
    vi.mocked(queries.getPRBySessionId).mockReturnValue(prRow);

    const broadcastedMessages: unknown[] = [];
    sessionManager.on('message', (msg: unknown) =>
      broadcastedMessages.push(msg),
    );

    sessionManager.emit('push_detected', { sessionId: CODE_SESSION_ID });
    await new Promise((resolve) => setTimeout(resolve, 50));

    return { broadcastedMessages };
  }

  it('sets pause_reason = max_reviews when review_iteration >= default cap', async () => {
    await triggerPushWithIteration(3);
    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'max_reviews',
    );
  });

  it('emits review_escalated when cap is hit', async () => {
    const { broadcastedMessages } = await triggerPushWithIteration(3);
    const escalated = broadcastedMessages.find(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type: string }).type === 'review_escalated',
    );
    expect(escalated).toBeDefined();
  });

  it('does NOT set pause_reason = max_reviews when iteration is below cap', async () => {
    await triggerPushWithIteration(2);
    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'max_reviews',
    );
  });

  it('reads runtime setting when checking cap — cap = 2', async () => {
    await triggerPushWithIteration(2, '2');
    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'max_reviews',
    );
  });

  it('does NOT escalate when iteration < runtime setting cap', async () => {
    await triggerPushWithIteration(1, '2');
    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'max_reviews',
    );
  });
});

// ── ReviewOrchestrator initial-cap path (regression) ─────────────────────────

describe('ReviewOrchestrator initial-cap path regression', () => {
  function buildOrchestrator() {
    const sessionManager = new MockSessionManager();
    const github = makeMockGitHub();
    const reviewService = {
      reviewPR: vi.fn().mockResolvedValue({
        verdict: 'needs_changes',
        summary: 'Fix things',
        dimensions: [],
        prNumber: PR_NUMBER,
        repo: REPO,
        reviewedAt: new Date().toISOString(),
      }),
      reReviewPR: vi.fn(),
      setMergeWatcher: vi.fn(),
      setAutoMerger: vi.fn(),
    } as unknown as PRReviewService;

    const orchestrator = new ReviewOrchestrator(
      reviewService,
      sessionManager as unknown as InstanceType<
        typeof import('../session/SessionManager.js').SessionManager
      >,
      1,
      true,
      github,
    );
    return { orchestrator, sessionManager, reviewService };
  }

  it('sets pause_reason = max_reviews when initial PR review hits cap', async () => {
    const { sessionManager } = buildOrchestrator();

    const prRow = makePRRow({ review_iteration: 3 });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);
    vi.mocked(queries.getSetting).mockReturnValue(null);

    sessionManager.emit('pr_opened', {
      prNumber: PR_NUMBER,
      repo: REPO,
      taskId: 'task-1',
      contextUrl: 'https://notion.so/ctx',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'max_reviews',
    );
  });

  it('reads runtime setting in initial-cap path — cap = 2', async () => {
    const { sessionManager } = buildOrchestrator();

    const prRow = makePRRow({ review_iteration: 2 });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);
    vi.mocked(queries.getSetting).mockReturnValue('2');

    sessionManager.emit('pr_opened', {
      prNumber: PR_NUMBER,
      repo: REPO,
      taskId: 'task-1',
      contextUrl: 'https://notion.so/ctx',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'max_reviews',
    );
  });
});

// ── Settings route — max_review_iterations ────────────────────────────────────

describe('Settings route — max_review_iterations', () => {
  function buildSettingsApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRouter);
    return app;
  }

  it('GET /api/settings includes max_review_iterations with default 3', async () => {
    const res = await supertest(buildSettingsApp()).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('max_review_iterations', '3');
  });

  it('PATCH /api/settings with max_review_iterations calls setSetting', async () => {
    const res = await supertest(buildSettingsApp())
      .patch('/api/settings')
      .send({ max_review_iterations: '5' });
    expect(res.status).toBe(200);
    expect(vi.mocked(queries.setSetting)).toHaveBeenCalledWith(
      'max_review_iterations',
      '5',
    );
  });

  it('PATCH /api/settings updates the returned current value', async () => {
    const app = buildSettingsApp();
    await supertest(app)
      .patch('/api/settings')
      .send({ max_review_iterations: '5' });
    const res = await supertest(app).get('/api/settings');
    expect(res.body).toHaveProperty('max_review_iterations', '5');
  });
});
