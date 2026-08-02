import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () =>
  mockDbQueries({
    getAllOpenPRs: vi.fn(),
    getApprovedOpenPRs: vi.fn(),
    getApprovedLocalBranches: vi.fn().mockReturnValue([]),
    getOrphanMergeablePRs: vi.fn().mockReturnValue([]),
    getStaleAutoMergeFailedPRs: vi.fn().mockReturnValue([]),
    getRoutedCommentIds: vi.fn().mockReturnValue(new Set()),
    markCommentsRouted: vi.fn(),
    setPauseReason: vi.fn(),
    getSession: vi.fn(),
    getSetting: vi.fn().mockReturnValue(undefined),
    getPRByNumber: vi.fn(),
    setHeadSha: vi.fn(),
    updatePRState: vi.fn(),
    deleteAllAutofixShasForPR: vi.fn(),
    clearTerminalPRFlags: vi.fn(),
    markSessionDone: vi.fn(),
    setCiRemediationAttemptedSha: vi.fn(),
    updateMergeState: vi.fn(),
    emitTaskUpdated: vi.fn(),
  }),
);

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi
    .fn()
    .mockReturnValue({ updateStatus: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn(),
  AUTO_REVIEW_ENABLED: false,
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ ci_check_name: [], test: [] }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ ci_check_name: [], test: [] }),
}));

import {
  getAllOpenPRs,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
  getRoutedCommentIds,
} from '../db/queries.js';
import { getProjectByGithubRepo } from '../config.js';
import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import { ReviewerCommentsWatcher } from '../github/ReviewerCommentsWatcher.js';
import { AutoMerger } from '../github/AutoMerger.js';
import { isTerminalStalePR, classifyStalledPR } from '../github/pollUtils.js';
import type { PullRequestRow } from '../db/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePR(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'task-1',
    session_id: 'session-abc',
    repo: 'owner/repo',
    title: 'Test PR',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: JSON.stringify({ verdict: 'approved' }),
    review_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    synced_at: '2026-01-01T00:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ci_remediation_attempted_sha: null,
    ...overrides,
  };
}

function makeGitHubClient(overrides: Record<string, unknown> = {}) {
  return {
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: 'abc123' }),
    listOpenPRStates: vi.fn().mockResolvedValue(new Map()),
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
      headSha: 'abc123',
    }),
    listPRReviews: vi.fn().mockResolvedValue([]),
    listPRReviewComments: vi.fn().mockResolvedValue([]),
    listPRIssueComments: vi.fn().mockResolvedValue([]),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSessionManager() {
  return {
    send: vi.fn(),
    sendOrResume: vi.fn(),
    endSession: vi.fn(),
    markForBranchDeletion: vi.fn(),
    on: vi.fn(),
  };
}

function makeProject() {
  return { id: 'proj-1', projectDir: '/tmp/proj', autoMergeEnabled: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApprovedLocalBranches).mockReturnValue([]);
  vi.mocked(getRoutedCommentIds).mockReturnValue(new Set());
  vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);
});

// ── PRMergeWatcher: orphan repo skip ─────────────────────────────────────────

describe('PRMergeWatcher orphan repo skip', () => {
  it('skips PRs whose repo has no project mapping', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR({ repo: 'orphan/repo' })]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(null);

    const github = makeGitHubClient();
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.getPRState).not.toHaveBeenCalled();
    expect(github.listOpenPRStates).not.toHaveBeenCalled();
  });

  it('does not skip PRs with a valid project mapping', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient({
      getPRState: vi
        .fn()
        .mockResolvedValue({ state: 'open', headSha: 'abc123' }),
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.getPRState).toHaveBeenCalledOnce();
  });
});

// ── PRMergeWatcher: terminal pause reason skip for mergeability ───────────────

