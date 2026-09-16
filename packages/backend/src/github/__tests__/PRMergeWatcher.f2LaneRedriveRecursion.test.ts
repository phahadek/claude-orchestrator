import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for the unbounded mutual recursion between
// applyFlakeRecoveryOutcome's re-drive and tryF2LaneAutoDisposition:
// a passing re-run resets flake_recovery_attempts to 0 and then re-enters
// the F2 gate through checkMergeabilityNow, so the retry budget could never
// bound the re-entry. With the F2 test result still reporting failed (the
// state that makes the gate re-fire), the pair recursed until the V8 heap
// died — 289,820 iterations and 7.4 GB before FATAL, which is what turned
// the whole backend suite red.
//
// PreReviewPipeline.rerunFlakyTests no longer hands back a synchronous
// outcome (it only enqueues the rerun — see its own doc comment), so
// tryF2LaneAutoDisposition/applyFlakeRecoveryOutcome no longer call
// checkMergeabilityNow from inside this call chain at all: the eventual
// outcome is read back from a settled test_request_runs row on a later,
// independent runMergeabilityCheck tick. That structurally removes the
// recursion vector this file guards against; these tests now assert the
// call-count discipline that replaces it — at most one rerun triggered per
// still-unsettled/still-failing verdict, and a later tick can still trigger
// its own independent rerun once that verdict has moved on.

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getLatestTestRequestRun: vi.fn(),
  markSessionDone: vi.fn(),
  updateSessionStatus: vi.fn(),
  recordPrAnchoredCompletingSignal: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  setHeadBranch: vi.fn(),
  clearSessionInitiatedPRClose: vi.fn(),
  incrementFlakeRecoveryAttempts: vi.fn(),
  resetFlakeRecoveryAttempts: vi.fn(),
  setFlakeRecoveryBaseExhausted: vi.fn(),
  getLatestTestRequestRunForSession: vi.fn().mockReturnValue(undefined),
  isRunFailureBreadthAttributable: vi.fn().mockReturnValue(false),
  recordMergeCommitForSession: vi.fn(),
  setConflictNudgeSha: vi.fn(),
  setPreReviewStage: vi.fn(),
}));

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  AUTO_REVIEW_ENABLED: true,
}));

vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue(2),
}));

vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    ci_check_name: [],
    test: ['npm run test'],
    test_timeout_sec: 300,
  }),
}));

vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
  getChangedFiles: vi.fn().mockResolvedValue(['src/unrelated.ts']),
}));

vi.mock('../../session/analyzeGating', () => ({
  computeWholeTreeContentHash: vi.fn().mockResolvedValue('content-hash-1'),
}));

vi.mock('../../orchestration/testRequestLane', () => ({
  evaluateF2LaneFlakyDisposition: vi.fn().mockReturnValue(true),
}));

vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));

vi.mock('../../audit/flakyRemediationFiling', () => ({
  closeFlakyRemediationTaskIfLinked: vi.fn(),
}));

vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));

vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));

import { PRMergeWatcher } from '../PRMergeWatcher';
import {
  getPRByNumber,
  getSession,
  getLatestTestRequestRun,
} from '../../db/queries';
import { getProjectByGithubRepo } from '../../config';
import { computeWholeTreeContentHash } from '../../session/analyzeGating';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { ReviewOrchestrator } from '../ReviewOrchestrator';
import type { PullRequestRow, TestRequestRunRow } from '../../db/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 42;
const REPO = 'owner/repo';
const HEAD_SHA = 'sha-f2-1';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'task-abc',
    session_id: 'coding-session',
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
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: HEAD_SHA,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    // Distinct from head_sha so poll()'s F2 block reaches the lane-side
    // auto-disposition rather than short-circuiting on per-SHA dedup.
    ci_remediation_attempted_sha: 'sha-previous',
    pause_reason: null,
    pause_reason_set_at: null,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 0,
    session_initiated_close_at: null,
    reviewer_requested_at: null,
    flake_recovery_attempts: 0,
    ...overrides,
  } as PullRequestRow;
}

