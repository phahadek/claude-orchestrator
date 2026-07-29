import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  AUTO_REVIEW_ENABLED: true,
}));
vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn().mockReturnValue(5),
}));
vi.mock('../../session/orchestrator-config', () => ({
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
  setHeadBranch: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getTestResult: vi.fn().mockReturnValue(null),
  markSessionDone: vi.fn(),
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
  clearSessionInitiatedPRClose: vi.fn(),
  updateSessionStatus: vi.fn(),
  recordMergeCommitForSession: vi.fn(),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../reviewUtils', () => ({
  formatCIFailureFeedback: vi.fn(),
  shouldAutoReview: vi.fn().mockReturnValue(true),
  formatReviewFeedback: vi.fn().mockReturnValue('feedback'),
  truncateLog: vi.fn((s: string) => s),
  CI_LOG_EXCERPT_CAP: 4000,
}));
vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));
vi.mock('../pollUtils', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
// parsePauseReason from ../../db/pauseReason is intentionally left unmocked —
// the sweep's filtering logic depends on it correctly recognizing the
// 'stalled_reconcile_cap' reason from the raw JSON stored on pause_reason.

import { PRMergeWatcher } from '../PRMergeWatcher';
import {
  getAllOpenPRs,
  getPRByNumber,
  updatePRState,
  clearTerminalPRFlags,
  markSessionDone,
} from '../../db/queries';
import { getProjectByGithubRepo } from '../../config';
import type { GitHubClient } from '../GitHubClient';
import type { SessionManager } from '../../session/SessionManager';
import type { PullRequestRow } from '../../db/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 887;
const REPO = 'owner/repo';

function escalatedPauseReason(): string {
  return JSON.stringify({
    reason: 'stalled_reconcile_cap',
    source: 'review',
    severity: 'needs_attention',
    retry_strategy: 'manual_action',
  });
}

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'notion:task-abc',
    session_id: null,
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
    head_sha: 'old-sha',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: escalatedPauseReason(),
    pause_reason_set_at: Date.now(),
    ci_remediation_attempted_sha: null,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    stalled_pr_retry_count: 5,
    session_initiated_close_at: null,
    ...overrides,
  };
}

function makeGithubClient(
  overrides: Partial<Record<string, unknown>> = {},
): GitHubClient {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    listOpenPRs: vi.fn(),
    getMergeCommitSha: vi.fn().mockResolvedValue('merge-sha'),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as GitHubClient;
}

function makeSessionManager(): SessionManager {
  return {
    on: vi.fn(),
    endSession: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue('review-session-id'),
    markSessionErrored: vi.fn(),
    markForBranchDeletion: vi.fn(),
  } as unknown as SessionManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectByGithubRepo).mockReturnValue({
    id: 'project-abc',
    projectDir: '/repo',
    contextUrl: 'https://notion.so/project-abc',
    baseBranch: 'dev',
    githubRepo: REPO,
  } as never);
});