describe('PRMergeWatcher terminal pause reason skip', () => {
  const terminalReasons = [
    'auto_merge_failed',
    'max_reviews',
    'review_failed',
    'pr_body_invalid',
    'attribution_missing',
    'merge_conflict',
  ] as const;

  for (const pauseReason of terminalReasons) {
    it(`still refreshes observability (categorizeMergeability) but skips remediation when pause_reason=${pauseReason}`, async () => {
      // Terminal-paused PRs still get merge_state/failing_checks refreshed for
      // the UI (see runMergeabilityCheck's "observability columns" comment) —
      // only the remediation side effects (autofix, conflict nudges, pause
      // clearing) are skipped, since polling can't change a terminal outcome.
      const pr = makePR({ pause_reason: pauseReason });
      vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
      vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

      const github = makeGitHubClient({
        getPRState: vi
          .fn()
          .mockResolvedValue({ state: 'open', headSha: 'abc123' }),
      });
      const sessions = makeSessionManager();
      const watcher = new PRMergeWatcher(
        github as never,
        sessions as never,
        undefined,
        vi.fn(),
      );

      await watcher.poll();

      expect(github.categorizeMergeability).toHaveBeenCalledOnce();
    });
  }

  it('does not skip categorizeMergeability for ci_failing (can self-recover)', async () => {
    const pr = makePR({ pause_reason: 'ci_failing' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient({
      getPRState: vi
        .fn()
        .mockResolvedValue({ state: 'open', headSha: 'abc123' }),
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.categorizeMergeability).toHaveBeenCalledOnce();
  });
});

// ── PRMergeWatcher: batch fetch path ─────────────────────────────────────────

describe('PRMergeWatcher batch fetch', () => {
  it('uses listOpenPRStates (one call) instead of N getPRState calls for repos with 2+ PRs', async () => {
    const pr1 = makePR({ pr_number: 10, head_sha: 'sha10' });
    const pr2 = makePR({ pr_number: 11, head_sha: 'sha11' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1, pr2]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const batchMap = new Map([
      [10, { headSha: 'sha10' }],
      [11, { headSha: 'sha11' }],
    ]);
    const github = makeGitHubClient({
      listOpenPRStates: vi.fn().mockResolvedValue(batchMap),
      getPRState: vi.fn(),
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.listOpenPRStates).toHaveBeenCalledOnce();
    expect(github.listOpenPRStates).toHaveBeenCalledWith('owner/repo');
    // getPRState not called for PRs present in the batch
    expect(github.getPRState).not.toHaveBeenCalled();
  });

  it('calls getPRState individually for a PR absent from the batch (closed/merged)', async () => {
    const pr1 = makePR({ pr_number: 10, head_sha: 'sha10' });
    const pr2 = makePR({ pr_number: 11, head_sha: 'sha11' });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1, pr2]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    // pr2 (11) is absent from the batch → was merged
    const batchMap = new Map([[10, { headSha: 'sha10' }]]);
    const github = makeGitHubClient({
      listOpenPRStates: vi.fn().mockResolvedValue(batchMap),
      getPRState: vi
        .fn()
        .mockResolvedValue({ state: 'merged', headSha: 'sha11' }),
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.listOpenPRStates).toHaveBeenCalledOnce();
    // Only pr2 falls back to individual getPRState
    expect(github.getPRState).toHaveBeenCalledTimes(1);
    expect(github.getPRState).toHaveBeenCalledWith(11, 'owner/repo');
  });

  it('uses individual getPRState for repos with a single PR (no batch savings)', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient({
      getPRState: vi
        .fn()
        .mockResolvedValue({ state: 'open', headSha: 'abc123' }),
      listOpenPRStates: vi.fn(),
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.listOpenPRStates).not.toHaveBeenCalled();
    expect(github.getPRState).toHaveBeenCalledOnce();
  });

  it('falls back to individual getPRState when listOpenPRStates throws', async () => {
    const pr1 = makePR({ pr_number: 10 });
    const pr2 = makePR({ pr_number: 11 });
    vi.mocked(getAllOpenPRs).mockReturnValue([pr1, pr2]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient({
      listOpenPRStates: vi.fn().mockRejectedValue(new Error('network error')),
      getPRState: vi
        .fn()
        .mockResolvedValue({ state: 'open', headSha: 'abc123' }),
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    // Falls back to individual calls for both PRs
    expect(github.getPRState).toHaveBeenCalledTimes(2);
  });
});

// ── ReviewerCommentsWatcher: orphan repo skip ─────────────────────────────────

describe('ReviewerCommentsWatcher orphan repo skip', () => {
  it('skips PRs whose repo has no project mapping', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([
      makePR({ repo: 'orphan/repo', session_id: 'session-x' }),
    ]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(null);

    const github = makeGitHubClient();
    const sessions = makeSessionManager();
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      sessions as never,
    );

    await watcher.pollAll();

    expect(github.listPRReviews).not.toHaveBeenCalled();
    expect(github.listPRReviewComments).not.toHaveBeenCalled();
    expect(github.listPRIssueComments).not.toHaveBeenCalled();
  });

  it('polls PRs with a valid project mapping', async () => {
    vi.mocked(getAllOpenPRs).mockReturnValue([makePR()]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient();
    const sessions = makeSessionManager();
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      sessions as never,
    );

    await watcher.pollAll();

    expect(github.listPRReviews).toHaveBeenCalledOnce();
  });
});

// ── AutoMerger: paused PR skip in pollOnce ────────────────────────────────────

describe('AutoMerger pollOnce paused PR skip', () => {
  it('does not call attempt() for PRs with a non-null pause_reason', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([
      makePR({ pr_number: 10, pause_reason: 'auto_merge_failed' }),
      makePR({ pr_number: 11, pause_reason: 'awaiting_human_approval' }),
    ] as never);

    const github = makeGitHubClient();
    const mergeWatcher = { checkMergeabilityNow: vi.fn() };
    const merger = new AutoMerger(
      github as never,
      mergeWatcher as never,
      vi.fn(),
    );
    const attemptSpy = vi.spyOn(merger, 'attempt');

    await merger.pollOnce();

    expect(attemptSpy).not.toHaveBeenCalled();
  });

  it('calls attempt() for PRs with pause_reason=null', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([
      makePR({ pr_number: 20, pause_reason: null }),
    ] as never);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient();
    const mergeWatcher = { checkMergeabilityNow: vi.fn() };
    const merger = new AutoMerger(
      github as never,
      mergeWatcher as never,
      vi.fn(),
    );
    const attemptSpy = vi
      .spyOn(merger, 'attempt')
      .mockImplementation(() => undefined);

    await merger.pollOnce();

    expect(attemptSpy).toHaveBeenCalledWith(20, 'owner/repo');
  });
});

// ── isTerminalStalePR unit tests ─────────────────────────────────────────────

describe('isTerminalStalePR predicate', () => {
  it('returns true when verdict=incomplete and head_sha matches last_reviewed_sha', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    expect(isTerminalStalePR(pr)).toBe(true);
  });

  it('returns false when verdict=incomplete but head_sha differs (new push arrived)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
    });
    expect(isTerminalStalePR(pr)).toBe(false);
  });

  it('returns false when verdict=approved (not an incomplete review)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    expect(isTerminalStalePR(pr)).toBe(false);
  });

  it('returns false when verdict=needs_changes (session is actively working on a fix)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    expect(isTerminalStalePR(pr)).toBe(false);
  });

  it('returns false when review_result is null (no review yet)', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    expect(isTerminalStalePR(pr)).toBe(false);
  });

  it('returns false when head_sha is null', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: null,
      last_reviewed_sha: null,
    });
    expect(isTerminalStalePR(pr)).toBe(false);
  });

  it('returns false when last_reviewed_sha is null (review incomplete before SHA was recorded)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: null,
    });
    expect(isTerminalStalePR(pr)).toBe(false);
  });
});

