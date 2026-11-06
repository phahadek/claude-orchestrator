import { describe, it, expect, vi, beforeEach } from 'vitest';

const { projectFixture, queueHead } = vi.hoisted(() => ({
  projectFixture: {
    id: 'proj-1',
    githubRepo: 'owner/repo',
    projectDir: '/tmp',
    baseBranch: 'dev',
    autoMergeEnabled: true,
  },
  queueHead: vi.fn(),
}));

vi.mock('../mergeQueue', () => ({
  computeMergeQueues: () => new Map(),
  checkPrQueueHead: queueHead,
  checkLocalBranchQueueHead: () => ({ allowed: true, waitMs: 0 }),
}));

vi.mock('../../db/queries', () => ({
  recordPrQueueWait: vi.fn(),
  recordLocalBranchQueueWait: vi.fn(),
  clearPrEnqueued: vi.fn(),
  getPRByNumber: vi.fn(),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  updateMergeState: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  getApprovedOpenPRs: vi.fn().mockReturnValue([]),
  getApprovedLocalBranches: vi.fn().mockReturnValue([]),
  getSession: vi.fn(),
  getOrphanMergeablePRs: vi.fn().mockReturnValue([]),
  getStaleAutoMergeFailedPRs: vi.fn().mockReturnValue([]),
  getConflictNudgeCandidates: vi.fn().mockReturnValue([]),
  getAllActiveMerges: vi.fn().mockReturnValue([]),
  upsertActiveMerge: vi.fn(),
  deleteActiveMerge: vi.fn(),
  getLatestTestRequestRun: vi.fn(),
  markSessionDone: vi.fn(),
  recordPrAnchoredCompletingSignal: vi.fn(),
}));

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(() => projectFixture),
  getProjectById: vi.fn(() => projectFixture),
  runtimeSettings: { auto_merge_failed_clear_minutes: 10 },
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../orchestration/localMergeRunner', () => ({
  squashMergeLocal: vi.fn(),
}));
vi.mock('../../orchestration/localBranchHelpers', () => ({
  detectMergeConflict: vi.fn(),
}));
vi.mock('../../tasks/TaskBackend', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn(() => ({ test: ['npm test'] })),
}));
vi.mock('../../session/analyzeGating', () => ({
  computeWholeTreeContentHash: vi.fn().mockResolvedValue('fallback'),
}));
vi.mock('../../orchestration/combinedTree', () => ({
  resolveCombinedTree: vi.fn(),
}));
vi.mock('../../orchestration/baseAttributableFilter', () => ({
  filterBaseAttributableFailuresForF2Gate: vi.fn(),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../migrationNumberGuard', () => ({
  guardMigrationNumbersBeforeMerge: vi.fn().mockResolvedValue({ ok: true }),
}));

import { AutoMerger } from '../AutoMerger';
import {
  clearPrEnqueued,
  getLatestTestRequestRun,
  getSession,
  recordPrQueueWait,
  setPauseReason,
} from '../../db/queries';
import { resolveCombinedTree } from '../../orchestration/combinedTree';
import { filterBaseAttributableFailuresForF2Gate } from '../../orchestration/baseAttributableFilter';
import type { GitHubClient } from '../GitHubClient';
import type { PRMergeWatcher } from '../PRMergeWatcher';
import type { PullRequestRow } from '../../db/types';

const pr = {
  pr_number: 42,
  repo: 'owner/repo',
  session_id: 's1',
  title: 'feat: x',
  base_branch: 'dev',
  head_sha: 'sha-head',
  review_result: JSON.stringify({ verdict: 'approved' }),
  pause_reason: null,
  human_merge_only: 0,
} as unknown as PullRequestRow;

function makeMerger() {
  const github = {
    mergePR: vi.fn().mockResolvedValue({ merged: true, sha: 'merged-sha' }),
  } as unknown as GitHubClient;
  const watcher = {
    handleMerged: vi.fn().mockResolvedValue(undefined),
  } as unknown as PRMergeWatcher;
  const merger = new AutoMerger(github, watcher, () => {});
  const attemptMerge = () =>
    (
      merger as unknown as {
        attemptMerge: (p: PullRequestRow) => Promise<void>;
      }
    ).attemptMerge(pr);
  return { github, attemptMerge };
}

beforeEach(() => {
  vi.clearAllMocks();
  queueHead.mockReturnValue({ allowed: true, waitMs: 5000 });
  vi.mocked(getSession).mockReturnValue({ worktree_path: '/wt' } as never);
  vi.mocked(resolveCombinedTree).mockResolvedValue({
    status: 'ok',
    treeOid: 't',
    baseSha: 'b',
    contentHash: 'combined-1',
  });
});

describe('AutoMerger merge queue', () => {
  it('declines a non-head PR without merging or touching its pause state', async () => {
    queueHead.mockReturnValue({ allowed: false, headLabel: 'PR #1' });
    const { github, attemptMerge } = makeMerger();
    await attemptMerge();
    expect(github.mergePR).not.toHaveBeenCalled();
    expect(resolveCombinedTree).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('merges the head only when a passing run matches its freshly recomputed combined tree, and records queue wait', async () => {
    vi.mocked(getLatestTestRequestRun).mockReturnValue({
      state: 'passed',
    } as never);
    const { github, attemptMerge } = makeMerger();
    await attemptMerge();
    expect(getLatestTestRequestRun).toHaveBeenCalledWith(
      'proj-1',
      'combined-1',
      'full',
    );
    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(recordPrQueueWait).toHaveBeenCalledWith(42, 'owner/repo', 5000);
  });

  it('declines the head when base moved out-of-band so no run certifies the new combined tree', async () => {
    vi.mocked(getLatestTestRequestRun).mockImplementation(((
      _p: string,
      hash: string,
    ) => (hash === 'combined-old' ? { state: 'passed' } : undefined)) as never);
    vi.mocked(resolveCombinedTree).mockResolvedValue({
      status: 'ok',
      treeOid: 't2',
      baseSha: 'b2',
      contentHash: 'combined-new',
    });
    const { github, attemptMerge } = makeMerger();
    await attemptMerge();
    expect(github.mergePR).not.toHaveBeenCalled();
    expect(setPauseReason).not.toHaveBeenCalled();
  });

  it('ejects a head whose combined-tree gate failed: pause reason set, enqueue stamp cleared, no merge', async () => {
    vi.mocked(getLatestTestRequestRun).mockReturnValue({
      state: 'failed',
    } as never);
    vi.mocked(filterBaseAttributableFailuresForF2Gate).mockResolvedValue({
      result: { outcome: 'unfiltered', passed: false },
    } as never);
    const { github, attemptMerge } = makeMerger();
    await attemptMerge();
    expect(github.mergePR).not.toHaveBeenCalled();
    expect(clearPrEnqueued).toHaveBeenCalledWith(42, 'owner/repo');
    expect(setPauseReason).toHaveBeenCalledWith(42, 'owner/repo', 'ci_failing');
  });
});
