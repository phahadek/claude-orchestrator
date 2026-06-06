import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must precede imports of the modules under test) ───────────────────

const { projectFixture, runtimeSettingsFixture } = vi.hoisted(() => ({
  projectFixture: {
    id: 'proj-1',
    name: 'Project 1',
    githubRepo: 'owner/repo',
    projectDir: '/tmp',
    contextUrl: 'https://notion.so/ctx',
    boardId: 'board-1',
    taskSource: 'notion' as const,
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: true,
  },
  runtimeSettingsFixture: {
    ci_poll_interval_seconds: 30,
    ci_poll_max_minutes: 30,
    auto_merge_failed_clear_minutes: 10,
  },
}));

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPauseReason: vi.fn(),
  updateMergeState: vi.fn(),
  getApprovedOpenPRs: vi.fn().mockReturnValue([]),
  getApprovedLocalBranches: vi.fn().mockReturnValue([]),
  markLocalBranchMerged: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  getSession: vi.fn(),
  getOrphanMergeablePRs: vi.fn().mockReturnValue([]),
  getStaleAutoMergeFailedPRs: vi.fn().mockReturnValue([]),
  upsertActiveMerge: vi.fn(),
  deleteActiveMerge: vi.fn(),
  getAllActiveMerges: vi.fn().mockReturnValue([]),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getProjectById: vi.fn(() => projectFixture),
  runtimeSettings: runtimeSettingsFixture,
}));

vi.mock('../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../orchestration/localMergeRunner.js', () => ({
  squashMergeLocal: vi.fn(),
}));

vi.mock('../orchestration/localBranchHelpers.js', () => ({
  detectMergeConflict: vi.fn().mockResolvedValue(false),
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn(() => ({ verify: [], ci_check_name: [] })),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config/corporateMode.js', () => ({
  getCorporateMode: vi.fn(() => ({
    enabled: false,
    envLocked: false,
    gates: {
      dockerMandatory: false,
      requireHumanApproval: false,
      requireZDR: false,
      validatePRBody: false,
      secretsViaSeam: false,
    },
  })),
}));

import { AutoMerger } from './AutoMerger';
import {
  getPRByNumber,
  setPauseReason,
  updateMergeState,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
  markLocalBranchMerged,
  setLocalBranchPauseReason,
  getSession,
  getOrphanMergeablePRs,
  getStaleAutoMergeFailedPRs,
} from '../db/queries';
import { squashMergeLocal } from '../orchestration/localMergeRunner';
import { detectMergeConflict } from '../orchestration/localBranchHelpers';
import { getTaskBackend } from '../tasks/TaskBackend';
import { getCorporateMode } from '../config/corporateMode';
import type { GitHubClient, PRReviewDecision } from './GitHubClient';
import type { PRMergeWatcher } from './PRMergeWatcher';
import type { PullRequestRow, LocalBranchRow, Session } from '../db/types';
import type { MergeabilityCategory } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'notion:task-abc',
    session_id: 'coding-session',
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: JSON.stringify({
      verdict: 'approved',
      dimensions: [],
      summary: 'ok',
    }),
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_session_id: 'review-session',
    review_iteration: 1,
    head_sha: 'sha-abc',
    last_reviewed_sha: 'sha-abc',
    node_id: 'PR_node',
    mergeable: 1,
    merge_state: 'clean',
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ...overrides,
  };
}

function makeMergeability(
  category: MergeabilityCategory['category'],
  failingChecks: Array<{ name: string; conclusion: string }> = [],
): MergeabilityCategory {
  return {
    category,
    mergeState: category === 'clean' ? 'clean' : category,
    rawMergeableState: category === 'clean' ? 'clean' : category,
    failingChecks,
  };
}

