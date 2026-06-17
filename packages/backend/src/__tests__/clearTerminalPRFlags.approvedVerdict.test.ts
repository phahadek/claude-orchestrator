/**
 * Focused test for the approved-verdict call site in PRMergeWatcher.
 * Kept separate because it needs AUTO_REVIEW_ENABLED: true, which is
 * incompatible with the broader clearTerminalPRFlags.test.ts mock setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockClearTerminalPRFlags = vi.fn();

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  getPRByNumber: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn(),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getTestResult: vi.fn().mockReturnValue(null),
  markSessionDone: vi.fn(),
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: mockClearTerminalPRFlags,
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi
    .fn()
    .mockReturnValue({ id: 'proj-1', projectDir: '/test' }),
  getProjectById: vi.fn().mockReturnValue(null),
  AUTO_REVIEW_ENABLED: true, // must be true to reach the approved-verdict branch
  runtimeSettings: {},
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ test: [], ci_check_name: [] }),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: vi.fn().mockReturnValue(3),
}));

vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../routes/tasks.js', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../tasks/TaskBackend.js', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../github/reviewUtils.js', () => ({
  formatCIFailureFeedback: vi.fn(),
  shouldAutoReview: vi.fn().mockReturnValue(true),
  formatReviewFeedback: vi.fn(),
}));
vi.mock('../github/conflictNudge.js', () => ({ sendConflictNudge: vi.fn() }));
vi.mock('../github/pollUtils.js', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));
vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn(),
  runAutofix: vi.fn(),
}));

import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { PRReviewService } from '../github/PRReviewService.js';
import type { ReviewOrchestrator } from '../github/ReviewOrchestrator.js';
import type { PullRequestRow } from '../db/types.js';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: null,
    session_id: 'session-abc',
    review_session_id: 'review-session-abc',
    repo: 'owner/repo',
    title: 'PR 42',
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_iteration: 0,
    head_sha: 'head-sha-1',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason:
      '{"reason":"review_failed","source":"review","severity":"needs_attention","retry_strategy":"manual_action"}',
    pre_review_stage: 'autofix',
    pause_reason_set_at: null,
    conflict_nudge_sha: null,
    ci_remediation_attempted_sha: null,
    autofix_shas: null,
    ...overrides,
  } as PullRequestRow;
}

describe('PRMergeWatcher — approved verdict clears terminal flags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls clearTerminalPRFlags when review verdict is approved', async () => {
    const github = {
      fetchPR: vi.fn().mockResolvedValue({ headSha: 'head-sha-1' }),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    } as unknown as GitHubClient;

    const sessions = {
      markSessionErrored: vi.fn(),
      endSession: vi.fn(),
      markForBranchDeletion: vi.fn(),
      sendOrResume: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as SessionManager;

    const prReviewService = {
      reReviewPR: vi.fn().mockResolvedValue({
        verdict: 'approved',
        summary: 'Looks good',
        dimensions: [],
        prNumber: 42,
        repo: 'owner/repo',
        reviewedAt: new Date().toISOString(),
      }),
    } as unknown as PRReviewService;

    const reviewOrchestrator = {
      consumeAutofixSha: vi.fn().mockReturnValue(false),
      runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
      runTestPipeline: vi.fn().mockResolvedValue(undefined),
      isReviewInFlight: vi.fn().mockReturnValue(false),
    } as unknown as ReviewOrchestrator;

    const watcher = new PRMergeWatcher(github, sessions, undefined, vi.fn());
    watcher.setPRReviewService(prReviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    const pr = makePRRow();
    await watcher.handlePushDetected(pr);

    // Wait for the void async IIFE inside handlePushDetected to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(mockClearTerminalPRFlags).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('does not call clearTerminalPRFlags when review verdict is needs_changes', async () => {
    const github = {
      fetchPR: vi.fn().mockResolvedValue({ headSha: 'head-sha-1' }),
    } as unknown as GitHubClient;

    const sessions = {
      markSessionErrored: vi.fn(),
      endSession: vi.fn(),
      sendOrResume: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as SessionManager;

    const prReviewService = {
      reReviewPR: vi.fn().mockResolvedValue({
        verdict: 'needs_changes',
        summary: 'Please fix X',
        dimensions: [],
        prNumber: 42,
        repo: 'owner/repo',
        reviewedAt: new Date().toISOString(),
      }),
    } as unknown as PRReviewService;

    const reviewOrchestrator = {
      consumeAutofixSha: vi.fn().mockReturnValue(false),
      runAutofixPipeline: vi.fn().mockResolvedValue(undefined),
      runTestPipeline: vi.fn().mockResolvedValue(undefined),
      isReviewInFlight: vi.fn().mockReturnValue(false),
    } as unknown as ReviewOrchestrator;

    const watcher = new PRMergeWatcher(github, sessions, undefined, vi.fn());
    watcher.setPRReviewService(prReviewService);
    watcher.setReviewOrchestrator(reviewOrchestrator);

    const pr = makePRRow();
    await watcher.handlePushDetected(pr);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockClearTerminalPRFlags).not.toHaveBeenCalled();
  });
});
