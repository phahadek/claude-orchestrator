import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite for DB-level helper tests ────────────────────────────────
// vi.mock is hoisted before imports, so this runs first and queries.ts picks
// up the in-memory database.

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));

import { db } from '../db/db.js';
import { recordEvent } from '../audit/AuditLog.js';
import {
  clearTerminalPRFlags,
  setPauseReason,
  setPreReviewStage,
  upsertPullRequest,
} from '../db/queries.js';

const NOW = '2024-01-01T00:00:00Z';

function insertPR(prNumber: number, repo = 'owner/repo'): void {
  upsertPullRequest({
    pr_number: prNumber,
    pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    task_id: null,
    session_id: null,
    repo,
    title: `PR ${prNumber}`,
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: false,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    node_id: null,
  });
}

function getPRRow(prNumber: number, repo = 'owner/repo') {
  return db
    .prepare<{ pr_number: number; repo: string }>(
      `SELECT pause_reason, pause_reason_set_at, pre_review_stage
       FROM pull_requests
       WHERE pr_number = @pr_number AND repo = @repo`,
    )
    .get({ pr_number: prNumber, repo }) as
    | {
        pause_reason: string | null;
        pause_reason_set_at: number | null;
        pre_review_stage: string | null;
      }
    | undefined;
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  vi.clearAllMocks();
});

// ── clearTerminalPRFlags helper ───────────────────────────────────────────────

describe('clearTerminalPRFlags — DB helper', () => {
  it('nulls pause_reason, pause_reason_set_at, and pre_review_stage', () => {
    insertPR(1);
    setPauseReason(1, 'owner/repo', 'review_failed');
    setPreReviewStage(1, 'owner/repo', 'autofix');

    const before = getPRRow(1);
    expect(before?.pause_reason).not.toBeNull();
    expect(before?.pause_reason_set_at).not.toBeNull();
    expect(before?.pre_review_stage).toBe('autofix');

    clearTerminalPRFlags(1, 'owner/repo');

    const after = getPRRow(1);
    expect(after?.pause_reason).toBeNull();
    expect(after?.pause_reason_set_at).toBeNull();
    expect(after?.pre_review_stage).toBeNull();
  });

  it('is a no-op when both fields are already null', () => {
    insertPR(2);
    expect(() => clearTerminalPRFlags(2, 'owner/repo')).not.toThrow();
    const row = getPRRow(2);
    expect(row?.pause_reason).toBeNull();
    expect(row?.pre_review_stage).toBeNull();
  });

  it('emits pr_terminal_flags_cleared audit event with pr_number and repo', () => {
    insertPR(3);
    clearTerminalPRFlags(3, 'owner/repo');
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_terminal_flags_cleared',
        actor_type: 'system',
        payload: expect.objectContaining({ pr_number: 3, repo: 'owner/repo' }),
      }),
    );
  });
});

// ── PRMergeWatcher call-site tests (mocked queries) ──────────────────────────

const mockQueries = vi.hoisted(() => ({
  getAllOpenPRs: vi.fn().mockReturnValue([]),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  getPRByNumber: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  setCiRemediationAttemptedSha: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn(),
  deleteAllAutofixShasForPR: vi.fn(),
  setHeadSha: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPRReviewResult: vi.fn(),
  setPendingPush: vi.fn(),
  getTestResult: vi.fn().mockReturnValue(null),
  markSessionDone: vi.fn(),
  setPreReviewStage: vi.fn(),
  clearTerminalPRFlags: vi.fn(),
}));

vi.mock('../db/queries.js', () => mockQueries);

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue({ id: 'proj-1' }),
  getProjectById: vi.fn().mockReturnValue(null),
  AUTO_REVIEW_ENABLED: false,
  runtimeSettings: {},
}));

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({ ci_check_name: [] }),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: vi.fn().mockReturnValue(3),
}));

vi.mock('../routes/tasks.js', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../tasks/TaskBackend.js', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../github/reviewUtils.js', () => ({
  formatCIFailureFeedback: vi.fn(),
  shouldAutoReview: vi.fn().mockReturnValue(false),
  formatReviewFeedback: vi.fn(),
}));
vi.mock('../github/conflictNudge.js', () => ({ sendConflictNudge: vi.fn() }));
vi.mock('../github/pollUtils.js', () => ({
  isTerminalStalePR: vi.fn().mockReturnValue(false),
}));
vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn(),
  runAutofix: vi.fn(),
}));

import { PRMergeWatcher } from '../github/PRMergeWatcher.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { PullRequestRow } from '../db/types.js';

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: null,
    session_id: null,
    review_session_id: null,
    repo: 'owner/repo',
    title: 'PR 42',
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_iteration: 0,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    pre_review_stage: null,
    pause_reason_set_at: null,
    conflict_nudge_sha: null,
    ci_remediation_attempted_sha: null,
    autofix_shas: null,
    ...overrides,
  } as PullRequestRow;
}

function makeWatcher() {
  const github = {
    getPRState: vi.fn(),
    listOpenPRStates: vi.fn(),
    listOpenPRs: vi.fn(),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitHubClient;
  const sessions = {
    markSessionErrored: vi.fn(),
    endSession: vi.fn(),
    markForBranchDeletion: vi.fn(),
    sendOrResume: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
  const broadcast = vi.fn();
  const watcher = new PRMergeWatcher(github, sessions, undefined, broadcast);
  return { watcher, github, sessions, broadcast };
}

describe('PRMergeWatcher — handleMerged clears terminal flags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls clearTerminalPRFlags on merged path', async () => {
    const { watcher } = makeWatcher();
    const pr = makePRRow({
      pause_reason: '{"reason":"review_failed"}',
      pre_review_stage: 'autofix',
    });
    await watcher.handleMerged(pr, 'sha123');
    expect(mockQueries.clearTerminalPRFlags).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });
});

describe('PRMergeWatcher — PR-closed path clears terminal flags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls clearTerminalPRFlags when PR is closed without merge', async () => {
    const { watcher, github } = makeWatcher();
    const pr = makePRRow({
      pause_reason: '{"reason":"review_failed"}',
      pre_review_stage: 'autofix',
    });
    mockQueries.getAllOpenPRs.mockReturnValue([pr]);
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'closed',
      headSha: null,
    });
    await watcher.poll();
    expect(mockQueries.clearTerminalPRFlags).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });
});

describe('PRMergeWatcher — negative case: open PR poll does not clear flags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not call clearTerminalPRFlags when PR remains open', async () => {
    const { watcher, github } = makeWatcher();
    const pr = makePRRow({ head_sha: 'abc', merge_state: 'blocked' });
    mockQueries.getAllOpenPRs.mockReturnValue([pr]);
    // PR is still open — processOpenPR runs, no terminal transition
    vi.mocked(github.getPRState).mockResolvedValue({
      state: 'open',
      headSha: 'abc',
    });
    await watcher.poll();
    expect(mockQueries.clearTerminalPRFlags).not.toHaveBeenCalled();
  });
});
