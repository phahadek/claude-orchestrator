import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../PRFileReverter', () => ({ syncToOrigin: vi.fn() }));
vi.mock('../DiffSource', () => ({
  GitHubDiffSource: vi.fn(),
  LocalDiffSource: vi.fn(),
}));
vi.mock('../reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockReturnValue(''),
  formatCIFailureFeedback: vi.fn(),
}));
vi.mock('../../orchestration/verifyRunner', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../session/filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: vi.fn().mockReturnValue([]),
  runAutofix: vi.fn().mockResolvedValue({ success: true, summary: 'no diff' }),
}));
vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn(),
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: { session_mode: 'cli', auto_review_concurrency: 1 },
}));

// DB queries mock — includes new test-result functions
const mockHasTestResultForSha = vi.fn().mockReturnValue(false);
const mockUpsertTestResult = vi.fn();

vi.mock('../../db/queries', () => ({
  getPRByNumber: vi.fn(),
  getSession: vi.fn(),
  getLocalBranchBySession: vi.fn().mockReturnValue(null),
  setPRReviewResult: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  setPendingPush: vi.fn(),
  setPauseReason: vi.fn(),
  addAutofixSha: vi.fn(),
  consumeAutofixSha: vi.fn().mockReturnValue(false),
  insertPendingReviewSync: vi.fn(),
  deletePendingReviewSync: vi.fn(),
  getAllPendingReviewSyncs: vi.fn().mockReturnValue([]),
  setLocalBranchPauseReason: vi.fn(),
  hasTestResultForSha: () => mockHasTestResultForSha(),
  upsertTestResult: (...args: unknown[]) => mockUpsertTestResult(...args),
}));

// test-runner mock
const mockRunTestCommands = vi
  .fn()
  .mockResolvedValue({ passed: true, output: 'ok' });

vi.mock('../../session/test-runner', () => ({
  runTestCommands: (...args: unknown[]) => mockRunTestCommands(...args),
}));

// orchestrator-config mock — returns test commands when configured
const mockLoadOrchestratorConfig = vi.fn().mockReturnValue({
  mcp_servers: undefined,
  allowed_tools: [],
  verify: [],
  autofix: [],
  ci_check_name: [],
  bash_rules: [],
  bootstrap_script: '',
  test: [],
  test_timeout_sec: 300,
  test_max_rss_mb: 0,
  test_fail_fast: true,
});

vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: (...args: unknown[]) =>
    mockLoadOrchestratorConfig(...args),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { ReviewOrchestrator } from '../ReviewOrchestrator';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  const sm = new EventEmitter() as any;
  sm.sendOrResume = vi.fn().mockResolvedValue('session-id');
  return sm;
}

function makeReviewService() {
  return {
    reviewPR: vi.fn().mockResolvedValue({
      verdict: 'approved',
      summary: 'Looks good',
      dimensions: [],
    }),
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockHasTestResultForSha.mockReturnValue(false);
  mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
  mockLoadOrchestratorConfig.mockReturnValue({
    mcp_servers: undefined,
    allowed_tools: [],
    verify: [],
    autofix: [],
    ci_check_name: [],
    bash_rules: [],
    bootstrap_script: '',
    test: [],
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
});

describe('ReviewOrchestrator.runTestPipeline — empty test commands', () => {
  it('is a no-op when commands array is empty', async () => {
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      1,
      'owner/repo',
      'sha-abc',
      '/worktree',
      [],
      300,
    );

    expect(mockRunTestCommands).not.toHaveBeenCalled();
    expect(mockUpsertTestResult).not.toHaveBeenCalled();
  });

  it('is a no-op when headSha is empty', async () => {
    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      1,
      'owner/repo',
      '',
      '/worktree',
      ['npm test'],
      300,
    );

    expect(mockRunTestCommands).not.toHaveBeenCalled();
    expect(mockUpsertTestResult).not.toHaveBeenCalled();
  });
});

describe('ReviewOrchestrator.runTestPipeline — dedup on unchanged SHA', () => {
  it('skips execution when a result already exists for the SHA', async () => {
    mockHasTestResultForSha.mockReturnValue(true);

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      42,
      'org/repo',
      'sha-unchanged',
      '/worktree',
      ['npm test'],
      300,
    );

    expect(mockRunTestCommands).not.toHaveBeenCalled();
    expect(mockUpsertTestResult).not.toHaveBeenCalled();
  });

  it('does run when the SHA has no prior result', async () => {
    mockHasTestResultForSha.mockReturnValue(false);

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      42,
      'org/repo',
      'sha-new',
      '/worktree',
      ['npm test'],
      300,
    );

    expect(mockRunTestCommands).toHaveBeenCalledOnce();
  });
});

describe('ReviewOrchestrator.runTestPipeline — re-run on new SHA', () => {
  it('runs tests and persists for sha-A, then runs again for sha-B', async () => {
    // First SHA — no prior result
    mockHasTestResultForSha.mockReturnValueOnce(false);
    mockRunTestCommands.mockResolvedValueOnce({
      passed: true,
      output: 'pass-A',
    });

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      1,
      'org/repo',
      'sha-A',
      '/worktree',
      ['npm test'],
      300,
    );

    expect(mockUpsertTestResult).toHaveBeenCalledWith(
      1,
      'org/repo',
      'sha-A',
      true,
      'pass-A',
    );

    vi.clearAllMocks();
    mockHasTestResultForSha.mockReturnValueOnce(false);
    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'fail-B',
    });

    // Second SHA — also no prior result → runs again
    await orch.runTestPipeline(
      1,
      'org/repo',
      'sha-B',
      '/worktree',
      ['npm test'],
      300,
    );

    expect(mockRunTestCommands).toHaveBeenCalledOnce();
    expect(mockUpsertTestResult).toHaveBeenCalledWith(
      1,
      'org/repo',
      'sha-B',
      false,
      'fail-B',
    );
  });
});

describe('ReviewOrchestrator.runTestPipeline — persistence', () => {
  it('persists passed:true and output when commands pass', async () => {
    mockHasTestResultForSha.mockReturnValue(false);
    mockRunTestCommands.mockResolvedValue({
      passed: true,
      output: 'test output',
    });

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      7,
      'myorg/myrepo',
      'sha-xyz',
      '/work',
      ['npm test'],
      60,
    );

    expect(mockUpsertTestResult).toHaveBeenCalledWith(
      7,
      'myorg/myrepo',
      'sha-xyz',
      true,
      'test output',
    );
  });

  it('persists passed:false when commands fail', async () => {
    mockHasTestResultForSha.mockReturnValue(false);
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'FAILED' });

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      7,
      'myorg/myrepo',
      'sha-xyz',
      '/work',
      ['npm test'],
      60,
    );

    expect(mockUpsertTestResult).toHaveBeenCalledWith(
      7,
      'myorg/myrepo',
      'sha-xyz',
      false,
      'FAILED',
    );
  });

  it('passes worktreePath and timeoutSec to runTestCommands', async () => {
    mockHasTestResultForSha.mockReturnValue(false);

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    await orch.runTestPipeline(
      1,
      'org/repo',
      'sha-123',
      '/my/worktree',
      ['vitest run'],
      120,
    );

    expect(mockRunTestCommands).toHaveBeenCalledWith(
      '/my/worktree',
      ['vitest run'],
      120,
      expect.any(Function),
      { maxRssMb: 0, failFast: true },
    );
  });
});
