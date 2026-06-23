/**
 * Tests for the autofix stage in PreReviewPipeline — covers:
 *
 * 1. When runAutofix returns unfixableViolations, sendOrResume is called with a
 *    nudge to the implementing session and the gate still passes.
 * 2. When runAutofix returns success=false, handleGateFailure is called and the
 *    pipeline returns passed=false (gate fails).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockRunAutofix } = vi.hoisted(() => ({
  mockRunAutofix: vi.fn(),
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
  hasTestResultForSha: vi.fn().mockReturnValue(false),
  upsertTestResult: vi.fn(),
  hasAnalyzeResultForSha: vi.fn().mockReturnValue(false),
  upsertAnalyzeResult: vi.fn(),
  getAnalyzeResult: vi.fn().mockReturnValue(undefined),
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
  }),
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
import type { SessionManager } from '../session/SessionManager.js';
import type { PullRequestRow } from '../db/types.js';

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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([]);
  vi.mocked(queries.getPRByNumber).mockReturnValue(makePRRow());
  vi.mocked(queries.getSession).mockReturnValue({
    session_id: 'impl-session-uuid',
    worktree_path: '/worktrees/impl',
    status: 'idle',
  } as never);
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
} as never;

// ── 1. Unfixable violations: gate passes, sendOrResume called ─────────────────

describe('unfixable violations from autofix', () => {
  it('calls sendOrResume with violation nudge and returns passed=true', async () => {
    const violationOutput = 'src/foo.py:42:89: E501 Line too long';
    mockRunAutofix.mockResolvedValue({
      success: true,
      summary: 'autofix committed deadbeef',
      commitSha: 'deadbeef',
      unfixableViolations: violationOutput,
    });

    const { pipeline, sessionManager } = makePipeline();
    const result = await pipeline.run(JOB, PROJECT);

    expect(result.passed).toBe(true);
    expect(sessionManager.sendOrResume).toHaveBeenCalledOnce();
    const [, nudge] = sessionManager.sendOrResume.mock.calls[0];
    expect(nudge).toMatch(/Unfixable Violations/);
    expect(nudge).toContain(violationOutput);
  });

  it('does not call sendOrResume when there are no unfixable violations', async () => {
    mockRunAutofix.mockResolvedValue({
      success: true,
      summary: 'autofix committed deadbeef',
      commitSha: 'deadbeef',
    });

    const { pipeline, sessionManager } = makePipeline();
    await pipeline.run(JOB, PROJECT);

    expect(sessionManager.sendOrResume).not.toHaveBeenCalled();
  });
});

// ── 2. Fatal autofix failure: gate fails ──────────────────────────────────────

describe('fatal autofix failure', () => {
  it('returns passed=false and routes error message to implementing session', async () => {
    mockRunAutofix.mockResolvedValue({
      success: false,
      summary: 'git commit failed (exit 1)',
    });

    const { pipeline, sessionManager } = makePipeline();
    const result = await pipeline.run(JOB, PROJECT);

    expect(result.passed).toBe(false);
    expect(sessionManager.sendOrResume).toHaveBeenCalledOnce();
    const [, message] = sessionManager.sendOrResume.mock.calls[0];
    expect(message).toMatch(/Autofix Gate Failure/);
    expect(queries.setPRReviewResult).toHaveBeenCalledWith(
      42,
      'owner/repo',
      expect.stringContaining('autofix_failed'),
    );
  });
});
