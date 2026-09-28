/**
 * Integration test: re-review / re-fix orchestration loop
 *
 * Wires a REAL PRMergeWatcher together with a REAL ReviewOrchestrator (and a
 * minimally-mocked PRReviewService) and exercises the full push-review loop
 * end to end:
 *
 *   push_detected (before review session) → pending_push queued
 *   → initial review dispatches via ReviewOrchestrator.onPrOpened → needs_changes
 *     → feedback delivered to the coding session
 *   → a subsequent push (PRMergeWatcher.handlePushDetected) enqueues a
 *     re-review via the real ReviewOrchestrator, which drains it through
 *     executeReview → review_iteration increments once per push that reaches
 *     an actual review dispatch
 *   → escalation fires at the configured cap, no further review dispatched
 *   → an autofix-only push does not increment the iteration counter or
 *     dispatch a review
 *
 * PRMergeWatcher.handlePushDetected itself decides only whether/how to call
 * ReviewOrchestrator.enqueueReview — all of autofix/verify/analyze/tests/
 * review dispatch happens inside ReviewOrchestrator.executeReview via
 * PreReviewPipeline.run, so the pre-review gates below are mocked to pass
 * quickly (mirroring ReviewOrchestrator.test.ts's own convention) rather than
 * re-tested here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';
import { EventEmitter } from 'events';

// ── Module mocks (must appear before any imports that transitively use them) ──

vi.mock('../db/queries.js', () =>
  mockDbQueries({
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
    getSession: vi.fn().mockReturnValue(undefined),
    getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
    insertPendingReviewSync: vi.fn(),
    deletePendingReviewSync: vi.fn(),
    consumeAutofixSha: vi.fn().mockReturnValue(false),
    clearTerminalPRFlags: vi.fn(),
    setPreReviewStage: vi.fn(),
  }),
);

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
  TASK_BACKEND: 'local',
  getProjectById: vi.fn(),
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  normalizePath: (p: string) => p,
  runtimeSettings: { auto_review_concurrency: 20 },
}));

vi.mock('../orchestration/memoryAdmission.js', () => ({
  // respawnSession's memory-admission gate — real os.freemem() is
  // unreliable/low in CI/sandboxed hosts, so tests always see headroom
  // unless a test explicitly overrides this mock.
  hasMemoryHeadroom: vi.fn().mockReturnValue({
    allowed: true,
    freeMemMB: 8192,
    minHostFreeMemoryMB: 4096,
    perSessionReserveMB: 3072,
    projectedFreeMB: 5120,
  }),
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
  tailOfLog: vi.fn().mockReturnValue(''),
}));

vi.mock('../orchestration/baseAttributableFilter.js', () => ({
  filterVerifyFailureByBaseHealth: vi.fn().mockResolvedValue(null),
  renderBaseAttributableFilterDigest: vi.fn().mockReturnValue('digest'),
  filterBaseAttributableFailures: vi.fn(),
  applyF2GateMaskingGuards: vi.fn(),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'clean' }),
  getChangedFiles: vi.fn().mockReturnValue([]),
}));

vi.mock('../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi
    .fn()
    .mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
    test: [],
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  }),
}));

vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { ReviewOrchestrator } from '../github/ReviewOrchestrator.js';
import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import * as queries from '../db/queries.js';
import type { PullRequestRow } from '../db/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type {
  PRReviewService,
  PRReviewResult,
} from '../github/PRReviewService.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO = 'owner/repo';
const PR_NUMBER = 42;
const CODE_SESSION_ID = 'code-session-uuid';
const REVIEW_SESSION_ID = 'review-session-uuid';
const HEAD_SHA = 'abc123';
const NEW_SHA = 'def456';
const NEWER_SHA = 'ghi789';

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
  } as PullRequestRow;
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

// ── Mock SessionManager ───────────────────────────────────────────────────────

/**
 * Minimal SessionManager mock that extends EventEmitter and exposes the
 * methods that ReviewOrchestrator, PreReviewPipeline, and PRMergeWatcher call.
 */
