import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getAllOpenPRs: vi.fn(),
  getApprovedOpenPRs: vi.fn(),
  getApprovedLocalBranches: vi.fn().mockReturnValue([]),
  getRoutedCommentIds: vi.fn().mockReturnValue(new Set()),
  markCommentsRouted: vi.fn(),
  setPauseReason: vi.fn(),
  getSession: vi.fn(),
  getSetting: vi.fn().mockReturnValue(undefined),
  getPRByNumber: vi.fn(),
  setHeadSha: vi.fn(),
  updatePRState: vi.fn(),
  deleteAllAutofixShasForPR: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  updateMergeState: vi.fn(),
  emitTaskUpdated: vi.fn(),
}));

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
  loadOrchestratorConfig: vi.fn().mockReturnValue({ ci_check_name: [] }),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({ ci_check_name: [] }),
}));

import {
  getAllOpenPRs,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
  getRoutedCommentIds,
  markCommentsRouted,
} from '../db/queries.js';
import { getProjectByGithubRepo } from '../config.js';
import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import { ReviewerCommentsWatcher } from '../github/ReviewerCommentsWatcher.js';
import { AutoMerger } from '../github/AutoMerger.js';
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
    it(`skips categorizeMergeability when pause_reason=${pauseReason}`, async () => {
      const pr = makePR({ pause_reason: pauseReason });
      vi.mocked(getAllOpenPRs).mockReturnValue([pr]);
      vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject() as never);

      const github = makeGitHubClient({
        getPRState: vi
          .fn()
          .mockResolvedValue({ state: 'open', headSha: 'abc123' }),
        categorizeMergeability: vi.fn(),
      });
      const sessions = makeSessionManager();
      const watcher = new PRMergeWatcher(
        github as never,
        sessions as never,
        undefined,
        vi.fn(),
      );

      await watcher.poll();

      expect(github.categorizeMergeability).not.toHaveBeenCalled();
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

// ── Integration: 20 PRs, 5 paused/stale → only active PRs trigger API calls ──

describe('integration: only non-skipped PRs trigger API calls in one cycle', () => {
  it('with 20 PRs (5 paused/orphan), only the 15 active ones trigger GitHub calls', async () => {
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
      makePR({
        pr_number: 202,
        repo: 'active/repo',
        pause_reason: 'review_failed',
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

    // Build batch map for active PRs (all still open with same headSha)
    const batchMap = new Map(
      activePRs.map((pr) => [pr.pr_number, { headSha: pr.head_sha }]),
    );
    // Also include paused PRs in the batch (they're still open on GitHub)
    for (const pr of pausedPRs.filter((p) => p.repo === 'active/repo')) {
      batchMap.set(pr.pr_number, { headSha: pr.head_sha });
    }

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

    // One batch call for 'active/repo' (has 18 PRs: 15 active + 3 paused)
    expect(listOpenPRStates).toHaveBeenCalledOnce();
    expect(listOpenPRStates).toHaveBeenCalledWith('active/repo');

    // Orphan repos never trigger any GitHub calls
    expect(getPRState).not.toHaveBeenCalled();

    // Only active PRs (pause_reason=null) trigger mergeability checks
    // Paused PRs are found in batch but skipped by terminal pause filter
    expect(categorizeMergeability).toHaveBeenCalledTimes(15);
  });
});
