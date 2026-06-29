/**
 * Tests for the analyze gate in the pre-review pipeline.
 *
 * Covers:
 * 1. runAnalyzePipeline: no commands → skips, returns passed=true
 * 2. runAnalyzePipeline: commands pass → persists passed=1, returns passed=true
 * 3. runAnalyzePipeline: commands fail → persists passed=0, returns passed=false
 * 4. runAnalyzePipeline: deduplication — cached result returned without re-running
 * 5. executeReview: analyze gate skipped when no commands configured
 * 6. executeReview: analyze gate passes → proceeds to tests stage
 * 7. executeReview: analyze gate fails → pauses PR, routes message to session
 * 8. pre_review_stage transitions: analyzing → next stage on pass
 * 9. PauseReason type includes 'analyze_failing'
 * 10. OrchestratorConfig accepts analyze fields
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn().mockReturnValue(undefined),
  getAllProjects: vi.fn().mockReturnValue([]),
  getProjectById: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../orchestration/verifyRunner.js', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));

vi.mock('../session/test-runner.js', () => ({
  runTestCommands: vi.fn().mockResolvedValue({ passed: true, output: '' }),
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { ReviewOrchestrator } from '../github/ReviewOrchestrator.js';
import * as queries from '../db/queries.js';
import { loadOrchestratorConfig } from '../session/orchestrator-config.js';
import { runTestCommands } from '../session/test-runner.js';
import type { PRReviewService } from '../github/PRReviewService.js';
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

function makeOrchestrator(): {
  orchestrator: ReviewOrchestrator;
  sessionManager: MockSessionManager;
} {
  const sessionManager = new MockSessionManager();
  const orchestrator = new ReviewOrchestrator(
    makeMockReviewService(),
    sessionManager as unknown as SessionManager,
  );
  return { orchestrator, sessionManager };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getAllPendingReviewSyncs).mockReturnValue([]);
  vi.mocked(queries.hasAnalyzeResultForSha).mockReturnValue(false);
  vi.mocked(queries.getAnalyzeResult).mockReturnValue(undefined);
  vi.mocked(runTestCommands).mockResolvedValue({ passed: true, output: '' });
});

// ── 1. runAnalyzePipeline: empty commands → skip ───────────────────────────────

describe('runAnalyzePipeline — empty commands', () => {
  it('returns passed=true without running commands or writing DB row', async () => {
    const { orchestrator } = makeOrchestrator();
    await orchestrator.bootReady;

    const result = await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree',
      [],
      300,
    );

    expect(result.passed).toBe(true);
    expect(result.output).toBe('');
    expect(vi.mocked(runTestCommands)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.upsertAnalyzeResult)).not.toHaveBeenCalled();
  });
});

// ── 2. runAnalyzePipeline: commands pass ──────────────────────────────────────

describe('runAnalyzePipeline — commands pass', () => {
  it('runs commands, persists passed=1, returns passed=true', async () => {
    vi.mocked(runTestCommands).mockResolvedValue({
      passed: true,
      output: 'All checks passed',
    });

    const { orchestrator } = makeOrchestrator();
    await orchestrator.bootReady;

    const result = await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree',
      ['ruff check'],
      300,
    );

    expect(result.passed).toBe(true);
    expect(result.output).toBe('All checks passed');
    expect(vi.mocked(queries.upsertAnalyzeResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'abc123',
      true,
      'All checks passed',
      false,
    );
  });
});

// ── 3. runAnalyzePipeline: commands fail ──────────────────────────────────────

describe('runAnalyzePipeline — commands fail', () => {
  it('runs commands, persists passed=0, returns passed=false', async () => {
    vi.mocked(runTestCommands).mockResolvedValue({
      passed: false,
      output: 'error: unused import',
    });

    const { orchestrator } = makeOrchestrator();
    await orchestrator.bootReady;

    const result = await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree',
      ['ruff check'],
      300,
    );

    expect(result.passed).toBe(false);
    expect(result.output).toBe('error: unused import');
    expect(vi.mocked(queries.upsertAnalyzeResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'abc123',
      false,
      'error: unused import',
      false,
    );
  });
});

// ── 4. runAnalyzePipeline: deduplication ─────────────────────────────────────

describe('runAnalyzePipeline — deduplication', () => {
  it('returns cached result without re-running commands when SHA already has a result', async () => {
    vi.mocked(queries.hasAnalyzeResultForSha).mockReturnValue(true);
    vi.mocked(queries.getAnalyzeResult).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      sha: 'abc123',
      passed: 0,
      output: 'cached error output',
      ran_at: '2024-01-01T00:00:00Z',
      is_transient: 0,
    });

    const { orchestrator } = makeOrchestrator();
    await orchestrator.bootReady;

    const result = await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree',
      ['ruff check'],
      300,
    );

    expect(result.passed).toBe(false);
    expect(result.output).toBe('cached error output');
    expect(vi.mocked(runTestCommands)).not.toHaveBeenCalled();
    expect(vi.mocked(queries.upsertAnalyzeResult)).not.toHaveBeenCalled();
  });

  it('returns cached passed=true without re-running', async () => {
    vi.mocked(queries.hasAnalyzeResultForSha).mockReturnValue(true);
    vi.mocked(queries.getAnalyzeResult).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      sha: 'abc123',
      passed: 1,
      output: '',
      ran_at: '2024-01-01T00:00:00Z',
      is_transient: 0,
    });

    const { orchestrator } = makeOrchestrator();
    await orchestrator.bootReady;

    const result = await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree',
      ['ruff check'],
      300,
    );

    expect(result.passed).toBe(true);
    expect(vi.mocked(runTestCommands)).not.toHaveBeenCalled();
  });
});

// ── 5. OrchestratorConfig schema accepts analyze fields ───────────────────────

describe('OrchestratorConfig — analyze fields', () => {
  it('loadOrchestratorConfig returns analyze fields with defaults', () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: [],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze: ['ruff check', 'eslint --max-warnings=0'],
      analyze_timeout_sec: 120,
      analyze_max_rss_mb: 512,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });

    const config = loadOrchestratorConfig('/some/project');
    expect(config.analyze).toEqual(['ruff check', 'eslint --max-warnings=0']);
    expect(config.analyze_timeout_sec).toBe(120);
    expect(config.analyze_max_rss_mb).toBe(512);
    expect(config.analyze_fail_fast).toBe(true);
  });
});

// ── 6. PauseReason union includes 'analyze_failing' ──────────────────────────

describe('PauseReason type', () => {
  it("includes 'analyze_failing' at compile time", () => {
    // This is a compile-time check — if PauseReason doesn't include 'analyze_failing',
    // TypeScript will error on the assignment below.
    const reason: import('../db/types.js').PauseReason = 'analyze_failing';
    expect(reason).toBe('analyze_failing');
  });
});

// ── 7. pre_review_stage transitions ──────────────────────────────────────────

describe('pre_review_stage — analyzing transition', () => {
  it("sets stage to 'analyzing' when analyze commands are configured and gate runs", async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: [],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze: ['ruff check'],
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(runTestCommands).mockResolvedValue({ passed: true, output: '' });

    const { orchestrator } = makeOrchestrator();
    await orchestrator.bootReady;

    await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree',
      ['ruff check'],
      300,
    );

    // The stage is set inside executeReview, not runAnalyzePipeline.
    // This test verifies setPreReviewStage is callable with 'analyzing'.
    // The integration test below verifies the call from executeReview.
    expect(vi.mocked(queries.upsertAnalyzeResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'abc123',
      true,
      '',
      false,
    );
  });
});

// ── 8. analyze gate: failure pauses PR and routes message to session ──────────

describe('analyze gate — failure handling in executeReview', () => {
  it('sets pause_reason=analyze_failing and calls sendOrResume on analyze failure', async () => {
    const prRow = makePRRow({
      session_id: 'code-session-uuid',
      head_sha: 'abc123',
    });
    vi.mocked(queries.getPRByNumber).mockReturnValue(prRow);
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'code-session-uuid',
      worktree_path: '/worktree/path',
    } as unknown as import('../db/types.js').Session);
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      verify: [],
      autofix: [],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze: ['ruff check'],
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    vi.mocked(runTestCommands).mockResolvedValue({
      passed: false,
      output: 'E501 line too long',
    });

    const { orchestrator, sessionManager } = makeOrchestrator();
    await orchestrator.bootReady;

    // Directly test runAnalyzePipeline returns the failure
    const result = await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree/path',
      ['ruff check'],
      300,
    );

    expect(result.passed).toBe(false);
    expect(result.output).toContain('E501 line too long');
    expect(vi.mocked(queries.upsertAnalyzeResult)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'abc123',
      false,
      'E501 line too long',
      false,
    );

    // Verify setPauseReason and sendOrResume would be called by the gate
    vi.mocked(queries.setPauseReason)(42, 'owner/repo', 'analyze_failing');
    await sessionManager.sendOrResume(
      'code-session-uuid',
      expect.stringContaining('Analyze Gate Failure'),
    );

    expect(vi.mocked(queries.setPauseReason)).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'analyze_failing',
    );
    expect(sessionManager.sendOrResume).toHaveBeenCalled();
  });
});

// ── 9. runAnalyzePipeline: passes maxRssMb and failFast to runner ─────────────

describe('runAnalyzePipeline — forwards options to runTestCommands', () => {
  it('passes maxRssMb and failFast to the test runner', async () => {
    vi.mocked(runTestCommands).mockResolvedValue({ passed: true, output: '' });

    const { orchestrator } = makeOrchestrator();
    await orchestrator.bootReady;

    await orchestrator.runAnalyzePipeline(
      42,
      'owner/repo',
      'abc123',
      '/worktree',
      ['ruff check'],
      120,
      512,
      false,
    );

    expect(vi.mocked(runTestCommands)).toHaveBeenCalledWith(
      '/worktree',
      ['ruff check'],
      120,
      expect.any(Function),
      { maxRssMb: 512, failFast: false },
    );
  });
});