// ── PRMergeWatcher: terminal-stale skip ──────────────────────────────────────

describe('PRMergeWatcher terminal-stale skip', () => {
  it('skips a PR with verdict=incomplete and no new push', async () => {
    const stalePR = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([stalePR]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient();
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.getPRState).not.toHaveBeenCalled();
    expect(github.listOpenPRStates).not.toHaveBeenCalled();
  });

  it('does NOT skip a PR with verdict=incomplete when a new push arrived', async () => {
    const activePR = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([activePR]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient({
      getPRState: vi
        .fn()
        .mockResolvedValue({ state: 'open', headSha: 'sha-new' }),
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    expect(github.getPRState).toHaveBeenCalledOnce();
  });
});

// ── ReviewerCommentsWatcher: terminal-stale skip ─────────────────────────────

describe('ReviewerCommentsWatcher terminal-stale skip', () => {
  // The "skips a PR with verdict=incomplete and no new push" case was removed:
  // ReviewerCommentsWatcher.pollAll's `watchable` filter now only gates on
  // pause_reason severity ('terminal') and project resolution, not on a
  // stale-incomplete-verdict check — that skip no longer exists.

  it('does NOT skip a PR with verdict=incomplete when a new push arrived', async () => {
    const activePR = makePR({
      review_result: JSON.stringify({ verdict: 'incomplete' }),
      head_sha: 'sha-new',
      last_reviewed_sha: 'sha-old',
    });
    vi.mocked(getAllOpenPRs).mockReturnValue([activePR]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

    const github = makeGitHubClient();
    const sessions = makeSessionManager();
    const watcher = new ReviewerCommentsWatcher(
      github as never,
      sessions as never,
    );

    await watcher.pollAll();

    expect(github.listPRReviews).toHaveBeenCalledOnce();
  });
});

// ── classifyStalledPR: pre_review_interrupted ─────────────────────────────────

describe('classifyStalledPR pre_review_interrupted', () => {
  it('returns pre_review_interrupted for an open PR with head_sha, review_result=null, no session', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      review_session_id: null,
      pending_push: 0,
      pause_reason: null,
    });
    expect(classifyStalledPR(pr, null)).toEqual({
      kind: 'pre_review_interrupted',
    });
  });

  it('returns null for a PR with a live review session (no double-drive)', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      review_session_id: 'active-session',
      pending_push: 0,
      pause_reason: null,
    });
    // reviewSessionStatus = 'running' means a live session is consuming the PR
    expect(classifyStalledPR(pr, 'running')).toBeNull();
  });

  it('returns null when pending_push is set (normal push flow handles it)', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      review_session_id: null,
      pending_push: 1,
      pause_reason: null,
    });
    expect(classifyStalledPR(pr, null)).toBeNull();
  });

  it('returns null when head_sha is missing', () => {
    const pr = makePR({
      review_result: null,
      head_sha: null,
      review_session_id: null,
      pending_push: 0,
      pause_reason: null,
    });
    expect(classifyStalledPR(pr, null)).toBeNull();
  });

  it('still classifies errored_review_session when session status is error (not pre_review_interrupted)', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      review_session_id: 'dead-session',
      pending_push: 0,
      pause_reason: null,
    });
    // reviewSessionStatus = 'error' → truthy, so pre_review_interrupted guard skips;
    // errored_review_session fires instead
    expect(classifyStalledPR(pr, 'error')).toEqual({
      kind: 'errored_review_session',
    });
  });
});

