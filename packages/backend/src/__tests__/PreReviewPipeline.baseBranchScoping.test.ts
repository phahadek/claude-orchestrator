/**
 * Tests that PreReviewPipeline's autofix and analyze stages scope their diff
 * to the PR's own base_branch (two_tier), falling back to the project's
 * baseBranch when the PR has none recorded (flat-mode / pre-PR).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockRunAutofix, mockGetChangedFiles } = vi.hoisted(() => ({
  mockRunAutofix: vi.fn(),
  mockGetChangedFiles: vi.fn().mockResolvedValue([]),
}));

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
  getLatestTestRequestRun: vi.fn().mockReturnValue(undefined),
  deleteTestRequestRunsForContentHash: vi.fn(),
  hasAnalyzeResultForSha: vi.fn().mockReturnValue(false),
  upsertAnalyzeResult: vi.fn(),
  getAnalyzeResult: vi.fn().mockReturnValue(undefined),
  getAnalyzeContentCacheResult: vi.fn().mockReturnValue(undefined),
  insertAnalyzeContentCacheResult: vi.fn(),
  setPreReviewStage: vi.fn(),
  setLastReviewedSha: vi.fn(),
}));

vi.mock('../github/PRFileReverter.js', () => ({
  syncToOrigin: vi.fn().mockResolvedValue('abc123'),
  revertBannedFiles: vi.fn(),
}));

vi.mock('../session/autofix-runner.js', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue(['ruff check --fix']),
  runAutofix: mockRunAutofix,
  getChangedFiles: mockGetChangedFiles,
}));

vi.mock('../session/filePollutionCheck.js', () => ({
  runFilePollutionCheck: vi
    .fn()
    .mockResolvedValue({ headSha: null, revertCommitSha: null }),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock('../session/test-runner.js', () => ({
  runTestCommands: vi.fn().mockResolvedValue({ passed: true, output: '' }),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import { PreReviewPipeline } from '../github/PreReviewPipeline.js';
import * as queries from '../db/queries.js';
import { loadOrchestratorConfig } from '../session/orchestrator-config.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { PullRequestRow } from '../db/types.js';

vi.mock('../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

class MockSessionManager extends EventEmitter {
  send = vi.fn();
  sendOrResume = vi.fn().mockResolvedValue(undefined);
  isAlive = vi.fn().mockReturnValue(false);
  endSession = vi.fn();
  start = vi.fn();
  addToRevertLock = vi.fn();
}

function makePRRow(overrides: Partial<PullRequestRow> = {}): PullRequestRow {
  return {
    id: 1,
    pr_number: 42,
    pr_url: 'https://github.com/owner/repo/pull/42',
    task_id: 'notion:task-id',
    session_id: 'impl-session-uuid',
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
    failing_checks: null,
    pending_push: 0,
    pause_reason: null,
    pause_reason_set_at: null,
    ci_remediation_attempted_sha: null,
    pre_review_stage: null,
    conflict_nudge_sha: null,
    ...overrides,
  } as PullRequestRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([]);
  vi.mocked(queries.getSession).mockReturnValue({
    session_id: 'impl-session-uuid',
    worktree_path: '/worktrees/impl',
    status: 'idle',
  } as never);
  mockGetChangedFiles.mockResolvedValue([]);
  mockRunAutofix.mockResolvedValue({
    success: true,
    summary: 'no changes',
    commitSha: null,
  });
});

function makePipeline() {
  const sessionManager = new MockSessionManager();
  const pipeline = new PreReviewPipeline(
    sessionManager as unknown as SessionManager,
  );
  return { pipeline, sessionManager };
}

const JOB = {
  prNumber: 42,
  repo: 'owner/repo',
  taskId: 'task-1',
};

const PROJECT = {
  id: 'proj-1',
  projectDir: '/project',
  githubRepo: 'owner/repo',
  baseBranch: 'dev',
} as never;

describe('autofix stage base-branch scoping', () => {
  it("passes the PR's own base_branch to runAutofix for a two_tier PR", async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: ['ruff check --fix'],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze: [],
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as never);
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({ base_branch: 'release/1.0' }),
    );

    const { pipeline } = makePipeline();
    await pipeline.run(JOB, PROJECT);

    expect(mockRunAutofix).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'release/1.0',
      expect.anything(),
      expect.anything(),
    );
  });

  it("falls back to the project's base branch when the PR has no base_branch recorded", async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: ['ruff check --fix'],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze: [],
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as never);
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({ base_branch: null }),
    );

    const { pipeline } = makePipeline();
    await pipeline.run(JOB, PROJECT);

    expect(mockRunAutofix).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'dev',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('analyze stage base-branch scoping', () => {
  it("diffs against the PR's own base_branch for a two_tier PR", async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: [],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze: ['echo analyze'],
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as never);
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({ base_branch: 'release/1.0' }),
    );

    const { pipeline } = makePipeline();
    await pipeline.run(JOB, PROJECT);

    expect(mockGetChangedFiles).toHaveBeenCalledWith(
      '/worktrees/impl',
      'release/1.0',
    );
  });

  it("falls back to the project's base branch when the PR has no base_branch recorded", async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: [],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze: ['echo analyze'],
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    } as never);
    vi.mocked(queries.getPRByNumber).mockReturnValue(
      makePRRow({ base_branch: null }),
    );

    const { pipeline } = makePipeline();
    await pipeline.run(JOB, PROJECT);

    expect(mockGetChangedFiles).toHaveBeenCalledWith('/worktrees/impl', 'dev');
  });
});
