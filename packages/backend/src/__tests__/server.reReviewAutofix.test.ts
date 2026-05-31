/**
 * Regression tests for the push_detected path verifying that
 * PRMergeWatcher.handlePushDetected (the unified push pipeline) correctly
 * invokes runAutofixPipeline before prReviewService.reReviewPR.
 *
 * Acceptance criteria covered:
 * AC3 — push pipeline invokes runAutofixPipeline before reReviewPR.
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
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
}));

vi.mock('../config.js', () => ({
  AUTO_REVIEW_ENABLED: true,
  AUTO_REVIEW_CONCURRENCY: 1,
  runtimeSettings: {},
  getProjectByGithubRepo: vi.fn().mockReturnValue(null),
  getProjectById: vi.fn(),
  getAllProjects: vi.fn(() => []),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({ ci_check_name: [] }),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

import * as queries from '../db/queries.js';
import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import type { PullRequestRow } from '../db/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { SessionManager } from '../session/SessionManager.js';

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
    ci_remediation_attempted_sha: null,
    ...overrides,
  };
}

class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn().mockResolvedValue('session-id');
}

function makeMockGitHub(headSha = HEAD_SHA): GitHubClient {
  return {
    fetchPR: vi.fn().mockResolvedValue({ headSha }),
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'unknown',
      mergeState: 'unknown',
      rawMergeableState: null,
      failingChecks: [],
      headSha: null,
    }),
  } as unknown as GitHubClient;
}

function makeMockNotion() {
  return { updateStatus: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Creates a PRMergeWatcher wired with injectable reviewService and reviewOrchestrator,
 * mimicking the server.ts setup. The watcher's handlePushDetected is the unified
 * push pipeline (replacing the old inline wirePushDetectedHandler).
 */
function makeWatcher(
  reviewService: { reReviewPR: ReturnType<typeof vi.fn> },
  githubClient: GitHubClient,
  reviewOrchestrator: {
    runAutofixPipeline: ReturnType<typeof vi.fn>;
    consumeAutofixSha: ReturnType<typeof vi.fn>;
  },
  sessions: MockSessionManager,
): PRMergeWatcher {
  const watcher = new PRMergeWatcher(
    githubClient,
    sessions as unknown as SessionManager,
    makeMockNotion() as any,
    () => {},
  );
  watcher.setPRReviewService(reviewService as any);
  watcher.setReviewOrchestrator(reviewOrchestrator as any);
  return watcher;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC3: runAutofixPipeline is called before reReviewPR ──────────────────────

describe('push_detected: runAutofixPipeline called before reReviewPR', () => {
  it('calls runAutofixPipeline before reReviewPR on a valid push', async () => {
    const callOrder: string[] = [];

    const sessions = new MockSessionManager();
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
        return { verdict: 'approved', summary: 'Looks good', dimensions: [] };
      }),
    };

    const watcher = makeWatcher(
      reviewService,
      github,
      reviewOrchestrator,
      sessions,
    );
    await watcher.handlePushDetected(makePRRow());
    await new Promise((r) => setTimeout(r, 50));

    expect(callOrder.indexOf('runAutofixPipeline')).toBeLessThan(
      callOrder.indexOf('reReviewPR'),
    );
  });

  it('passes prNumber, repo, and task_id to runAutofixPipeline', async () => {
    const sessions = new MockSessionManager();
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

    const watcher = makeWatcher(
      reviewService,
      github,
      reviewOrchestrator,
      sessions,
    );
    await watcher.handlePushDetected(makePRRow());
    await new Promise((r) => setTimeout(r, 50));

    expect(reviewOrchestrator.runAutofixPipeline).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'notion:task-abc',
    );
  });

  it('does NOT call runAutofixPipeline when consumeAutofixSha is true (autofix-only push)', async () => {
    const sessions = new MockSessionManager();
    const github = makeMockGitHub();
    const reviewOrchestrator = {
      runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
      consumeAutofixSha: vi.fn().mockReturnValue(true), // autofix-only
    };
    const reviewService = { reReviewPR: vi.fn() };

    const watcher = makeWatcher(
      reviewService,
      github,
      reviewOrchestrator,
      sessions,
    );
    await watcher.handlePushDetected(makePRRow());
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

    const sessions = new MockSessionManager();
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

    const watcher = makeWatcher(
      reviewService,
      github,
      reviewOrchestrator,
      sessions,
    );

    // First push: coding session push → autofix runs, re-review runs
    await watcher.handlePushDetected(makePRRow());
    await new Promise((r) => setTimeout(r, 50));

    expect(reviewOrchestrator.runAutofixPipeline).toHaveBeenCalledTimes(1);
    expect(reviewService.reReviewPR).toHaveBeenCalledTimes(1);

    // Second push: autofix commit arrives — headSha is the autofix SHA
    // consumeAutofixSha returns true → re-review (and autofix) skipped
    // Use a new PR row with a different session_id to bypass pendingReReviews dedup
    await watcher.handlePushDetected(
      makePRRow({ session_id: 'coding-session-2' }),
    );
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
): { watcher: PRMergeWatcher; prRow: PullRequestRow } {
  const sessions = new MockSessionManager();
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

  const watcher = makeWatcher(
    reviewService,
    github,
    reviewOrchestrator,
    sessions,
  );
  const prRow = makePRRow({ pause_reason: pauseReason });
  return { watcher, prRow };
}

describe('push_detected: pause_reason cleared on approved verdict', () => {
  it('clears pause_reason when prior pause was review_failed and verdict is approved', async () => {
    const { watcher, prRow } = makePushHelper('review_failed', 'approved');
    await watcher.handlePushDetected(prRow);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('clears pause_reason when prior pause was stuck_timeout and verdict is approved', async () => {
    const { watcher, prRow } = makePushHelper('stuck_timeout', 'approved');
    await watcher.handlePushDetected(prRow);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('clears pause_reason when prior pause was max_reviews and verdict is approved', async () => {
    const { watcher, prRow } = makePushHelper('max_reviews', 'approved');
    await watcher.handlePushDetected(prRow);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('does NOT clear pause_reason when verdict is needs_changes', async () => {
    const { watcher, prRow } = makePushHelper('review_failed', 'needs_changes');
    await watcher.handlePushDetected(prRow);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('does NOT clear pause_reason when verdict is incomplete', async () => {
    const { watcher, prRow } = makePushHelper('review_failed', 'incomplete');
    await watcher.handlePushDetected(prRow);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });

  it('does not call setPauseReason(null) when pause_reason is already null and verdict is approved', async () => {
    const { watcher, prRow } = makePushHelper(null, 'approved');
    await watcher.handlePushDetected(prRow);
    await new Promise((r) => setTimeout(r, 50));

    expect(vi.mocked(queries.setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
  });
});