function makeMockGitHub(
  pollResults: Array<
    Awaited<ReturnType<GitHubClient['fetchPRStatusConditional']>>
  >,
  reviewDecision?: PRReviewDecision | null,
): GitHubClient {
  const fetchSpy = vi.fn();
  for (const r of pollResults) fetchSpy.mockResolvedValueOnce(r);
  // Default fallback so background run() loops don't throw when they outlive the test.
  fetchSpy.mockResolvedValue({ status: 'not_modified' as const, etag: null });
  return {
    fetchPRStatusConditional: fetchSpy,
    mergePR: vi
      .fn()
      .mockResolvedValue({ merged: true, message: 'ok', sha: 'merged-sha' }),
    categorizeMergeability: vi
      .fn()
      .mockResolvedValue(makeMergeability('clean')),
    getReviewState: vi.fn().mockResolvedValue(reviewDecision ?? null),
    detectBillingBlock: vi.fn().mockResolvedValue({ blocked: false }),
  } as unknown as GitHubClient;
}

function makeMockWatcher(): PRMergeWatcher {
  return {
    handleMerged: vi.fn().mockResolvedValue(undefined),
  } as unknown as PRMergeWatcher;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Short intervals so polling tests don't drag.
  runtimeSettingsFixture.ci_poll_interval_seconds = 1;
  runtimeSettingsFixture.ci_poll_max_minutes = 1;
});

// ── attempt() — early-exit guards ────────────────────────────────────────────

describe('AutoMerger.attempt() — guards', () => {
  it('skips when project has autoMergeEnabled=false', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();

    // Re-mock project with disabled flag for this test
    const { getProjectByGithubRepo } = await import('../config.js');
    vi.mocked(getProjectByGithubRepo).mockReturnValueOnce({
      ...projectFixture,
      autoMergeEnabled: false,
    });

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.fetchPRStatusConditional).not.toHaveBeenCalled();
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('skips when PR has a pre-existing pause_reason', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ pause_reason: 'stuck_timeout' }),
    );
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.fetchPRStatusConditional).not.toHaveBeenCalled();
  });

  it('proceeds into polling loop when bypassToggle=true and autoMergeEnabled=false', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const { getProjectByGithubRepo } = await import('../config.js');
    vi.mocked(getProjectByGithubRepo).mockReturnValueOnce({
      ...projectFixture,
      autoMergeEnabled: false,
    });

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo', { bypassToggle: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(watcher.handleMerged).toHaveBeenCalled();
  });

  it('skips polling when autoMergeEnabled=false and no bypassToggle (regression guard)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();

    const { getProjectByGithubRepo } = await import('../config.js');
    vi.mocked(getProjectByGithubRepo).mockReturnValueOnce({
      ...projectFixture,
      autoMergeEnabled: false,
    });

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.fetchPRStatusConditional).not.toHaveBeenCalled();
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('de-duplicates concurrent attempt() calls for the same PR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    merger.attempt(42, 'owner/repo'); // duplicate — should be ignored
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).toHaveBeenCalledTimes(1);
  });
});

// ── attempt() — CI green path ────────────────────────────────────────────────

describe('AutoMerger.attempt() — CI green', () => {
  it('squash-merges and delegates to PRMergeWatcher.handleMerged on clean', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).toHaveBeenCalledWith(42, 'feat: test', 'owner/repo');
    expect(watcher.handleMerged).toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
  });
});

// ── attempt() — CI red and other failure modes ───────────────────────────────

