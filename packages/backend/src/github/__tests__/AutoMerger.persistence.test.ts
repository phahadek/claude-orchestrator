import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ ci_check_name: [], mcp_servers: undefined }),
}));
vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  getProjectById: vi.fn(),
  runtimeSettings: {
    ci_poll_interval_seconds: 5,
    ci_poll_max_minutes: 1,
    auto_merge_failed_clear_minutes: 5,
  },
}));
vi.mock('../../config/corporateMode', () => ({
  getCorporateMode: vi.fn().mockReturnValue({ gates: { requireHumanApproval: false } }),
}));
vi.mock('../../db/queries', () => ({
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
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../tasks/TaskBackend', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../../orchestration/localMergeRunner', () => ({ squashMergeLocal: vi.fn() }));
vi.mock('../../orchestration/localBranchHelpers', () => ({ detectMergeConflict: vi.fn() }));
vi.mock('../reviewUtils', () => ({ formatMergeConflictFeedback: vi.fn() }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AutoMerger } from '../AutoMerger';
import {
  upsertActiveMerge,
  deleteActiveMerge,
  getAllActiveMerges,
  getOrphanMergeablePRs,
} from '../../db/queries';
import { getProjectByGithubRepo } from '../../config';
import type { GitHubClient } from '../GitHubClient';
import type { PRMergeWatcher } from '../PRMergeWatcher';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 42;
const REPO = 'org/repo';
const KEY = `${REPO}#${PR_NUMBER}`;

function makeGitHubClient(): GitHubClient {
  return {
    fetchPRStatusConditional: vi.fn().mockResolvedValue({ status: 'not_modified' }),
    mergePR: vi.fn(),
    getReviewState: vi.fn(),
    categorizeMergeability: vi.fn(),
    detectBillingBlock: vi.fn(),
  } as unknown as GitHubClient;
}

function makeMergeWatcher(): PRMergeWatcher {
  return {
    handleMerged: vi.fn().mockResolvedValue(undefined),
  } as unknown as PRMergeWatcher;
}

function makeBroadcast() {
  return vi.fn();
}

function makeProject() {
  return { id: 'proj-1', autoMergeEnabled: true, projectDir: '/proj' } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AutoMerger — persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    vi.mocked(getAllActiveMerges).mockReturnValue([]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject());
  });

  it('upserts active_merges row when attempt() starts a loop', () => {
    const gh = makeGitHubClient();
    const watcher = makeMergeWatcher();
    const merger = new AutoMerger(gh, watcher, makeBroadcast());

    merger.attempt(PR_NUMBER, REPO);

    expect(vi.mocked(upsertActiveMerge)).toHaveBeenCalledWith(KEY, REPO, PR_NUMBER);
  });

  it('does not call upsertActiveMerge for a duplicate attempt', () => {
    const gh = makeGitHubClient();
    // Keep the loop running by never resolving fetchPRStatusConditional
    vi.mocked(gh.fetchPRStatusConditional).mockReturnValue(new Promise(() => {}));
    const merger = new AutoMerger(gh, makeMergeWatcher(), makeBroadcast());

    merger.attempt(PR_NUMBER, REPO);
    vi.mocked(upsertActiveMerge).mockClear();
    merger.attempt(PR_NUMBER, REPO); // duplicate — should be a no-op

    expect(vi.mocked(upsertActiveMerge)).not.toHaveBeenCalled();
  });

  it('deletes active_merges row when the loop finishes', async () => {
    const gh = makeGitHubClient();
    // fetchPRStatusConditional returns immediately so the loop exits fast
    vi.mocked(gh.fetchPRStatusConditional).mockResolvedValue({
      status: 'ok',
      etag: null,
      state: 'merged',
      mergeability: { category: 'clean', headSha: null, failingChecks: [] },
    } as any);

    const merger = new AutoMerger(gh, makeMergeWatcher(), makeBroadcast());
    merger.attempt(PR_NUMBER, REPO);

    // Let the microtask queue drain
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(vi.mocked(deleteActiveMerge)).toHaveBeenCalledWith(KEY);
  });
});

describe('AutoMerger — rehydrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([]);
    vi.mocked(getProjectByGithubRepo).mockReturnValue(makeProject());
  });

  it('restores in-flight keys from the DB and resumes them', () => {
    vi.mocked(getAllActiveMerges).mockReturnValue([
      { key: KEY, repo: REPO, pr_number: PR_NUMBER, started_at: Date.now() - 1000 },
    ]);
    const gh = makeGitHubClient();
    // Create merger (bootSweep runs but orphans list is empty)
    const merger = new AutoMerger(gh, makeMergeWatcher(), makeBroadcast());

    // Simulate a restart: clear in-memory set by calling rehydrate on a fresh instance
    vi.mocked(upsertActiveMerge).mockClear();
    merger.rehydrate();

    expect(vi.mocked(upsertActiveMerge)).toHaveBeenCalledWith(KEY, REPO, PR_NUMBER);
  });

  it('does not double-run when rehydrate and bootSweep target the same PR', () => {
    vi.mocked(getAllActiveMerges).mockReturnValue([
      { key: KEY, repo: REPO, pr_number: PR_NUMBER, started_at: Date.now() - 1000 },
    ]);
    vi.mocked(getOrphanMergeablePRs).mockReturnValue([
      { pr_number: PR_NUMBER, repo: REPO } as any,
    ]);
    // Keep loop alive so second attempt() is blocked by the active guard
    const gh = makeGitHubClient();
    vi.mocked(gh.fetchPRStatusConditional).mockReturnValue(new Promise(() => {}));

    const merger = new AutoMerger(gh, makeMergeWatcher(), makeBroadcast());
    // bootSweep ran during construction — one upsert for the orphan
    const upsertCallsAfterBoot = vi.mocked(upsertActiveMerge).mock.calls.length;

    // rehydrate sees the same PR is already in-flight → idempotent guard fires
    merger.rehydrate();

    // No additional upsert should have happened
    expect(vi.mocked(upsertActiveMerge).mock.calls.length).toBe(upsertCallsAfterBoot);
  });
});
