import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getTestResult: vi.fn().mockReturnValue(undefined),
  markSessionDone: vi.fn(),
  updateSessionStatus: vi.fn(),
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  setConflictNudgeSha: vi.fn(),
  setHeadBranch: vi.fn(),
  clearSessionInitiatedPRClose: vi.fn(),
  incrementFlakeRecoveryAttempts: vi.fn(),
  resetFlakeRecoveryAttempts: vi.fn(),
}));

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  AUTO_REVIEW_ENABLED: true,
}));

vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue(2),
}));

vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ ci_check_name: [], test: [], test_timeout_sec: 300 }),
}));

vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));

vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));

vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));

// db/pauseReason is left un-mocked — real parse/serialize logic exercises the
// actual ci_failing registry entry.

import { PRMergeWatcher } from '../PRMergeWatcher';
import {
  getPRByNumber,
  setPauseReason,
  getSession,
  incrementFlakeRecoveryAttempts,
  resetFlakeRecoveryAttempts,
  updateMergeState,
} from '../../db/queries';
import { getProjectByGithubRepo } from '../../config';
import { typedGetSetting } from '../../config/settings';
import { pauseReasonFromCanonical, serializePauseReason } from '../../db/pauseReason';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { AutoMerger } from '../AutoMerger';
import type { ReviewOrchestrator } from '../ReviewOrchestrator';
import type { PullRequestRow } from '../../db/types';
import type { VerifiedFlakyDispositionPayload } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 42;
const REPO = 'owner/repo';
const HEAD_SHA = 'sha-flaky-1';

const CI_FAILING_PAUSE = serializePauseReason(
  pauseReasonFromCanonical('ci_failing'),
);

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
    pause_reason: CI_FAILING_PAUSE,
    pause_reason_set_at: Date.now(),
    ci_remediation_attempted_sha: HEAD_SHA,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 0,
    session_initiated_close_at: null,
    reviewer_requested_at: null,
    flake_recovery_attempts: 0,
    ...overrides,
  };
}

function makePayload(
  overrides: Partial<VerifiedFlakyDispositionPayload> = {},
): VerifiedFlakyDispositionPayload {
  return {
    sessionId: 'coding-session',
    prNumber: PR_NUMBER,
    repo: REPO,
    headSha: HEAD_SHA,
    disposition: { gate: 'ci', reason: 'xdist/Postgres contention' },
    ...overrides,
  };
}

function makeMockGitHub(): GitHubClient {
  return {
    rerunFailedJobs: vi.fn().mockResolvedValue([]),
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
    sendOrResume: vi.fn().mockResolvedValue('session-id'),
  } as unknown as SessionManager;
}

function makeMockAutoMerger(): AutoMerger {
  return { attempt: vi.fn(), clearStalePauses: vi.fn() } as unknown as AutoMerger;
}

function makeMockReviewOrchestrator(): ReviewOrchestrator {
  return {
    rerunFlakyTests: vi.fn().mockResolvedValue({ passed: true, output: 'ok' }),
  } as unknown as ReviewOrchestrator;
}

function makeWatcher(github: GitHubClient) {
  const sessions = makeMockSessions();
  const watcher = new PRMergeWatcher(
    github,
    sessions,
    undefined,
    vi.fn(),
  ) as PRMergeWatcher & { handleVerifiedFlakyDisposition: any };
  const autoMerger = makeMockAutoMerger();
  const reviewOrchestrator = makeMockReviewOrchestrator();
  watcher.setAutoMerger(autoMerger);
  watcher.setReviewOrchestrator(reviewOrchestrator);
  return { watcher, autoMerger, reviewOrchestrator, sessions };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(typedGetSetting).mockReturnValue(2);
  vi.mocked(getProjectByGithubRepo).mockReturnValue({
    id: 'project-1',
    projectDir: '/repo',
    contextUrl: 'https://notion.so/project',
    githubRepo: REPO,
  } as any);
  vi.mocked(getSession).mockReturnValue({
    worktree_path: '/tmp/worktree',
  } as any);
});

// ── Same-SHA re-run actuation ────────────────────────────────────────────────