class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn().mockResolvedValue(CODE_SESSION_ID);
  enqueueFeedback = vi.fn().mockResolvedValue(undefined);
  isAlive = vi.fn().mockReturnValue(false);
  endSession = vi.fn();
  start = vi.fn();
}

// ── Mock GitHub client ─────────────────────────────────────────────────────────

function makeMockGitHub(headSha: string = HEAD_SHA): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    fetchPR: vi.fn().mockResolvedValue({ headSha, number: PR_NUMBER }),
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
    categorizeMergeability: vi.fn(),
    listOpenPRStates: vi.fn(),
  } as unknown as GitHubClient;
}

/** A minimal PRReviewService double — only reviewPR is exercised by the real
 * ReviewOrchestrator.executeReview path; reReviewPR no longer exists on the
 * real class and must not be referenced here. */
function makeMockReviewService(): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue(makeNeedsChangesResult()),
  } as unknown as PRReviewService;
}

// ── Harness ───────────────────────────────────────────────────────────────────

// Every ReviewOrchestrator constructed via makeHarness() below — torn down
// in the shared afterEach so its stall-detector interval and pendingSyncs
// bookkeeping don't outlive the test that created it.
const harnessOrchestrators: ReviewOrchestrator[] = [];

function makeHarness(headSha: string = HEAD_SHA) {
  const sessionManager = new MockSessionManager();
  const github = makeMockGitHub(headSha);
  const reviewService = makeMockReviewService();
  const orchestrator = new ReviewOrchestrator(
    reviewService,
    sessionManager as unknown as InstanceType<
      typeof import('../session/SessionManager.js').SessionManager
    >,
    true,
    github,
  );
  harnessOrchestrators.push(orchestrator);
  const broadcast = vi.fn();
  const watcher = new PRMergeWatcher(
    github,
    sessionManager as unknown as InstanceType<
      typeof import('../session/SessionManager.js').SessionManager
    >,
    undefined,
    broadcast,
  );
  watcher.setReviewOrchestrator(orchestrator);
  return {
    sessionManager,
    github,
    reviewService,
    orchestrator,
    watcher,
    broadcast,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks() resets call history but not a mockReturnValue set by an
  // earlier test (e.g. the autofix-only-push test below) — re-arm the
  // non-autofix-only default explicitly so it can't leak into later tests.
  vi.mocked(queries.consumeAutofixSha).mockReturnValue(false);
});

afterEach(() => {
  // Release every real ReviewOrchestrator's stall-detector interval so it
  // doesn't outlive this test file's own run.
  for (const orchestrator of harnessOrchestrators.splice(0)) {
    orchestrator.destroy();
  }
});

// ── 1. Push before review session → pending_push queued, no review job ────────

