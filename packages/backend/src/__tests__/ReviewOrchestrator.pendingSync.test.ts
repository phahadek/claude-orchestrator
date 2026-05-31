/**
 * Unit tests for ReviewOrchestrator pending-sync persistence.
 *
 * Covers:
 * 1. registerRevertSync inserts a DB row before the git operation starts
 * 2. The sync's completion handler deletes the row on success
 * 3. Boot retry: incomplete rows trigger a git sync and clear the row
 * 4. Boot retry is idempotent — no error when the git operation is a no-op
 * 5. No regression: existing review-loop tests unaffected (empty pending table)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  setPRReviewResult: vi.fn(),
  getPRByNumber: vi.fn(),
  getSession: vi.fn().mockReturnValue(undefined),
  getSetting: vi.fn().mockReturnValue(undefined),
  incrementReviewIteration: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  getLocalBranchBySession: vi.fn(),
  setLocalBranchPauseReason: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  deleteAllAutofixShasForPR: vi.fn(),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
}));

vi.mock('../github/PRFileReverter.js', () => ({
  syncToOrigin: vi.fn().mockResolvedValue('abc123'),
  revertBannedFiles: vi.fn(),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));

vi.mock('../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi
    .fn()
    .mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    verify: [],
    autofix: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
  }),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue(undefined),
  getAllProjects: vi.fn().mockReturnValue([]),
  getProjectById: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { ReviewOrchestrator } from '../github/ReviewOrchestrator.js';
import * as queries from '../db/queries.js';
import { syncToOrigin } from '../github/PRFileReverter.js';
import type { PRReviewService } from '../github/PRReviewService.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { PullRequestRow } from '../db/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn();
  isAlive = vi.fn().mockReturnValue(false);
  endSession = vi.fn();
  start = vi.fn();
  addToRevertLock = vi.fn();
}

function makeMockReviewService(): PRReviewService {
  return {
    reviewPR: vi.fn(),
    reReviewPR: vi.fn(),
  } as unknown as PRReviewService;
}

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'notion:task-id',
    session_id: 'code-session-uuid',
    repo: 'owner/repo',
    title: 'feat: test',
    body: null,
    head_branch: 'feature/test',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T01:00:00Z',
    synced_at: '2024-01-01T01:00:00Z',
    review_session_id: null,
    review_iteration: 0,
    head_sha: 'abc123',
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    pending_push: 0,
    pause_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([]);
});

// ── 1. registerRevertSync inserts a DB row ─────────────────────────────────────

describe('registerRevertSync — DB persistence', () => {
  it('inserts a pending_review_sync row before the git operation starts', async () => {
    const sessionManager = new MockSessionManager();
    const orchestrator = new ReviewOrchestrator(
      makeMockReviewService(),
      sessionManager as unknown as SessionManager,
    );
    await orchestrator.bootReady;

    let resolveSyncPromise!: () => void;
    const syncPromise = new Promise<void>((r) => {
      resolveSyncPromise = r;
    });

    orchestrator.registerRevertSync(42, 'owner/repo', syncPromise);

    // Row should be inserted before the promise resolves
    expect(vi.mocked(queries.insertPendingReviewSync)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
    // Not yet deleted
    expect(vi.mocked(queries.deletePendingReviewSync)).not.toHaveBeenCalled();

    resolveSyncPromise();
    await syncPromise;
    // Give the .finally() handler a tick to run
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(queries.deletePendingReviewSync)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('deletes the row even when the sync promise rejects', async () => {
    const sessionManager = new MockSessionManager();
    const orchestrator = new ReviewOrchestrator(
      makeMockReviewService(),
      sessionManager as unknown as SessionManager,
    );
    await orchestrator.bootReady;

    const syncPromise = Promise.reject(new Error('git failure'));
    orchestrator.registerRevertSync(42, 'owner/repo', syncPromise);

    // Consume the tracked promise (which re-throws) to avoid unhandled rejection
    const pendingMap = (
      orchestrator as unknown as { pendingSyncs: Map<string, Promise<void>> }
    ).pendingSyncs;
    await pendingMap.get('42:owner/repo')?.catch(() => {});

    expect(vi.mocked(queries.deletePendingReviewSync)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });
});

// ── 2. Boot retry: incomplete rows trigger git sync and clear the row ──────────

describe('rehydratePendingSyncs — boot retry', () => {
  it('reads pending rows, runs git sync, and clears the DB row', async () => {
    vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo', sync_state: 'pending' },
    ]);
    vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'code-session-uuid',
      worktree_path: '/tmp/worktree',
    } as unknown as import('../db/types.js').Session);

    const sessionManager = new MockSessionManager();
    const orchestrator = new ReviewOrchestrator(
      makeMockReviewService(),
      sessionManager as unknown as SessionManager,
    );
    await orchestrator.bootReady;

    expect(vi.mocked(syncToOrigin)).toHaveBeenCalledWith(
      '/tmp/worktree',
      'feature/test',
    );
    expect(vi.mocked(queries.deletePendingReviewSync)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('skips git sync when no session worktree_path is available', async () => {
    vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo', sync_state: 'pending' },
    ]);
    vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(queries.getSession).mockReturnValue(undefined);

    const sessionManager = new MockSessionManager();
    const orchestrator = new ReviewOrchestrator(
      makeMockReviewService(),
      sessionManager as unknown as SessionManager,
    );
    await orchestrator.bootReady;

    // syncToOrigin should not have been called — no worktree_path
    expect(vi.mocked(syncToOrigin)).not.toHaveBeenCalled();
    // Row should still be cleared
    expect(vi.mocked(queries.deletePendingReviewSync)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('is idempotent — no error when git sync throws (already completed push)', async () => {
    vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo', sync_state: 'pending' },
    ]);
    vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'code-session-uuid',
      worktree_path: '/tmp/worktree',
    } as unknown as import('../db/types.js').Session);
    vi.mocked(syncToOrigin).mockRejectedValue(new Error('git: not a git repo'));

    const sessionManager = new MockSessionManager();
    const orchestrator = new ReviewOrchestrator(
      makeMockReviewService(),
      sessionManager as unknown as SessionManager,
    );
    // Should not throw
    await expect(orchestrator.bootReady).resolves.toBeUndefined();
    // Row cleared despite git error
    expect(vi.mocked(queries.deletePendingReviewSync)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('arms pendingSyncs so executeReview can await the promise', async () => {
    let resolveSync!: () => void;
    const slowSync = new Promise<string | null>((r) => {
      resolveSync = () => r('abc');
    });
    vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([
      { pr_number: 42, repo: 'owner/repo', sync_state: 'pending' },
    ]);
    vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'code-session-uuid',
      worktree_path: '/tmp/worktree',
    } as unknown as import('../db/types.js').Session);
    vi.mocked(syncToOrigin).mockReturnValue(slowSync);

    const sessionManager = new MockSessionManager();
    const orchestrator = new ReviewOrchestrator(
      makeMockReviewService(),
      sessionManager as unknown as SessionManager,
    );

    // While bootReady is pending, pendingSyncs should have the entry
    const pendingMap = (
      orchestrator as unknown as { pendingSyncs: Map<string, Promise<void>> }
    ).pendingSyncs;
    expect(pendingMap.has('42:owner/repo')).toBe(true);

    resolveSync();
    await orchestrator.bootReady;

    expect(vi.mocked(queries.deletePendingReviewSync)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });
});

// ── 3. No regression: empty pending table → bootReady resolves immediately ────

describe('empty pending_review_sync table', () => {
  it('bootReady resolves without calling syncToOrigin', async () => {
    vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([]);

    const sessionManager = new MockSessionManager();
    const orchestrator = new ReviewOrchestrator(
      makeMockReviewService(),
      sessionManager as unknown as SessionManager,
    );
    await orchestrator.bootReady;

    expect(vi.mocked(syncToOrigin)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.deletePendingReviewSync)).not.toHaveBeenCalled();
  });
});
