import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must precede imports of the modules under test) ───────────────────

const { projectFixture, runtimeSettingsFixture, orchestratorConfigFixture } =
  vi.hoisted(() => ({
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
      ci_poll_interval_seconds: 1,
      ci_poll_max_minutes: 1,
      auto_merge_failed_clear_minutes: 10,
    },
    orchestratorConfigFixture: {
      verify: [],
      ci_check_name: [],
      test: ['npm test'],
      test_timeout_sec: 300,
    },
  }));

vi.mock('../../db/queries', () => ({
  getPRByNumber: vi.fn(),
  setHeadSha: vi.fn(),
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
  getAnalyzeResult: vi.fn().mockReturnValue(undefined),
  getLatestTestRequestRun: vi.fn().mockReturnValue(undefined),
  markSessionDone: vi.fn(),
  recordPrAnchoredCompletingSignal: vi.fn(),
}));

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'owner/repo' ? projectFixture : undefined,
  ),
  getProjectById: vi.fn(() => projectFixture),
  runtimeSettings: runtimeSettingsFixture,
}));

vi.mock('../../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../../orchestration/localMergeRunner', () => ({
  squashMergeLocal: vi.fn(),
}));

vi.mock('../../orchestration/localBranchHelpers', () => ({
  detectMergeConflict: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn(() => orchestratorConfigFixture),
}));

vi.mock('../../session/analyzeGating', () => ({
  computeWholeTreeContentHash: vi.fn().mockResolvedValue('content-hash-1'),
}));

vi.mock('../../orchestration/baseAttributableFilter', () => ({
  filterBaseAttributableFailuresForF2Gate: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../config/corporateMode', () => ({
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
  getLatestTestRequestRun,
} from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';
import { computeWholeTreeContentHash } from '../../session/analyzeGating';
import { filterBaseAttributableFailuresForF2Gate } from '../../orchestration/baseAttributableFilter';
import type { GitHubClient } from '../GitHubClient';
import type { PRMergeWatcher } from '../PRMergeWatcher';
import type {
  PullRequestRow,
  Session,
  TestRequestRunRow,
} from '../../db/types';

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
    ...overrides,
  } as PullRequestRow;
}

function makeMockGitHub(): GitHubClient {
  return {
    fetchPRStatusConditional: vi.fn().mockResolvedValue({
      status: 'ok',
      etag: null,
      state: 'open',
      mergeability: {
        category: 'clean',
        headSha: 'sha-abc',
        failingChecks: [],
      },
    }),
    mergePR: vi
      .fn()
      .mockResolvedValue({ merged: true, message: 'ok', sha: 'merged-sha' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    categorizeMergeability: vi.fn().mockResolvedValue({
      category: 'clean',
      mergeState: 'clean',
      rawMergeableState: 'clean',
      failingChecks: [],
    }),
    getReviewState: vi.fn().mockResolvedValue(null),
    detectBillingBlock: vi.fn().mockResolvedValue({ blocked: false }),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
    fetchDiff: vi
      .fn()
      .mockResolvedValue({ prId: 42, diff: '', filesChanged: [] }),
  } as unknown as GitHubClient;
}

function makeMockWatcher(): PRMergeWatcher {
  return {
    handleMerged: vi.fn().mockResolvedValue(undefined),
  } as unknown as PRMergeWatcher;
}

function makeTestRun(
  overrides: Partial<TestRequestRunRow> = {},
): TestRequestRunRow {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    content_hash: 'content-hash-1',
    session_id: null,
    state: 'failed',
    output: '',
    requested_at: null,
    started_at: Date.now(),
    finished_at: Date.now(),
    structured_result: null,
    failure_reason: null,
    concurrent_run_count: null,
    oom_killed: 0,
    test_report_acquisition_attempted: null,
    run_origin: null,
    producer: null,
    run_kind: 'full',
    base_sha: null,
    ...overrides,
  } as TestRequestRunRow;
}

async function runAttemptAndWait(
  merger: AutoMerger,
  prNumber = 42,
  repo = 'owner/repo',
): Promise<void> {
  merger.attempt(prNumber, repo);
  // Let the async run()/attemptMerge() chain settle.
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSettingsFixture.ci_poll_interval_seconds = 1;
  runtimeSettingsFixture.ci_poll_max_minutes = 1;
  vi.mocked(getSession).mockReturnValue({
    session_id: 'coding-session',
    worktree_path: '/tmp/worktree',
  } as unknown as Session);
  vi.mocked(computeWholeTreeContentHash).mockResolvedValue('content-hash-1');
  vi.mocked(getLatestTestRequestRun).mockReturnValue(undefined);
});

