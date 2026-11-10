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
vi.mock('../../orchestration/combinedTree', () => ({
  resolveCombinedTree: vi.fn(),
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

  it('merges the head with no test-run or combined-tree lookup and records queue wait', async () => {
    const { github, attemptMerge } = makeMerger();
    await attemptMerge();
    expect(getLatestTestRequestRun).not.toHaveBeenCalled();
    expect(resolveCombinedTree).not.toHaveBeenCalled();
    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(recordPrQueueWait).toHaveBeenCalledWith(42, 'owner/repo', 5000);
  });

  it('merges the head even when no run certifies the current combined tree', async () => {
    vi.mocked(getLatestTestRequestRun).mockReturnValue(undefined as never);
    const { github, attemptMerge } = makeMerger();
    await attemptMerge();
    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(setPauseReason).not.toHaveBeenCalled();
    expect(clearPrEnqueued).not.toHaveBeenCalled();
  });

  it('does not eject a head over a failed test run: no ci_failing pause, merge proceeds', async () => {
    vi.mocked(getLatestTestRequestRun).mockReturnValue({
      state: 'failed',
    } as never);
    const { github, attemptMerge } = makeMerger();
    await attemptMerge();
    expect(github.mergePR).toHaveBeenCalledTimes(1);
    expect(setPauseReason).not.toHaveBeenCalledWith(
      42,
      'owner/repo',
      'ci_failing',
    );
    expect(clearPrEnqueued).not.toHaveBeenCalled();
  });
});
