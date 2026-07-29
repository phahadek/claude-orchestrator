import { describe, it, expect, vi } from 'vitest';

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

vi.mock('../../db/queries.js', () => ({
  getPRByNumber: vi.fn(),
  setPauseReason: vi.fn(),
  updateMergeState: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  getApprovedOpenPRs: vi.fn().mockReturnValue([]),
  getApprovedLocalBranches: vi.fn().mockReturnValue([]),
  markLocalBranchMerged: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  getSession: vi.fn(),
  getOrphanMergeablePRs: vi.fn().mockReturnValue([]),
  getStaleAutoMergeFailedPRs: vi.fn().mockReturnValue([]),
  getConflictNudgeCandidates: vi.fn().mockReturnValue([]),
  upsertActiveMerge: vi.fn(),
  deleteActiveMerge: vi.fn(),
  getAllActiveMerges: vi.fn().mockReturnValue([]),
  setConflictNudgeSha: vi.fn(),
  getTaskCache: vi.fn().mockReturnValue(undefined),
  getPendingRoutedCommentCount: vi.fn().mockReturnValue(0),
  markReviewerRequested: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getProjectById: vi.fn(() => projectFixture),
  runtimeSettings: runtimeSettingsFixture,
}));

vi.mock('../../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../../orchestration/localMergeRunner.js', () => ({
  squashMergeLocal: vi.fn(),
}));

vi.mock('../../orchestration/localBranchHelpers.js', () => ({
  detectMergeConflict: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn(() => ({ verify: [], ci_check_name: [] })),
}));

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../config/corporateMode.js', () => ({
  getCorporateMode: vi.fn(() => ({
    enabled: false,
    envLocked: false,
    gates: {
      dockerMandatory: false,
      requireHumanApproval: false,
      requireZDR: false,
      validatePRBody: false,
    },
  })),
}));

import { AutoMerger } from '../AutoMerger';
import {
  getPRByNumber,
  getSession,
  getConflictNudgeCandidates,
  setConflictNudgeSha,
} from '../../db/queries';
import type { GitHubClient, PRReviewDecision } from '../GitHubClient';
import type { PRMergeWatcher } from '../PRMergeWatcher';
import type { PullRequestRow, Session } from '../../db/types';
import type { MergeabilityCategory } from '../types';
import { GitHubRateLimitError } from '../types';
import type { Scheduler } from '../../orchestration/Scheduler';

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
    reviewer_requested_at: null,
    conflict_nudge_sha: null,
    ci_remediation_attempted_sha: null,
    stalled_pr_retry_count: 0,
    ...overrides,
  } as PullRequestRow;
}

function makeMergeability(
  category: MergeabilityCategory['category'],
): MergeabilityCategory {
  return {
    category,
    mergeState: category === 'clean' ? 'clean' : category,
    rawMergeableState: category === 'clean' ? 'clean' : category,
    failingChecks: [],
    headSha: 'sha-abc',
  } as MergeabilityCategory;
}