describe('AutoMerger merge eligibility — human_merge_only', () => {
  it("isMergeEligible() itself returns reason human_merge_only for a human_merge_only PR, independent of run()'s own earlier short-circuit", async () => {
    // run()'s pre-poll-loop check already returns before ever reaching
    // attemptMerge for a human_merge_only PR (see AutoMerger.ts), so this
    // exercises the unified predicate directly — the single source of truth
    // the task spec calls for, which every attemptMerge caller (including
    // any future one that doesn't duplicate run()'s own early check) funnels
    // through.
    const github = makeMockGitHub();
    const merger = new AutoMerger(github, makeMockWatcher(), () => {});
    const pr = makePRRow({ human_merge_only: 1 });

    const result = await (
      merger as unknown as {
        isMergeEligible: (
          pr: PullRequestRow,
        ) => Promise<{ ok: true } | { ok: false; reason: string }>;
      }
    ).isMergeEligible(pr);

    expect(result).toEqual({ ok: false, reason: 'human_merge_only' });
  });
});

describe('AutoMerger merge eligibility — verdict gate', () => {
  it('declines to merge a clean PR whose latest review verdict is verify_failed, never calling mergePR', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({
        review_result: JSON.stringify({ verdict: 'verify_failed' }),
      }),
    );
    const github = makeMockGitHub();
    const merger = new AutoMerger(github, makeMockWatcher(), () => {});

    await runAttemptAndWait(merger);

    expect(github.mergePR).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'auto_merge_declined',
        payload: expect.objectContaining({
          pr_number: 42,
          repo: 'owner/repo',
          stage: 'eligibility',
          reason: 'verdict_not_approved',
        }),
      }),
    );
  });
});

describe('AutoMerger merge eligibility — test gate', () => {
  it('declines with test_gate_not_passed when no passing full test run exists for the head content hash', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getLatestTestRequestRun).mockReturnValue(undefined);
    const github = makeMockGitHub();
    const merger = new AutoMerger(github, makeMockWatcher(), () => {});

    await runAttemptAndWait(merger);

    expect(github.mergePR).not.toHaveBeenCalled();
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'auto_merge_declined',
        payload: expect.objectContaining({
          reason: 'test_gate_not_passed',
        }),
      }),
    );
  });

  it('merges when the latest full test run for the head content hash passed', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getLatestTestRequestRun).mockReturnValue(
      makeTestRun({ state: 'passed' }),
    );
    const github = makeMockGitHub();
    const merger = new AutoMerger(github, makeMockWatcher(), () => {});

    await runAttemptAndWait(merger);

    expect(github.mergePR).toHaveBeenCalled();
  });

  it('merges when the latest full test run is a settled passed row in the post-sweep shape (structured_result NULL, test_report_acquisition_attempted=1 — the extraction drain already durably recorded the report)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getLatestTestRequestRun).mockReturnValue(
      makeTestRun({
        state: 'passed',
        structured_result: null,
        test_report_acquisition_attempted: 1,
      }),
    );
    const github = makeMockGitHub();
    const merger = new AutoMerger(github, makeMockWatcher(), () => {});

    await runAttemptAndWait(merger);

    expect(github.mergePR).toHaveBeenCalled();
  });

  it('treats a base-attributable/verified-flaky excused failure as merge-eligible', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(getLatestTestRequestRun).mockReturnValue(
      makeTestRun({ state: 'failed' }),
    );
    vi.mocked(filterBaseAttributableFailuresForF2Gate).mockResolvedValue({
      result: {
        outcome: 'filtered_pass',
        passed: true,
        excludedTests: [{ test_id: 't1', name: 'flaky test' }],
        flakyExcludedTests: [],
        remainingTests: [],
        baseRun: null,
      },
      guardBlocked: [],
    });
    const github = makeMockGitHub();
    const merger = new AutoMerger(github, makeMockWatcher(), () => {});

    await runAttemptAndWait(merger);

    expect(github.mergePR).toHaveBeenCalled();
  });
});

describe('AutoMerger merge eligibility — becomes-clean re-drive', () => {
  it('does not merge a verify_failed PR reached via a plain attempt() call (simulating PRMergeWatcher becomes-clean re-drive)', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(
      makePRRow({
        pause_reason: null,
        merge_state: 'clean',
        review_result: JSON.stringify({ verdict: 'verify_failed' }),
      }),
    );
    const github = makeMockGitHub();
    const merger = new AutoMerger(github, makeMockWatcher(), () => {});

    // Mirrors PRMergeWatcher.ts's `this.autoMerger?.attempt(pr.pr_number, pr.repo)`
    // becomes-clean re-drive call.
    await runAttemptAndWait(merger);

    expect(github.mergePR).not.toHaveBeenCalled();
  });
});