// ── classifyStalledPR: conflict_dead_session ──────────────────────────────────

describe('classifyStalledPR conflict_dead_session', () => {
  it('returns conflict_dead_session when merge_state=dirty and the implementing session errored', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      merge_state: 'dirty',
    });
    expect(classifyStalledPR(pr, null, 'error')).toEqual({
      kind: 'conflict_dead_session',
    });
  });

  it('returns conflict_dead_session when merge_state=blocked and the implementing session was killed', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      merge_state: 'blocked',
    });
    expect(classifyStalledPR(pr, null, 'killed')).toEqual({
      kind: 'conflict_dead_session',
    });
  });

  it('returns conflict_dead_session when the implementing session is done', () => {
    const pr = makePR({
      review_result: null,
      head_sha: 'sha-abc',
      merge_state: 'dirty',
    });
    expect(classifyStalledPR(pr, null, 'done')).toEqual({
      kind: 'conflict_dead_session',
    });
  });

  it('returns null (not conflict_dead_session) when the implementing session is idle — live-session nudge path handles it', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-old',
      merge_state: 'dirty',
    });
    expect(classifyStalledPR(pr, null, 'idle')).toBeNull();
  });

  it('returns null when merge_state is clean, regardless of session status', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-old',
      merge_state: 'clean',
    });
    expect(classifyStalledPR(pr, null, 'error')).toBeNull();
  });

  it('takes priority over a gate-failed verdict when both are present', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'autofix_failed' }),
      head_sha: 'sha-abc',
      merge_state: 'dirty',
      pending_push: 0,
    });
    expect(classifyStalledPR(pr, null, 'error')).toEqual({
      kind: 'conflict_dead_session',
    });
  });
});

// ── classifyStalledPR: undelivered_review_feedback ────────────────────────────

describe('classifyStalledPR undelivered_review_feedback', () => {
  it('returns undelivered_review_feedback for needs_changes with undelivered inbox and idle implementing session', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    expect(classifyStalledPR(pr, null, 'idle', true)).toEqual({
      kind: 'undelivered_review_feedback',
    });
  });

  it('returns null when the inbox feedback was already delivered', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    expect(classifyStalledPR(pr, null, 'idle', false)).toBeNull();
  });

  it('returns null when the implementing session is live mid-turn (delivered live by the wake-aware path)', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      head_sha: 'sha-abc',
      last_reviewed_sha: 'sha-abc',
    });
    expect(classifyStalledPR(pr, null, 'running', true)).toBeNull();
  });
});

// ── classifyStalledPR: approved + unmergeable ─────────────────────────────────

