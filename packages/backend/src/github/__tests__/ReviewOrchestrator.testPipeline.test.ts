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

const PROJECT = { id: 'proj-1', projectDir: '/project' };
const mockGetProjectByGithubRepo = vi.fn().mockReturnValue(PROJECT);
vi.mock('../../config', () => ({
  getProjectByGithubRepo: (...args: unknown[]) =>
    mockGetProjectByGithubRepo(...args),
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: { session_mode: 'cli', auto_review_concurrency: 1 },
}));

// DB queries mock — includes the shared F2 content-hash cache read
const mockGetLatestTestRequestRun = vi.fn().mockReturnValue(undefined);

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
  setPreReviewStage: vi.fn(),
  setLastReviewedSha: vi.fn(),
  hasAnalyzeResultForSha: vi.fn().mockReturnValue(false),
  upsertAnalyzeResult: vi.fn(),
  getAnalyzeResult: vi.fn().mockReturnValue(null),
  getLatestTestRequestRun: (...args: unknown[]) =>
    mockGetLatestTestRequestRun(...args),
}));

// analyzeGating mock — deterministic whole-tree content hash
const mockComputeWholeTreeContentHash = vi
  .fn()
  .mockResolvedValue('worktree-content-hash');
vi.mock('../../session/analyzeGating', () => ({
  computeWholeTreeContentHash: (...args: unknown[]) =>
    mockComputeWholeTreeContentHash(...args),
  computeTriggerContentHash: vi.fn().mockResolvedValue(null),
}));

// test-runner mock — used only on the "no content hash" fallback path
const mockRunTestCommands = vi
  .fn()
  .mockResolvedValue({ passed: true, output: 'ok' });

vi.mock('../../session/test-runner', () => ({
  runTestCommands: (...args: unknown[]) => mockRunTestCommands(...args),
}));

// test.request lane mock — the shared execution path runTestPipeline uses
// on a cache miss when a content hash is available
const mockRunProjectTestRequest = vi
  .fn()
  .mockResolvedValue({ passed: true, output: 'ok' });
vi.mock('../../orchestration/testRequestLane', () => ({
  runProjectTestRequest: (...args: unknown[]) =>
    mockRunProjectTestRequest(...args),
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
  analyze: [],
  analyze_timeout_sec: 300,
  analyze_max_rss_mb: 0,
  analyze_fail_fast: true,
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
  mockGetProjectByGithubRepo.mockReturnValue(PROJECT);
  mockGetLatestTestRequestRun.mockReturnValue(undefined);
  mockComputeWholeTreeContentHash.mockResolvedValue('worktree-content-hash');
  mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
  mockRunProjectTestRequest.mockResolvedValue({ passed: true, output: 'ok' });
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
    analyze: [],
    analyze_timeout_sec: 300,
    analyze_max_rss_mb: 0,
    analyze_fail_fast: true,
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

    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
    expect(mockRunTestCommands).not.toHaveBeenCalled();
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

    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
    expect(mockRunTestCommands).not.toHaveBeenCalled();
  });
});

describe('ReviewOrchestrator.runTestPipeline — dedup on content hash', () => {
  it('skips execution when the content hash already has a cached result', async () => {
    mockGetLatestTestRequestRun.mockReturnValue({
      id: 'run-1',
      project_id: 'proj-1',
      content_hash: 'worktree-content-hash',
      state: 'passed',
      output: 'cached',
      started_at: 1000,
      finished_at: 2000,
    });

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

    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
    expect(mockRunTestCommands).not.toHaveBeenCalled();
  });

  it('does run when the content hash has no prior result', async () => {
    mockGetLatestTestRequestRun.mockReturnValue(undefined);

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

    expect(mockRunProjectTestRequest).toHaveBeenCalledOnce();
  });
});

describe('ReviewOrchestrator.runTestPipeline — re-run on new content hash', () => {
  it('runs tests and shares the cache key for hash-A, then runs again for hash-B', async () => {
    // First content hash — no prior result
    mockComputeWholeTreeContentHash.mockResolvedValueOnce('hash-A');
    mockGetLatestTestRequestRun.mockReturnValueOnce(undefined);
    mockRunProjectTestRequest.mockResolvedValueOnce({
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

    expect(mockRunProjectTestRequest).toHaveBeenCalledWith({
      projectId: 'proj-1',
      contentHash: 'hash-A',
      worktreePath: '/worktree',
      commands: ['npm test'],
      timeoutSec: 300,
      maxRssMb: 0,
      failFast: true,
    });

    vi.clearAllMocks();
    mockGetProjectByGithubRepo.mockReturnValue(PROJECT);
    mockComputeWholeTreeContentHash.mockResolvedValueOnce('hash-B');
    mockGetLatestTestRequestRun.mockReturnValueOnce(undefined);
    mockRunProjectTestRequest.mockResolvedValueOnce({
      passed: false,
      output: 'fail-B',
    });

    // Second content hash — also no prior result → runs again
    await orch.runTestPipeline(
      1,
      'org/repo',
      'sha-B',
      '/worktree',
      ['npm test'],
      300,
    );

    expect(mockRunProjectTestRequest).toHaveBeenCalledOnce();
    expect(mockRunProjectTestRequest).toHaveBeenCalledWith({
      projectId: 'proj-1',
      contentHash: 'hash-B',
      worktreePath: '/worktree',
      commands: ['npm test'],
      timeoutSec: 300,
      maxRssMb: 0,
      failFast: true,
    });
  });
});

describe('ReviewOrchestrator.runTestPipeline — persistence via the shared lane', () => {
  it('runs via runProjectTestRequest, which durably persists into the shared cache', async () => {
    mockRunProjectTestRequest.mockResolvedValue({
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

    expect(mockRunProjectTestRequest).toHaveBeenCalledWith({
      projectId: 'proj-1',
      contentHash: 'worktree-content-hash',
      worktreePath: '/work',
      commands: ['npm test'],
      timeoutSec: 60,
      maxRssMb: 0,
      failFast: true,
    });
  });

  it('falls back to a direct runTestCommands run when no content hash is available', async () => {
    mockComputeWholeTreeContentHash.mockResolvedValue(null);
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

    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
    expect(mockRunTestCommands).toHaveBeenCalledWith(
      '/work',
      ['npm test'],
      60,
      expect.any(Function),
      { maxRssMb: 0, failFast: true },
    );
  });
});