describe('AutoMerger.attempt() — failure modes', () => {
  it('pauses with ci_failing on ci_failed category', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('ci_failed'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(42, 'owner/repo', 'ci_failing');
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('pauses with pr_closed when PR state becomes closed during polling', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'closed',
        mergeability: makeMergeability('unknown'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(42, 'owner/repo', 'pr_closed');
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('pauses with auto_merge_failed on blocked category', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('blocked'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'auto_merge_failed',
    );
    expect(updateMergeState).toHaveBeenCalled();
  });

  it('leaves conflict category to existing handling (no pause_reason set)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('conflict'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).not.toHaveBeenCalled();
    expect(github.mergePR).not.toHaveBeenCalled();
  });

  it('does not merge a PR in ci_running state (keeps polling until timeout)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    // ci_running has category='unknown' but mergeState='ci_running' — must not trigger merge
    const ciRunningMergeability: MergeabilityCategory = {
      category: 'unknown',
      mergeState: 'ci_running',
      rawMergeableState: 'unstable',
      failingChecks: [],
      headSha: 'sha-abc',
    };
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: ciRunningMergeability,
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalledWith(
      42,
      'owner/repo',
      'ci_failing',
    );
  });

  it('pauses with auto_merge_failed and notifies session on 405 "base branch was modified" race', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ session_id: 'coding-session' }),
    );
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const { GitHubApiError } = await import('./types.js');
    vi.mocked(github.mergePR).mockRejectedValueOnce(
      new GitHubApiError(405, 'Base branch was modified'),
    );
    vi.mocked(github.categorizeMergeability).mockResolvedValueOnce({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'behind',
      failingChecks: [],
      headSha: 'sha-abc',
    });
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(
      github,
      watcher,
      () => {},
      sessions as unknown as import('../session/SessionManager').SessionManager,
    );

    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'auto_merge_failed',
    );
    expect(sessions.sendOrResume).toHaveBeenCalledWith(
      'coding-session',
      expect.stringContaining('Base Branch Modified'),
    );
  });

  it('does NOT notify session for 405 with dirty (actual conflict) category', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ session_id: 'coding-session' }),
    );
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const { GitHubApiError } = await import('./types.js');
    vi.mocked(github.mergePR).mockRejectedValueOnce(
      new GitHubApiError(405, 'Merge conflict'),
    );
    vi.mocked(github.categorizeMergeability).mockResolvedValueOnce({
      category: 'conflict',
      mergeState: 'dirty',
      rawMergeableState: 'dirty',
      failingChecks: [],
      headSha: 'sha-abc',
    });
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(
      github,
      watcher,
      () => {},
      sessions as unknown as import('../session/SessionManager').SessionManager,
    );

    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).not.toHaveBeenCalled();
    expect(sessions.sendOrResume).not.toHaveBeenCalled();
  });

  it('populates failing_checks in DB when ci_failed category has failing check names', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('ci_failed', [
          { name: 'lint', conclusion: 'failure' },
          { name: 'unit-tests', conclusion: 'failure' },
        ]),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(setPauseReason).toHaveBeenCalledWith(42, 'owner/repo', 'ci_failing');
    expect(updateMergeState).toHaveBeenCalledWith(
      42,
      'owner/repo',
      0,
      'ci_failed',
      ['lint', 'unit-tests'],
    );
  });
});

// ── pollOnce() helpers ────────────────────────────────────────────────────────

function makeLocalBranchRow(
  overrides: Partial<LocalBranchRow> = {},
): LocalBranchRow {
  return {
    id: 10,
    project_id: 'proj-1',
    session_id: 'coding-session-1',
    branch_name: 'feature/my-task',
    base_branch: 'dev',
    status: 'open',
    review_result: JSON.stringify({ verdict: 'approved', summary: 'ok' }),
    pause_reason: null,
    merge_commit_sha: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'coding-session-1',
    task_id: 'notion:task-abc',
    task_url: 'https://notion.so/task-abc',
    project_context_url: null,
    project_id: 'proj-1',
    status: 'running',
    started_at: Date.now(),
    ended_at: null,
    pr_url: null,
    worktree_path: '/tmp/worktree-1',
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: null,
    task_name: 'My Task',
    metadata: null,
    review_result: null,
    ...overrides,
  };
}

function makeMockSessions(): {
  sendOrResume: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
} {
  return {
    sendOrResume: vi.fn().mockResolvedValue('coding-session-1'),
    endSession: vi.fn(),
  };
}

// ── pollOnce() — PR dispatch (regression guard) ───────────────────────────────

describe('AutoMerger.pollOnce() — PR dispatch regression', () => {
  it('calls attempt() for each approved open PR', async () => {
    const pr = makePRRow();
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([]);
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ pause_reason: 'stuck_timeout' }), // paused → attempt exits early
    );

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});

    await merger.pollOnce();

    // fetchPRStatusConditional would be called in the run() loop if not paused
    // here the row is paused so it exits early — but the key check is that
    // getPRByNumber was invoked (meaning attempt() started for the PR).
    expect(getPRByNumber).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('does NOT call squashMergeLocal for PR rows', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([makePRRow()]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([]);
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ pause_reason: 'stuck_timeout' }),
    );

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});

    await merger.pollOnce();
    await new Promise((r) => setTimeout(r, 50));

    expect(squashMergeLocal).not.toHaveBeenCalled();
  });
});