describe('PRMergeWatcher — escalated stale-open sweep', () => {
  it('transitions an escalated row reported merged, and clears its pause reason via the merged trigger', async () => {
    // task_id is null here: handleMerged's Notion-task-status update path is
    // exercised by existing PRMergeWatcher merge tests — irrelevant to what
    // this test verifies (the sweep's terminal-transition + flag-clearing).
    const pr = makePRRow({ task_id: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'merged', headSha: null }),
    });
    const watcher = new PRMergeWatcher(
      github,
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    await watcher.sweepEscalatedStalePRs();

    expect(github.getPRState).toHaveBeenCalledTimes(1);
    expect(github.getPRState).toHaveBeenCalledWith(PR_NUMBER, REPO);
    expect(updatePRState).toHaveBeenCalledWith(PR_NUMBER, REPO, 'merged');
    expect(clearTerminalPRFlags).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'merged',
    );
    expect(markSessionDone).not.toHaveBeenCalled(); // no session_id on this row
    expect(github.listOpenPRs).not.toHaveBeenCalled();
  });

  it('returns a numeric processed count, non-zero when it reconciles a row', async () => {
    const pr = makePRRow({ task_id: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getPRByNumber).mockReturnValue(pr);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'merged', headSha: null }),
    });
    const watcher = new PRMergeWatcher(
      github,
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    const processed = await watcher.sweepEscalatedStalePRs();

    expect(typeof processed).toBe('number');
    expect(processed).toBe(1);
  });

  it('returns zero rather than undefined/null when there is nothing to reconcile', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([]);

    const github = makeGithubClient();
    const watcher = new PRMergeWatcher(
      github,
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    const processed = await watcher.sweepEscalatedStalePRs();

    expect(processed).toBe(0);
  });

  it('transitions an escalated row reported closed, and clears its pause reason via the closed trigger', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'closed', headSha: null }),
    });
    const watcher = new PRMergeWatcher(
      github,
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    await watcher.sweepEscalatedStalePRs();

    expect(updatePRState).toHaveBeenCalledWith(PR_NUMBER, REPO, 'closed');
    expect(clearTerminalPRFlags).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'closed',
    );
  });

  it('leaves an escalated row still open on GitHub untouched (the #887 case)', async () => {
    const pr = makePRRow();
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    });
    const watcher = new PRMergeWatcher(
      github,
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    await watcher.sweepEscalatedStalePRs();

    expect(github.getPRState).toHaveBeenCalledTimes(1);
    expect(updatePRState).not.toHaveBeenCalled();
    expect(clearTerminalPRFlags).not.toHaveBeenCalled();
  });

  it('enumerates only state=open + stalled_reconcile_cap rows, calling getPRState once per row, never listOpenPRs', async () => {
    const escalated1 = makePRRow({ pr_number: 100 });
    const escalated2 = makePRRow({ pr_number: 200 });
    const nonEscalatedPaused = makePRRow({
      pr_number: 300,
      pause_reason: JSON.stringify({
        reason: 'merge_conflict',
        source: 'merge',
        severity: 'needs_attention',
        retry_strategy: 'manual_action',
      }),
    });
    const notPaused = makePRRow({ pr_number: 400, pause_reason: null });
    vi.mocked(getAllOpenPRs).mockReturnValue([
      escalated1,
      escalated2,
      nonEscalatedPaused,
      notPaused,
    ]);

    const github = makeGithubClient({
      getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    });
    const watcher = new PRMergeWatcher(
      github,
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    await watcher.sweepEscalatedStalePRs();

    expect(github.getPRState).toHaveBeenCalledTimes(2);
    expect(github.getPRState).toHaveBeenCalledWith(100, REPO);
    expect(github.getPRState).toHaveBeenCalledWith(200, REPO);
    expect(github.listOpenPRs).not.toHaveBeenCalled();
  });

  it('logs a GitHub error during the sweep and leaves existing rows unchanged (no silent swallow, no partial corruption)', async () => {
    const failing = makePRRow({ pr_number: 500 });
    const okay = makePRRow({ pr_number: 600 });
    vi.mocked(getAllOpenPRs).mockReturnValue([failing, okay]);

    const github = makeGithubClient({
      getPRState: vi
        .fn()
        .mockRejectedValueOnce(new Error('GitHub API error'))
        .mockResolvedValueOnce({ state: 'closed', headSha: null }),
    });
    const watcher = new PRMergeWatcher(
      github,
      makeSessionManager(),
      undefined,
      vi.fn(),
    );

    await expect(watcher.sweepEscalatedStalePRs()).resolves.toBe(2);

    // The failing row was never transitioned...
    expect(updatePRState).not.toHaveBeenCalledWith(500, REPO, 'closed');
    expect(updatePRState).not.toHaveBeenCalledWith(500, REPO, 'merged');
    // ...but the sweep continued on to the next row.
    expect(updatePRState).toHaveBeenCalledWith(600, REPO, 'closed');
    expect(clearTerminalPRFlags).toHaveBeenCalledWith(600, REPO, 'closed');
  });
});