describe('PRMergeWatcher.handleVerifiedFlakyDisposition — same-SHA re-run actuation', () => {
  it('CI gate: triggers rerunFailedJobs on the same SHA (no new commit)', async () => {
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    const pr = makePRRow();
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(vi.mocked(github.rerunFailedJobs)).toHaveBeenCalledWith(
      HEAD_SHA,
      REPO,
    );
    expect(vi.mocked(incrementFlakeRecoveryAttempts)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
    );
  });

  it('F2 gate: delegates to ReviewOrchestrator.rerunFlakyTests for an audited invalidation + re-run on the same SHA', async () => {
    const github = makeMockGitHub();
    const { watcher, reviewOrchestrator } = makeWatcher(github);
    const pr = makePRRow();
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(
      makePayload({ disposition: { gate: 'f2', reason: 'contention' } }),
    );

    expect(vi.mocked(reviewOrchestrator.rerunFlakyTests)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      HEAD_SHA, // same SHA — no new commit
      '/tmp/worktree',
      expect.objectContaining({ id: 'project-1' }),
    );
    expect(vi.mocked(github.rerunFailedJobs)).not.toHaveBeenCalled();
  });

  it('ignores a stale disposition whose headSha no longer matches the PR head (a new push landed)', async () => {
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    const pr = makePRRow({ head_sha: 'sha-new-push' });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(vi.mocked(github.rerunFailedJobs)).not.toHaveBeenCalled();
    expect(vi.mocked(incrementFlakeRecoveryAttempts)).not.toHaveBeenCalled();
  });

  it('no-ops when the PR is not currently paused as ci_failing', async () => {
    const github = makeMockGitHub();
    const { watcher } = makeWatcher(github);
    const pr = makePRRow({ pause_reason: null });
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(vi.mocked(github.rerunFailedJobs)).not.toHaveBeenCalled();
  });
});

// ── Re-drive on pass ──────────────────────────────────────────────────────────

describe('PRMergeWatcher.handleVerifiedFlakyDisposition — re-drive on pass', () => {
  it('clears the ci_failing pause and re-drives the merge loop for a not-yet-approved PR', async () => {
    const github = makeMockGitHub(); // categorizeMergeability → clean
    const { watcher, autoMerger } = makeWatcher(github);
    const pr = makePRRow({ review_result: null }); // not-yet-approved (no verdict at all)
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
    expect(vi.mocked(resetFlakeRecoveryAttempts)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
    );
    // checkMergeabilityNow re-checks mergeability regardless of approval —
    // evidenced by updateMergeState firing off the categorizeMergeability result.
    expect(vi.mocked(updateMergeState)).toHaveBeenCalled();
    expect(vi.mocked(autoMerger.attempt)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
    );
  });

  it('does not clear the pause when the re-run still fails', async () => {
    const github = makeMockGitHub();
    vi.mocked(github.categorizeMergeability).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'build', conclusion: 'failure' }],
      headSha: HEAD_SHA,
    } as any);
    const { watcher, autoMerger } = makeWatcher(github);
    const pr = makePRRow();
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(vi.mocked(setPauseReason)).not.toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      null,
    );
    expect(vi.mocked(autoMerger.attempt)).not.toHaveBeenCalled();
  });
});

// ── Retry cap ─────────────────────────────────────────────────────────────────

describe('PRMergeWatcher.handleVerifiedFlakyDisposition — retry cap', () => {
  it('stays paused with a flake-recovery-exhausted detail after the retry cap is reached', async () => {
    vi.mocked(typedGetSetting).mockReturnValue(2); // cap = 2

    const github = makeMockGitHub();
    vi.mocked(github.categorizeMergeability).mockResolvedValue({
      category: 'ci_failed',
      mergeState: 'ci_failed',
      rawMergeableState: 'unstable',
      failingChecks: [{ name: 'build', conclusion: 'failure' }],
      headSha: HEAD_SHA,
    } as any);
    const { watcher } = makeWatcher(github);

    // Mutable PR row shared across calls — incrementFlakeRecoveryAttempts
    // mutates it in place to simulate DB persistence across dispositions.
    const pr = makePRRow({ flake_recovery_attempts: 0 });
    vi.mocked(getPRByNumber).mockImplementation(() => pr);
    vi.mocked(incrementFlakeRecoveryAttempts).mockImplementation(() => {
      pr.flake_recovery_attempts += 1;
    });

    // Attempt 1: 0 < 2 → increments to 1, re-run fails.
    await watcher.handleVerifiedFlakyDisposition(makePayload());
    // Attempt 2: 1 < 2 → increments to 2, re-run fails.
    await watcher.handleVerifiedFlakyDisposition(makePayload());
    // Attempt 3: 2 >= 2 → cap reached, no further re-run.
    await watcher.handleVerifiedFlakyDisposition(makePayload());

    expect(vi.mocked(github.rerunFailedJobs)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(setPauseReason)).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'ci_failing',
      'flake-recovery-exhausted',
    );
  });
});