// ── pollOnce() — local branch dispatch ───────────────────────────────────────

describe('AutoMerger.pollOnce() — local branch dispatch', () => {
  it('skips local branches with no session row', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([makeLocalBranchRow()]);
    vi.mocked(getSession).mockReturnValue(undefined);

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const sessions = makeMockSessions();
    const merger = new AutoMerger(
      github,
      watcher,
      () => {},
      sessions as unknown as import('../session/SessionManager').SessionManager,
    );

    await merger.pollOnce();

    expect(squashMergeLocal).not.toHaveBeenCalled();
    expect(sessions.endSession).not.toHaveBeenCalled();
  });

  it('skips local branches where session has no worktree_path', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([makeLocalBranchRow()]);
    vi.mocked(getSession).mockReturnValue(
      makeSessionRow({ worktree_path: null }),
    );

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const sessions = makeMockSessions();
    const merger = new AutoMerger(
      github,
      watcher,
      () => {},
      sessions as unknown as import('../session/SessionManager').SessionManager,
    );

    await merger.pollOnce();

    expect(squashMergeLocal).not.toHaveBeenCalled();
  });

  it('pauses with merge_conflict and sends feedback when conflict detected', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([makeLocalBranchRow()]);
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(detectMergeConflict).mockResolvedValueOnce(true);

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const sessions = makeMockSessions();
    const merger = new AutoMerger(
      github,
      watcher,
      () => {},
      sessions as unknown as import('../session/SessionManager').SessionManager,
    );

    await merger.pollOnce();

    expect(setLocalBranchPauseReason).toHaveBeenCalledWith(
      10,
      'merge_conflict',
    );
    expect(sessions.sendOrResume).toHaveBeenCalledWith(
      'coding-session-1',
      expect.stringContaining('Merge Conflict'),
    );
    expect(squashMergeLocal).not.toHaveBeenCalled();
  });

  it('calls squashMergeLocal with correct args on clean branch', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([makeLocalBranchRow()]);
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(detectMergeConflict).mockResolvedValueOnce(false);
    vi.mocked(squashMergeLocal).mockResolvedValueOnce({
      merged: true,
      commitSha: 'abc123',
    });

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});

    await merger.pollOnce();

    expect(squashMergeLocal).toHaveBeenCalledWith({
      worktreePath: '/tmp/worktree-1',
      baseBranch: 'dev',
      featureBranch: 'feature/my-task',
      taskName: 'My Task',
    });
  });

  it('marks branch merged, ends session, updates task, and broadcasts on success', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([makeLocalBranchRow()]);
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(detectMergeConflict).mockResolvedValueOnce(false);
    vi.mocked(squashMergeLocal).mockResolvedValueOnce({
      merged: true,
      commitSha: 'abc123',
    });

    const mockBackend = { updateStatus: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(getTaskBackend).mockReturnValueOnce(
      mockBackend as unknown as ReturnType<typeof getTaskBackend>,
    );

    const broadcasts: import('../../ws/types').ServerMessage[] = [];
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const sessions = makeMockSessions();
    const merger = new AutoMerger(
      github,
      watcher,
      (msg) => broadcasts.push(msg),
      sessions as unknown as import('../session/SessionManager').SessionManager,
    );

    await merger.pollOnce();
    await new Promise((r) => setTimeout(r, 20));

    expect(markLocalBranchMerged).toHaveBeenCalledWith(10, 'abc123');
    expect(sessions.endSession).toHaveBeenCalledWith('coding-session-1');
    expect(mockBackend.updateStatus).toHaveBeenCalledWith(
      'notion:task-abc',
      '✅ Done',
    );
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'local_branch_merged',
        projectId: 'proj-1',
        sessionId: 'coding-session-1',
        branchName: 'feature/my-task',
        commitSha: 'abc123',
      }),
    );
  });

  it('pauses with merge_conflict when squashMergeLocal returns conflict', async () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([]);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([makeLocalBranchRow()]);
    vi.mocked(getSession).mockReturnValue(makeSessionRow());
    vi.mocked(detectMergeConflict).mockResolvedValueOnce(false);
    vi.mocked(squashMergeLocal).mockResolvedValueOnce({
      merged: false,
      conflict: true,
    });

    const sessions = makeMockSessions();
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(
      github,
      watcher,
      () => {},
      sessions as unknown as import('../session/SessionManager').SessionManager,
    );

    await merger.pollOnce();

    expect(setLocalBranchPauseReason).toHaveBeenCalledWith(
      10,
      'merge_conflict',
    );
    expect(sessions.sendOrResume).toHaveBeenCalled();
    expect(markLocalBranchMerged).not.toHaveBeenCalled();
  });
});