function makeMockGitHub(): GitHubClient {
  return {
    fetchPRStatusConditional: vi
      .fn()
      .mockResolvedValue({ status: 'not_modified' as const, etag: null }),
    mergePR: vi
      .fn()
      .mockResolvedValue({ merged: true, message: 'ok', sha: 'merged-sha' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    categorizeMergeability: vi
      .fn()
      .mockResolvedValue(makeMergeability('clean')),
    getReviewState: vi.fn().mockResolvedValue(null as PRReviewDecision | null),
    detectBillingBlock: vi.fn().mockResolvedValue({ blocked: false }),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
}

function makeMockWatcher(): PRMergeWatcher {
  return {
    handleMerged: vi.fn().mockResolvedValue(undefined),
  } as unknown as PRMergeWatcher;
}

function makeSessionRow(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'coding-session',
    task_id: 'notion:task-abc',
    task_url: 'https://notion.so/task-abc',
    project_context_url: null,
    project_id: 'proj-1',
    status: 'idle',
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
  } as Session;
}

function makeMockSessions(): {
  sendOrResume: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  relaunchFixerForPR: ReturnType<typeof vi.fn>;
} {
  return {
    sendOrResume: vi.fn().mockResolvedValue('coding-session'),
    endSession: vi.fn(),
    relaunchFixerForPR: vi.fn().mockResolvedValue('coding-session'),
  };
}

function getRegisteredJob(
  merger: AutoMerger,
  name: string,
): { run: () => Promise<void>; concurrency?: string } {
  const registered: { name: string; run: () => Promise<void>; concurrency?: string }[] =
    [];
  const fakeScheduler = {
    register: vi.fn(
      (opts: { name: string; run: () => Promise<void>; concurrency?: string }) => {
        registered.push(opts);
      },
    ),
  };
  merger.register(fakeScheduler as unknown as Scheduler);
  const job = registered.find((j) => j.name === name);
  if (!job) throw new Error(`job '${name}' was not registered`);
  return job;
}

// ── Scheduled conflict-nudge sweep ────────────────────────────────────────────

describe('AutoMerger — scheduled conflict-nudge sweep', () => {
  it('nudges a live implementing session via the scheduled job, with no boot or rate-limit event', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getConflictNudgeCandidates).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));

    const github = makeMockGitHub();
    vi.mocked(github.categorizeMergeability).mockResolvedValue(
      makeMergeability('conflict'),
    );

    const merger = new AutoMerger(
      github,
      makeMockWatcher(),
      () => {},
      sessions as unknown as import('../../session/SessionManager').SessionManager,
    );
    // Boot fires conflictNudgeSweep() once — clear any calls it produced so
    // this test only observes the effect of the scheduled job's run().
    vi.mocked(getConflictNudgeCandidates).mockClear();
    sessions.sendOrResume.mockClear();
    vi.mocked(setConflictNudgeSha).mockClear();
    vi.mocked(getConflictNudgeCandidates).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' },
    ]);

    const job = getRegisteredJob(merger, 'auto_merger_conflict_nudge_sweep');
    await job.run();

    expect(sessions.sendOrResume).toHaveBeenCalledWith(
      'coding-session',
      expect.stringContaining('Rebase'),
    );
    expect(setConflictNudgeSha).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'sha-abc',
    );
    expect(sessions.relaunchFixerForPR).not.toHaveBeenCalled();
  });

  it('routes a dead implementing session to the fixer-relaunch path, unchanged from current behavior', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getConflictNudgeCandidates).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'done' }));

    const github = makeMockGitHub();
    vi.mocked(github.categorizeMergeability).mockResolvedValue(
      makeMergeability('conflict'),
    );

    const merger = new AutoMerger(
      github,
      makeMockWatcher(),
      () => {},
      sessions as unknown as import('../../session/SessionManager').SessionManager,
    );

    const job = getRegisteredJob(merger, 'auto_merger_conflict_nudge_sweep');
    await job.run();

    expect(sessions.relaunchFixerForPR).toHaveBeenCalledWith(
      expect.objectContaining({ pr_number: 42 }),
      expect.stringContaining('Rebase'),
    );
    expect(sessions.sendOrResume).not.toHaveBeenCalled();
  });

  it('skips a PR whose category is neither conflict nor blocked', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getConflictNudgeCandidates).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));

    const github = makeMockGitHub();
    vi.mocked(github.categorizeMergeability).mockResolvedValue(
      makeMergeability('clean'),
    );

    const merger = new AutoMerger(
      github,
      makeMockWatcher(),
      () => {},
      sessions as unknown as import('../../session/SessionManager').SessionManager,
    );

    const job = getRegisteredJob(merger, 'auto_merger_conflict_nudge_sweep');
    await job.run();

    expect(sessions.sendOrResume).not.toHaveBeenCalled();
    expect(sessions.relaunchFixerForPR).not.toHaveBeenCalled();
  });

  it('is a no-op while AutoMerger is in its rate-limit pause state', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getConflictNudgeCandidates).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));

    const github = makeMockGitHub();
    vi.mocked(github.categorizeMergeability).mockResolvedValue(
      makeMergeability('conflict'),
    );
    // First attempt() call hits a rate-limit error, which parks AutoMerger
    // in its paused state until resetAt.
    vi.mocked(github.fetchPRStatusConditional).mockRejectedValueOnce(
      new GitHubRateLimitError(
        'rate limited',
        new Date(Date.now() + 60_000),
        5000,
        5000,
      ),
    );

    const merger = new AutoMerger(
      github,
      makeMockWatcher(),
      () => {},
      sessions as unknown as import('../../session/SessionManager').SessionManager,
    );
    merger.attempt(42, 'owner/repo');
    await new Promise((r) => setTimeout(r, 20));

    // The constructor's bootSweep() also fires conflictNudgeSweep() once,
    // asynchronously and unpaused (it runs before attempt() above hits the
    // rate limit) — clear its effects so only the scheduled job is observed.
    vi.mocked(getConflictNudgeCandidates).mockClear();
    sessions.sendOrResume.mockClear();
    sessions.relaunchFixerForPR.mockClear();
    const job = getRegisteredJob(merger, 'auto_merger_conflict_nudge_sweep');
    await job.run();

    // Paused — the sweep must not even look up candidates.
    expect(getConflictNudgeCandidates).not.toHaveBeenCalled();
    expect(sessions.sendOrResume).not.toHaveBeenCalled();
    expect(sessions.relaunchFixerForPR).not.toHaveBeenCalled();
  });
});

// ── Existing callers still invoke the sweep ───────────────────────────────────

describe('AutoMerger — existing conflictNudgeSweep callers are unchanged', () => {
  it('bootSweep() still invokes conflictNudgeSweep on construction', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getConflictNudgeCandidates).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo' },
    ]);
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getSession).mockReturnValue(makeSessionRow({ status: 'idle' }));

    const github = makeMockGitHub();
    vi.mocked(github.categorizeMergeability).mockResolvedValue(
      makeMergeability('conflict'),
    );

    new AutoMerger(
      github,
      makeMockWatcher(),
      () => {},
      sessions as unknown as import('../../session/SessionManager').SessionManager,
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(sessions.sendOrResume).toHaveBeenCalledWith(
      'coding-session',
      expect.stringContaining('Rebase'),
    );
  });

  it('pollOnce() (rate-limit-cleared caller) still invokes conflictNudgeSweep', async () => {
    const sessions = makeMockSessions();
    vi.mocked(getConflictNudgeCandidates).mockReturnValue([]);

    const github = makeMockGitHub();
    const merger = new AutoMerger(
      github,
      makeMockWatcher(),
      () => {},
      sessions as unknown as import('../../session/SessionManager').SessionManager,
    );

    const spy = vi.spyOn(merger, 'conflictNudgeSweep');
    await merger.pollOnce();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
