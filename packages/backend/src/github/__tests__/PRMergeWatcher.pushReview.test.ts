import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  AUTO_REVIEW_ENABLED: true,
}));
vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue(5),
}));
vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    test: [],
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  }),
}));
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../db/queries', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(null),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getLatestTestRequestRun: vi.fn().mockReturnValue(null),
  markSessionDone: vi.fn(),
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../reviewUtils', () => ({
  formatCIFailureFeedback: vi.fn(),
  shouldAutoReview: vi.fn().mockReturnValue(true),
  formatReviewFeedback: vi.fn().mockReturnValue('feedback'),
}));
vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));
vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));
vi.mock('../../db/pauseReason', () => ({
  parsePauseReason: vi.fn().mockReturnValue(null),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PRMergeWatcher } from '../PRMergeWatcher';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { ReviewOrchestrator } from '../ReviewOrchestrator';
import { getProjectByGithubRepo } from '../../config';
import {
  getSession,
  setPendingPush,
  setPauseReason,
  clearTerminalPRFlags,
} from '../../db/queries';
import { shouldAutoReview } from '../reviewUtils';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 42;
const REPO = 'org/repo';
const SESSION_ID = 'coder-session-abc';
const REVIEW_SESSION_ID = 'review-session-xyz';
const HEAD_SHA = 'abc1234567890';

function makeGithubClient(): GitHubClient {
  return {
    fetchPR: vi
      .fn()
      .mockResolvedValue({ headSha: HEAD_SHA, number: PR_NUMBER }),
    categorizeMergeability: vi.fn(),
    listOpenPRStates: vi.fn(),
    markPRReady: vi.fn(),
  } as unknown as GitHubClient;
}

function makeSessionManager(): SessionManager {
  const ee = new EventEmitter() as unknown as SessionManager;
  (ee as any).sendOrResume = vi.fn().mockResolvedValue('review-session-id');
  (ee as any).on = ee.on.bind(ee);
  (ee as any).off = ee.off.bind(ee);
  return ee;
}

function makeReviewOrchestrator(): ReviewOrchestrator {
  return {
    consumeAutofixSha: vi.fn().mockReturnValue(false),
    isReviewInFlight: vi.fn().mockReturnValue(false),
    enqueueReview: vi.fn(),
  } as unknown as ReviewOrchestrator;
}

function makePRRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pr_number: PR_NUMBER,
    repo: REPO,
    session_id: SESSION_ID,
    review_session_id: REVIEW_SESSION_ID,
    review_iteration: 0,
    state: 'open',
    draft: 0,
    task_id: 'task-1',
    head_sha: HEAD_SHA,
    last_reviewed_sha: null,
    pause_reason: null,
    review_result: null,
    ...overrides,
  } as any;
}

function makeProject() {
  return {
    id: 'project-abc',
    projectDir: '/repo',
    contextUrl: 'https://notion.so/project-abc',
    baseBranch: 'dev',
    githubRepo: REPO,
    test: [],
  } as any;
}