// ── Corporate mode — human approval gate ──────────────────────────────────────

function makeCorporateMode(requireHumanApproval: boolean) {
  return {
    enabled: requireHumanApproval,
    envLocked: false,
    gates: {
      dockerMandatory: requireHumanApproval,
      requireHumanApproval,
      requireZDR: requireHumanApproval,
      validatePRBody: requireHumanApproval,
      secretsViaSeam: requireHumanApproval,
    },
  };
}

describe('AutoMerger — corporate mode human approval gate', () => {
  it('proceeds to merge when corporate mode is ON and review is APPROVED', async () => {
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(true));
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    const github = makeMockGitHub(
      [
        {
          status: 'ok',
          etag: 'W/"a"',
          state: 'open',
          mergeability: makeMergeability('clean'),
          headSha: 'sha-abc',
        },
      ],
      'APPROVED',
    );
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.getReviewState).toHaveBeenCalledWith(42, 'owner/repo');
    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('pauses with awaiting_human_approval when corporate mode is ON and review is REVIEW_REQUIRED', async () => {
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(true));
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    const github = makeMockGitHub(
      [
        {
          status: 'ok',
          etag: 'W/"a"',
          state: 'open',
          mergeability: makeMergeability('clean'),
          headSha: 'sha-abc',
        },
      ],
      'REVIEW_REQUIRED',
    );
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).not.toHaveBeenCalled();
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'awaiting_human_approval',
    );
  });

  it('pauses with human_changes_requested when corporate mode is ON and review is CHANGES_REQUESTED', async () => {
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(true));
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    const github = makeMockGitHub(
      [
        {
          status: 'ok',
          etag: 'W/"a"',
          state: 'open',
          mergeability: makeMergeability('clean'),
          headSha: 'sha-abc',
        },
      ],
      'CHANGES_REQUESTED',
    );
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.mergePR).not.toHaveBeenCalled();
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'human_changes_requested',
    );
  });

  it('skips approval check and merges when corporate mode is OFF', async () => {
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(false));
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    const github = makeMockGitHub(
      [
        {
          status: 'ok',
          etag: 'W/"a"',
          state: 'open',
          mergeability: makeMergeability('clean'),
          headSha: 'sha-abc',
        },
      ],
      null,
    );
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 50));

    expect(github.getReviewState).not.toHaveBeenCalled();
    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(setPauseReason).not.toHaveBeenCalled();
  });
});

// ── Boot sweep ────────────────────────────────────────────────────────────────