function makeFailedTestRun(
  overrides: Partial<TestRequestRunRow> = {},
): TestRequestRunRow {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    content_hash: 'content-hash-1',
    session_id: null,
    state: 'failed',
    output: 'boom',
    requested_at: 0,
    started_at: 0,
    finished_at: 0,
    failure_reason: 'generic',
    structured_result: null,
    concurrent_run_count: 0,
    oom_killed: 0,
    ...overrides,
  } as unknown as TestRequestRunRow;
}

function makeMockGitHub(): GitHubClient {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: HEAD_SHA }),
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
      headSha: HEAD_SHA,
    }),
  } as unknown as GitHubClient;
}

function makeMockSessions(): SessionManager {
  return {
    on: vi.fn(),
    off: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

describe('PRMergeWatcher — f2 lane re-drive recursion guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectByGithubRepo).mockReturnValue({
      id: 'proj-1',
      projectDir: '/proj',
    } as never);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/proj/worktree',
    } as never);
    // The gate keeps seeing a failed F2 result even after a passing re-run —
    // the exact state that made the recursion unbounded.
    vi.mocked(getLatestTestRequestRun).mockReturnValue(makeFailedTestRun());
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
  });

  it('actuates at most one re-run when the same still-failing verdict is observed again', async () => {
    // rerunFlakyTests only enqueues now — it never hands back the eventual
    // pass/fail — so the first tick's trigger records a pending marker
    // (keyed on this content hash) rather than an outcome to branch on.
    const rerunFlakyTests = vi
      .fn()
      .mockResolvedValue({ triggered: true, contentHash: 'content-hash-1' });
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator({
      rerunFlakyTests,
    } as unknown as ReviewOrchestrator);

    await watcher.checkMergeabilityNow(PR_NUMBER, REPO);
    // Second tick still observes the exact same settled (already-consumed)
    // failing row for the same content hash — without the per-SHA dedup
    // this would trigger tryF2LaneAutoDisposition, and hence
    // rerunFlakyTests, all over again.
    await watcher.checkMergeabilityNow(PR_NUMBER, REPO);

    expect(rerunFlakyTests).toHaveBeenCalledTimes(1);
  });

  it('allows a later, independent recovery once a new push has landed', async () => {
    const rerunFlakyTests = vi
      .fn()
      .mockResolvedValue({ triggered: true, contentHash: 'content-hash-1' });
    const watcher = new PRMergeWatcher(
      makeMockGitHub(),
      makeMockSessions(),
      undefined,
      () => {},
    );
    watcher.setReviewOrchestrator({
      rerunFlakyTests,
    } as unknown as ReviewOrchestrator);

    await watcher.checkMergeabilityNow(PR_NUMBER, REPO);

    // A new push landed: new head_sha, new content hash, and (mirroring
    // what setCiRemediationAttemptedSha would have persisted for the first
    // sha) a PR row whose ci_remediation_attempted_sha no longer matches the
    // new head_sha either — a completely independent verdict cycle.
    const NEW_SHA = 'sha-f2-2';
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ head_sha: NEW_SHA, ci_remediation_attempted_sha: HEAD_SHA }),
    );
    vi.mocked(computeWholeTreeContentHash).mockResolvedValue('content-hash-2');
    vi.mocked(getLatestTestRequestRun).mockReturnValue(
      makeFailedTestRun({ id: 'run-2', content_hash: 'content-hash-2' }),
    );
    rerunFlakyTests.mockResolvedValue({
      triggered: true,
      contentHash: 'content-hash-2',
    });

    await watcher.checkMergeabilityNow(PR_NUMBER, REPO);

    expect(rerunFlakyTests).toHaveBeenCalledTimes(2);
  });
});
