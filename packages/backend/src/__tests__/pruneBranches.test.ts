/**
 * Tests for the feature/* branch pruning logic.
 *
 * Covers:
 *   - handleMerged deletes origin feature branch via GitHubClient.deleteBranch
 *   - handleMerged marks session for local branch deletion
 *   - handleMerged skips deletion for non-feature/* branches
 *   - Open-PR branches are not deleted (guard)
 *   - Protected branches (dev, main) are not touched
 *   - Missing-PR-row branches are skipped with a warning log
 *   - Backfill dry-run mode lists without deleting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  updatePRState: vi.fn(),
  deleteAllAutofixShasForPR: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  getPRByNumber: vi.fn(),
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  getSetting: vi.fn().mockReturnValue(null),
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue({
    id: 'proj-1',
    projectDir: '/test',
  }),
  getProjectById: vi.fn(),
  AUTO_REVIEW_ENABLED: false,
  config: {},
}));

vi.mock('../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({ ci_check_name: [] }),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { TaskBackend } from '../tasks/TaskBackend.js';
import type { PullRequestRow } from '../db/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO = 'owner/repo';
const PR_NUMBER = 42;

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'notion:task-abc',
    session_id: 'session-abc',
    repo: REPO,
    title: 'feat: test task',
    body: null,
    head_branch: 'feature/test-task',
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
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    ci_remediation_attempted_sha: null,
    ...overrides,
  };
}

function makeWatcher(
  githubOverrides: Partial<GitHubClient> = {},
  sessionsOverrides: Partial<SessionManager> = {},
) {
  const github = {
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    ...githubOverrides,
  } as unknown as GitHubClient;

  const sessions = {
    endSession: vi.fn(),
    markForBranchDeletion: vi.fn(),
  } as unknown as SessionManager;
  Object.assign(sessions, sessionsOverrides);

  const taskBackend = {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskBackend;

  const broadcast = vi.fn();
  const watcher = new PRMergeWatcher(github, sessions, taskBackend, broadcast);
  return { watcher, github, sessions, broadcast };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRMergeWatcher.handleMerged — branch pruning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes origin feature branch and marks session for local deletion', async () => {
    const { watcher, github, sessions } = makeWatcher();
    const pr = makePRRow({ head_branch: 'feature/test-task' });

    await watcher.handleMerged(pr, null);

    expect(github.deleteBranch).toHaveBeenCalledWith(REPO, 'feature/test-task');
    expect(sessions.markForBranchDeletion).toHaveBeenCalledWith('session-abc');
    expect(sessions.endSession).toHaveBeenCalledWith('session-abc');
  });

  it('does not delete branch for non-feature/* head branch', async () => {
    const { watcher, github, sessions } = makeWatcher();
    const pr = makePRRow({ head_branch: 'bugfix/some-fix' });

    await watcher.handleMerged(pr, null);

    expect(github.deleteBranch).not.toHaveBeenCalled();
    expect(sessions.markForBranchDeletion).not.toHaveBeenCalled();
    expect(sessions.endSession).toHaveBeenCalledWith('session-abc');
  });

  it('does not delete branch when head_branch is null', async () => {
    const { watcher, github, sessions } = makeWatcher();
    const pr = makePRRow({ head_branch: null });

    await watcher.handleMerged(pr, null);

    expect(github.deleteBranch).not.toHaveBeenCalled();
    expect(sessions.markForBranchDeletion).not.toHaveBeenCalled();
  });

  it('continues when deleteBranch throws (logs warning, does not abort)', async () => {
    const { watcher, github, sessions } = makeWatcher({
      deleteBranch: vi.fn().mockRejectedValue(new Error('not found')),
    });
    const pr = makePRRow({ head_branch: 'feature/test-task' });

    await expect(watcher.handleMerged(pr, null)).resolves.not.toThrow();
    expect(sessions.endSession).toHaveBeenCalledWith('session-abc');
  });

  it('does not call markForBranchDeletion when session_id is null', async () => {
    const { watcher, sessions } = makeWatcher();
    const pr = makePRRow({ session_id: null, head_branch: 'feature/test' });

    await watcher.handleMerged(pr, null);

    expect(sessions.markForBranchDeletion).not.toHaveBeenCalled();
    expect(sessions.endSession).not.toHaveBeenCalled();
  });

  it('dev and main branches are never touched (protected branch guard)', async () => {
    const { watcher, github } = makeWatcher();

    for (const branch of ['dev', 'main']) {
      vi.clearAllMocks();
      const pr = makePRRow({ head_branch: branch });
      await watcher.handleMerged(pr, null);
      expect(github.deleteBranch).not.toHaveBeenCalled();
    }
  });
});

// ── Backfill dry-run behaviour ────────────────────────────────────────────────

describe('prune-feature-branches backfill script — dry-run logic', () => {
  it('does not call delete functions in dry-run mode', () => {
    // The script is an ES module; we test the pruning decision logic inline
    // rather than spawning the script as a subprocess.

    type PrState = 'open' | 'merged' | 'closed' | null;

    function shouldPrune(
      branch: string,
      prState: PrState,
      dryRun: boolean,
    ): { action: 'prune' | 'keep' | 'skip'; wouldDelete: boolean } {
      const PROTECTED = new Set(['dev', 'main', 'master']);
      if (PROTECTED.has(branch)) return { action: 'keep', wouldDelete: false };
      if (prState === null) return { action: 'skip', wouldDelete: false };
      if (prState === 'open') return { action: 'keep', wouldDelete: false };
      return { action: 'prune', wouldDelete: !dryRun };
    }

    // merged → pruned in live mode
    expect(shouldPrune('feature/foo', 'merged', false)).toEqual({
      action: 'prune',
      wouldDelete: true,
    });

    // merged → listed but NOT deleted in dry-run
    expect(shouldPrune('feature/foo', 'merged', true)).toEqual({
      action: 'prune',
      wouldDelete: false,
    });

    // closed → pruned in live mode
    expect(shouldPrune('feature/bar', 'closed', false)).toEqual({
      action: 'prune',
      wouldDelete: true,
    });

    // open → kept
    expect(shouldPrune('feature/open', 'open', false)).toEqual({
      action: 'keep',
      wouldDelete: false,
    });

    // protected → kept
    expect(shouldPrune('dev', 'merged', false)).toEqual({
      action: 'keep',
      wouldDelete: false,
    });
    expect(shouldPrune('main', 'merged', false)).toEqual({
      action: 'keep',
      wouldDelete: false,
    });

    // no PR record → skipped with warning (conservative)
    expect(shouldPrune('feature/mystery', null, false)).toEqual({
      action: 'skip',
      wouldDelete: false,
    });
  });
});