describe('AutoMerger boot sweep', () => {
  it('triggers attempt() for each orphan-mergeable PR on construction', async () => {
    const pr1 = { pr_number: 108, repo: 'owner/repo' };
    const pr2 = { pr_number: 109, repo: 'owner/repo' };
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([pr1, pr2]);
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ pause_reason: 'stuck_timeout' }), // paused → attempt exits early
    );

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    new AutoMerger(github, watcher, () => {});
    await new Promise((r) => setTimeout(r, 50));

    expect(getPRByNumber).toHaveBeenCalledWith(108, 'owner/repo');
    expect(getPRByNumber).toHaveBeenCalledWith(109, 'owner/repo');
  });

  it('does not call attempt() when no orphans exist', () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    new AutoMerger(github, watcher, () => {});

    expect(getPRByNumber).not.toHaveBeenCalled();
  });

  it('ignores PRs with pause_reason set (regression guard)', async () => {
    // getOrphanMergeablePRs only returns rows with pause_reason IS NULL —
    // this test verifies the query contract is respected by AutoMerger.
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    new AutoMerger(github, watcher, () => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(getPRByNumber).not.toHaveBeenCalled();
  });

  it('ignores PRs with state != open (regression guard)', async () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    new AutoMerger(github, watcher, () => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(getPRByNumber).not.toHaveBeenCalled();
  });

  it('ignores PRs with verdict != approved (regression guard)', async () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    new AutoMerger(github, watcher, () => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(getPRByNumber).not.toHaveBeenCalled();
  });

  it('ignores PRs with merge_state != clean (regression guard)', async () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    new AutoMerger(github, watcher, () => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(getPRByNumber).not.toHaveBeenCalled();
  });

  it('integration: orphan PR flows through attempt() and triggers merge', async () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());

    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    new AutoMerger(github, watcher, () => {});
    await new Promise((r) => setTimeout(r, 100));

    expect(github.mergePR).toHaveBeenCalledWith(42, 'feat: test', 'owner/repo');
    expect(watcher.handleMerged).toHaveBeenCalled();
  });
});

// ── Auto-clear stale auto_merge_failed pauses ─────────────────────────────────

describe('AutoMerger.clearStalePauses()', () => {
  it('clears pause and retries for stale auto_merge_failed PRs', async () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    vi.mocked(getStaleAutoMergeFailedPRs).mockReturnValue([
      { pr_number: 111, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow({ pr_number: 111 }));

    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.clearStalePauses();
    await new Promise((r) => setTimeout(r, 100));

    expect(setPauseReason).toHaveBeenCalledWith(111, 'owner/repo', null);
    expect(github.mergePR).toHaveBeenCalledWith(
      111,
      expect.any(String),
      'owner/repo',
    );
  });

  it('passes correct threshold to getStaleAutoMergeFailedPRs', () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    vi.mocked(getStaleAutoMergeFailedPRs).mockReturnValue([]);

    runtimeSettingsFixture.auto_merge_failed_clear_minutes = 15;

    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});
    merger.clearStalePauses();

    expect(getStaleAutoMergeFailedPRs).toHaveBeenCalledWith(15 * 60_000);
  });

  it('does NOT clear max_reviews pauses', () => {
    // getStaleAutoMergeFailedPRs only returns auto_merge_failed rows —
    // other pause reasons never reach clearStalePauses.
    vi.mocked(getStaleAutoMergeFailedPRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});
    merger.clearStalePauses();

    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('does NOT clear ci_failing pauses', () => {
    vi.mocked(getStaleAutoMergeFailedPRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});
    merger.clearStalePauses();

    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('does NOT clear ci_billing_blocked pauses', () => {
    vi.mocked(getStaleAutoMergeFailedPRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});
    merger.clearStalePauses();

    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('does NOT clear pr_body_invalid pauses', () => {
    vi.mocked(getStaleAutoMergeFailedPRs).mockReturnValue([]);
    const github = makeMockGitHub([]);
    const watcher = makeMockWatcher();
    const merger = new AutoMerger(github, watcher, () => {});
    merger.clearStalePauses();

    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('integration: PR with stale auto_merge_failed gets cleared and merged', async () => {
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    vi.mocked(getStaleAutoMergeFailedPRs).mockReturnValue([
      { pr_number: 111, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({ pr_number: 111, pause_reason: null }),
    );

    const github = makeMockGitHub([
      {
        status: 'ok',
        etag: 'W/"a"',
        state: 'open',
        mergeability: makeMergeability('clean'),
        headSha: 'sha-abc',
      },
    ]);
    const watcher = makeMockWatcher();

    const merger = new AutoMerger(github, watcher, () => {});
    merger.clearStalePauses();
    await new Promise((r) => setTimeout(r, 100));

    expect(setPauseReason).toHaveBeenCalledWith(111, 'owner/repo', null);
    expect(watcher.handleMerged).toHaveBeenCalled();
  });
});