describe('push before a review session is established', () => {
  it('queues pending_push and does not enqueue a review job', async () => {
    const { watcher, orchestrator } = makeHarness();
    const enqueueSpy = vi.spyOn(orchestrator, 'enqueueReview');

    const prRow = makePRRow({ review_session_id: null, review_result: null });
    await watcher.handlePushDetected(prRow);

    expect(vi.mocked(queries.setPendingPush)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      1,
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// ── 2. Initial review dispatches via ReviewOrchestrator, needs_changes ────────

describe('initial review dispatch via ReviewOrchestrator.onPrOpened', () => {
  it('reaches needs_changes and delivers feedback to the coding session at iteration 0', async () => {
    const { sessionManager, reviewService, orchestrator } = makeHarness();

    const prRow = makePRRow({ review_session_id: null });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    sessionManager.emit('pr_opened', {
      prNumber: PR_NUMBER,
      repo: REPO,
      taskId: 'notion-task-id',
      taskUrl: 'https://notion.so/task',
      contextUrl: '',
    });

    await vi.waitFor(() => {
      expect(vi.mocked(reviewService.reviewPR)).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(vi.mocked(queries.incrementReviewIteration)).not.toHaveBeenCalled();
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      CODE_SESSION_ID,
      'ai-reviewer',
      expect.stringContaining('Iteration 0'),
      expect.anything(),
    );
    void orchestrator;
  });
});

// ── 3. A subsequent push enqueues a re-review through the real orchestrator ───

describe('subsequent push enqueues and drains a re-review through the real ReviewOrchestrator', () => {
  it('increments review_iteration exactly once and delivers feedback threaded with the new iteration', async () => {
    const { sessionManager, reviewService, watcher, github } =
      makeHarness(NEW_SHA);

    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      review_iteration: 0,
      last_reviewed_sha: HEAD_SHA,
      head_sha: HEAD_SHA,
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);
    vi.mocked(queries.incrementReviewIteration).mockReturnValue(1);
    vi.mocked(reviewService.reviewPR).mockResolvedValue(
      makeNeedsChangesResult(),
    );

    await watcher.handlePushDetected(prRow);

    await vi.waitFor(() => {
      expect(vi.mocked(reviewService.reviewPR)).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(vi.mocked(queries.incrementReviewIteration)).toHaveBeenCalledTimes(
      1,
    );
    expect(vi.mocked(queries.incrementReviewIteration)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
    );
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      CODE_SESSION_ID,
      'ai-reviewer',
      expect.stringContaining('Iteration 1'),
      expect.anything(),
    );
    expect(vi.mocked(github.fetchPR)).toHaveBeenCalled();
  });
});

// ── 4. Escalation at the configured cap ────────────────────────────────────────

describe('escalation at the review-iteration cap', () => {
  it('sets pause_reason max_reviews, broadcasts review_escalated, and does not enqueue a further review job', async () => {
    vi.mocked(queries.getSetting).mockReturnValue('2');
    const { watcher, orchestrator, broadcast } = makeHarness();
    const enqueueSpy = vi.spyOn(orchestrator, 'enqueueReview');

    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      review_iteration: 2,
      last_reviewed_sha: 'old-sha',
      head_sha: HEAD_SHA,
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    await watcher.handlePushDetected(prRow);

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'max_reviews',
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'review_escalated',
        prNumber: PR_NUMBER,
        repo: REPO,
      }),
    );
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// ── 5. Autofix-only push ───────────────────────────────────────────────────────

describe('autofix-only push', () => {
  it('does not increment review_iteration or dispatch a review', async () => {
    vi.mocked(queries.consumeAutofixSha).mockReturnValue(true);
    const { watcher, orchestrator, reviewService } = makeHarness(NEW_SHA);
    const enqueueSpy = vi.spyOn(orchestrator, 'enqueueReview');

    const prRow = makePRRow({
      review_session_id: REVIEW_SESSION_ID,
      review_iteration: 0,
      last_reviewed_sha: HEAD_SHA,
      head_sha: HEAD_SHA,
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    await watcher.handlePushDetected(prRow);
    await new Promise((r) => setTimeout(r, 10));

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(vi.mocked(queries.incrementReviewIteration)).not.toHaveBeenCalled();
    expect(vi.mocked(reviewService.reviewPR)).not.toHaveBeenCalled();
  });
});

// ── 6. Gate failure after no established review session still enqueues ────────

describe('push after a gate-failure verdict with no established review session', () => {
  it('enqueues a re-review (the dropped !review_session_id precondition this change fixes)', async () => {
    const { watcher, orchestrator } = makeHarness(NEWER_SHA);
    const enqueueSpy = vi.spyOn(orchestrator, 'enqueueReview');

    const prRow = makePRRow({
      review_session_id: null,
      review_result: JSON.stringify({
        verdict: 'verify_failed',
        summary: 'verify failed',
        dimensions: [],
      }),
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);

    await watcher.handlePushDetected(prRow);

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: PR_NUMBER,
        repo: REPO,
        pushTriggered: true,
      }),
    );
    expect(vi.mocked(queries.setPendingPush)).not.toHaveBeenCalled();
  });
});
