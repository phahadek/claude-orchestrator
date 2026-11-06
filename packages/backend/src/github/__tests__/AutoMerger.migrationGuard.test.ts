import { describe, it, expect, vi, beforeEach } from 'vitest';

const { projectFixture, runtimeSettingsFixture, configFixture } = vi.hoisted(
  () => ({
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
    configFixture: {
      verify: [],
      ci_check_name: [],
      test: [] as string[],
      test_timeout_sec: 300,
      migrations: undefined as
        | { dir: string; filename_pattern: string }
        | undefined,
    },
  }),
);

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

vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
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
  loadOrchestratorConfig: vi.fn(() => configFixture),
}));
vi.mock('../../session/analyzeGating', () => ({
  computeWholeTreeContentHash: vi.fn().mockResolvedValue('content-hash-1'),
}));
vi.mock('../../orchestration/baseAttributableFilter', () => ({
  filterBaseAttributableFailuresForF2Gate: vi.fn(),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
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
import { getPRByNumber, getSession, setPauseReason } from '../../db/queries';
import type { GitHubClient } from '../GitHubClient';
import type { PRMergeWatcher } from '../PRMergeWatcher';
import type { PullRequestRow, Session } from '../../db/types';

const DIR = 'migrations/postgres';

function makePRRow(): PullRequestRow {
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
  } as PullRequestRow;
}

function makeGitHub(opts: { baseFiles: string[] | Error }): GitHubClient {
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
    getPRFiles: vi
      .fn()
      .mockResolvedValue([
        { filename: `${DIR}/0255_new.sql`, status: 'added' },
      ]),
    listFilePathsAtRef:
      opts.baseFiles instanceof Error
        ? vi.fn().mockRejectedValue(opts.baseFiles)
        : vi.fn().mockResolvedValue(opts.baseFiles),
  } as unknown as GitHubClient;
}

const watcher = () =>
  ({
    handleMerged: vi.fn().mockResolvedValue(undefined),
  }) as unknown as PRMergeWatcher;

async function attempt(merger: AutoMerger): Promise<void> {
  merger.attempt(42, 'owner/repo');
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
  vi.clearAllMocks();
  configFixture.migrations = {
    dir: DIR,
    filename_pattern: '^(\\d+)_.+\\.sql$',
  };
  vi.mocked(getPRByNumber).mockReturnValue(makePRRow());
  vi.mocked(getSession).mockReturnValue({
    session_id: 'coding-session',
    worktree_path: '/tmp/worktree',
  } as unknown as Session);
});

describe('AutoMerger migration-number guard', () => {
  it('does not merge a clean PR whose migration number exists on the base branch; pauses and routes feedback to the session', async () => {
    const github = makeGitHub({ baseFiles: [`${DIR}/0255_other.sql`] });
    const sessions = { enqueueFeedback: vi.fn().mockResolvedValue(undefined) };
    const merger = new AutoMerger(
      github,
      watcher(),
      () => {},
      sessions as never,
    );

    await attempt(merger);

    expect(github.mergePR).not.toHaveBeenCalled();
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'migration_number_collision',
      expect.stringContaining(`${DIR}/0255_other.sql`),
    );
    expect(sessions.enqueueFeedback).toHaveBeenCalledWith(
      'coding-session',
      'migration-collision',
      expect.stringContaining('Next free number on dev: 256'),
    );
  });

  it('fails closed when the base listing cannot be fetched, then merges on a later healthy attempt', async () => {
    const github = makeGitHub({ baseFiles: new Error('502') });
    const merger = new AutoMerger(github, watcher(), () => {}, undefined);

    await attempt(merger);
    expect(github.mergePR).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();

    vi.mocked(github.listFilePathsAtRef).mockResolvedValue([
      `${DIR}/0254_a.sql`,
    ]);
    await attempt(merger);
    expect(github.mergePR).toHaveBeenCalledTimes(1);
  });

  it('never checks (and merges) when the project has no migrations config', async () => {
    configFixture.migrations = undefined;
    const github = makeGitHub({ baseFiles: [`${DIR}/0255_other.sql`] });
    const merger = new AutoMerger(github, watcher(), () => {}, undefined);

    await attempt(merger);

    expect(github.getPRFiles).not.toHaveBeenCalled();
    expect(github.mergePR).toHaveBeenCalledTimes(1);
  });
});