function verdictResult(verdict: string) {
  return JSON.stringify({ verdict, summary: 'x', dimensions: [] });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRMergeWatcher.handlePushDetected — routes through ReviewOrchestrator.enqueueReview', () => {
  let github: GitHubClient;
  let sessions: SessionManager;
  let reviewOrchestrator: ReviewOrchestrator;
  let watcher: PRMergeWatcher;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    github = makeGithubClient();
    sessions = makeSessionManager();
    reviewOrchestrator = makeReviewOrchestrator();
    broadcast = vi.fn();

    watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue({ task_url: 'https://task' } as any);
  });

  it('enqueues exactly one review job for a push to a PR with an established review session', async () => {
    const project = makeProject();
    vi.mocked(getProjectByGithubRepo).mockReturnValue(project);

    await watcher.handlePushDetected(
      makePRRow({ review_result: verdictResult('needs_changes') }),
    );

    expect(reviewOrchestrator.enqueueReview).toHaveBeenCalledTimes(1);
    expect(reviewOrchestrator.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: PR_NUMBER,
        repo: REPO,
        taskId: 'task-1',
        headSha: HEAD_SHA,
        pushTriggered: true,
      }),
    );
  });

  it('still enqueues a re-review when review_session_id is null but the stored verdict is verify_failed', async () => {
    await watcher.handlePushDetected(
      makePRRow({
        review_session_id: null,
        review_result: verdictResult('verify_failed'),
      }),
    );

    expect(reviewOrchestrator.enqueueReview).toHaveBeenCalledTimes(1);
    expect(reviewOrchestrator.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: PR_NUMBER,
        repo: REPO,
        pushTriggered: true,
      }),
    );
  });

  it('still enqueues a re-review when review_session_id is null but the stored verdict is autofix_failed', async () => {
    await watcher.handlePushDetected(
      makePRRow({
        review_session_id: null,
        review_result: verdictResult('autofix_failed'),
      }),
    );

    expect(reviewOrchestrator.enqueueReview).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue and instead marks pending_push when no review session exists and there is no gate-failure verdict', async () => {
    await watcher.handlePushDetected(
      makePRRow({ review_session_id: null, review_result: null }),
    );

    expect(reviewOrchestrator.enqueueReview).not.toHaveBeenCalled();
    expect(setPendingPush).toHaveBeenCalledWith(PR_NUMBER, REPO, 1);
  });

  it('does not enqueue when the push is an autofix-only commit', async () => {
    vi.mocked(reviewOrchestrator.consumeAutofixSha).mockReturnValue(true);

    await watcher.handlePushDetected(
      makePRRow({ review_result: verdictResult('needs_changes') }),
    );

    expect(reviewOrchestrator.consumeAutofixSha).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      HEAD_SHA,
    );
    expect(reviewOrchestrator.enqueueReview).not.toHaveBeenCalled();
  });

  it('escalates to max_reviews pause and broadcasts review_escalated when review_iteration has reached the cap, without enqueueing', async () => {
    // typedGetSetting is mocked to return 5 — getMaxReviewIterations reads it.
    await watcher.handlePushDetected(
      makePRRow({
        review_iteration: 5,
        review_result: verdictResult('needs_changes'),
      }),
    );

    expect(setPauseReason).toHaveBeenCalledWith(PR_NUMBER, REPO, 'max_reviews');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'review_escalated',
        prNumber: PR_NUMBER,
        repo: REPO,
      }),
    );
    expect(reviewOrchestrator.enqueueReview).not.toHaveBeenCalled();
  });

  it('skips enqueue when shouldAutoReview says the head is already reviewed at this SHA (non-gate-failure case)', async () => {
    vi.mocked(shouldAutoReview).mockReturnValueOnce(false);

    await watcher.handlePushDetected(
      makePRRow({
        review_result: verdictResult('needs_changes'),
        last_reviewed_sha: HEAD_SHA,
      }),
    );

    expect(shouldAutoReview).toHaveBeenCalled();
    expect(reviewOrchestrator.enqueueReview).not.toHaveBeenCalled();
  });

  it('clears terminal PR flags via head_sha_advance before enqueueing the review', async () => {
    await watcher.handlePushDetected(
      makePRRow({
        review_session_id: null,
        review_result: verdictResult('verify_failed'),
      }),
    );

    expect(clearTerminalPRFlags).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'head_sha_advance',
    );
    expect(reviewOrchestrator.enqueueReview).toHaveBeenCalledTimes(1);

    const clearOrder =
      vi.mocked(clearTerminalPRFlags).mock.invocationCallOrder[0];
    const enqueueOrder = vi.mocked(reviewOrchestrator.enqueueReview).mock
      .invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(enqueueOrder);
  });

  it('warns and returns without enqueueing when no reviewOrchestrator has been set', async () => {
    const bareWatcher = new PRMergeWatcher(
      makeGithubClient(),
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    await expect(
      bareWatcher.handlePushDetected(
        makePRRow({ review_result: verdictResult('needs_changes') }),
      ),
    ).resolves.toBeUndefined();

    // No reviewOrchestrator was set on bareWatcher, so nothing to assert
    // against it — the call simply must not throw.
  });
});