describe('classifyStalledPR approved + unmergeable', () => {
  for (const mergeState of ['unknown', 'dirty', 'blocked'] as const) {
    for (const sessionStatus of ['done', 'error', 'killed', 'idle'] as const) {
      it(`returns conflict_dead_session for approved+mergeable=0+merge_state=${mergeState} with a ${sessionStatus} implementing session`, () => {
        const pr = makePR({
          review_result: JSON.stringify({ verdict: 'approved' }),
          head_sha: 'sha-abc',
          mergeable: 0,
          merge_state: mergeState,
        });
        expect(classifyStalledPR(pr, null, sessionStatus)).toEqual({
          kind: 'conflict_dead_session',
        });
      });
    }
  }

  it('returns null for approved+mergeable=0+merge_state=unknown when the implementing session is live', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
      head_sha: 'sha-abc',
      mergeable: 0,
      merge_state: 'unknown',
    });
    expect(classifyStalledPR(pr, null, 'running')).toBeNull();
  });

  it('returns null when mergeable is not 0', () => {
    const pr = makePR({
      review_result: JSON.stringify({ verdict: 'approved' }),
      head_sha: 'sha-abc',
      mergeable: 1,
      merge_state: 'unknown',
    });
    expect(classifyStalledPR(pr, null, 'idle')).toBeNull();
  });
});

// ── Integration: 20 PRs, 5 paused/stale → only active PRs trigger API calls ──

describe('integration: only non-skipped PRs trigger API calls in one cycle', () => {
  it('with 20 PRs (5 paused/stale/orphan), only the 15 active ones trigger GitHub calls', async () => {
    const activePRs = Array.from({ length: 15 }, (_, i) =>
      makePR({
        pr_number: 100 + i,
        repo: 'active/repo',
        session_id: `session-${i}`,
        pause_reason: null,
        review_result: JSON.stringify({ verdict: 'approved' }),
      }),
    );

    const pausedPRs = [
      makePR({
        pr_number: 200,
        repo: 'active/repo',
        pause_reason: 'auto_merge_failed',
      }),
      makePR({
        pr_number: 201,
        repo: 'active/repo',
        pause_reason: 'max_reviews',
      }),
      // Terminal-stale: verdict=incomplete, no new push
      makePR({
        pr_number: 202,
        repo: 'active/repo',
        pause_reason: null,
        review_result: JSON.stringify({ verdict: 'incomplete' }),
        head_sha: 'stale-sha',
        last_reviewed_sha: 'stale-sha',
      }),
      // Orphan repos (no project mapping)
      makePR({ pr_number: 203, repo: 'orphan/repo-1', pause_reason: null }),
      makePR({ pr_number: 204, repo: 'orphan/repo-2', pause_reason: null }),
    ];

    vi.mocked(getAllOpenPRs).mockReturnValue([...activePRs, ...pausedPRs]);
    vi.mocked(getProjectByGithubRepo).mockImplementation((repo: string) => {
      if (repo === 'orphan/repo-1' || repo === 'orphan/repo-2') return null;
      return makeProject() as never;
    });

    // Build batch map for active PRs (all still open with same headSha).
    // Paused PRs on active/repo (200, 201) are still in byRepo and get a batch
    // entry; the stale PR (202) is excluded from byRepo before batch fetch.
    const batchMap = new Map(
      activePRs.map((pr) => [pr.pr_number, { headSha: pr.head_sha }]),
    );
    // Include the two paused PRs (not the stale one — it's excluded before batching)
    batchMap.set(200, { headSha: 'abc123' });
    batchMap.set(201, { headSha: 'abc123' });

    const getPRState = vi
      .fn()
      .mockResolvedValue({ state: 'open', headSha: 'abc' });
    const listOpenPRStates = vi.fn().mockResolvedValue(batchMap);
    const categorizeMergeability = vi.fn().mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
      headSha: 'abc123',
    });

    const github = makeGitHubClient({
      getPRState,
      listOpenPRStates,
      categorizeMergeability,
    });
    const sessions = makeSessionManager();
    const watcher = new PRMergeWatcher(
      github as never,
      sessions as never,
      undefined,
      vi.fn(),
    );

    await watcher.poll();

    // One batch call for 'active/repo' (15 active + 2 paused; stale/orphan excluded before grouping)
    expect(listOpenPRStates).toHaveBeenCalledOnce();
    expect(listOpenPRStates).toHaveBeenCalledWith('active/repo');

    // Orphan and terminal-stale repos never trigger any individual GitHub calls
    expect(getPRState).not.toHaveBeenCalled();

    // The 15 active PRs plus the 2 terminally-paused ones (200, 201) all
    // trigger a mergeability check — terminal pause reasons still refresh
    // observability columns, only remediation side effects are skipped (see
    // runMergeabilityCheck's "observability columns" comment). Only the
    // stale-incomplete-verdict PR (202, never approved) and the 2 orphan-repo
    // PRs (203, 204, no project mapping) are excluded.
    expect(categorizeMergeability).toHaveBeenCalledTimes(17);
  });
});
