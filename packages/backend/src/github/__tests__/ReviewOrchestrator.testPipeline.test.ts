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
const mockLoadAutofixCommands = vi.fn().mockReturnValue([]);
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: (...args: unknown[]) => mockLoadAutofixCommands(...args),
  runAutofix: (...args: unknown[]) => mockRunAutofix(...args),
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

// autofix-runner mock — controllable per-test for the overlap regression test below
const mockRunAutofix = vi
  .fn()
  .mockResolvedValue({ success: true, summary: 'no diff' });

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
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: (...args: unknown[]) =>
    mockLoadOrchestratorConfig(...args),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { ReviewOrchestrator } from '../ReviewOrchestrator';
import { getPRByNumber, getSession } from '../../db/queries';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
      sessionId: null,
      runOrigin: 'pr_pipeline',
      producer: 'pr_gate',
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
      sessionId: null,
      runOrigin: 'pr_pipeline',
      producer: 'pr_gate',
    });
  });
});

describe('ReviewOrchestrator.runTestPipeline — inFlightPRKeys visibility', () => {
  it('reports isReviewInFlight true while runTestPipeline is executing, false once it settles', async () => {
    let sawInFlight = false;
    mockRunProjectTestRequest.mockImplementationOnce(async () => {
      sawInFlight = orch.isReviewInFlight(9, 'org/repo');
      return { passed: true, output: 'ok' };
    });

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    expect(orch.isReviewInFlight(9, 'org/repo')).toBe(false);

    await orch.runTestPipeline(
      9,
      'org/repo',
      'sha-inflight',
      '/worktree',
      ['npm test'],
      300,
    );

    expect(sawInFlight).toBe(true);
    expect(orch.isReviewInFlight(9, 'org/repo')).toBe(false);
  });

  it('stays in-flight for a PR while runAutofixPipeline and runTestPipeline overlap, and only clears once both settle', async () => {
    mockGetProjectByGithubRepo.mockReturnValue(PROJECT);
    mockLoadAutofixCommands.mockReturnValue(['npm run lint']);
    vi.mocked(getPRByNumber).mockReturnValue({
      session_id: 'sess-1',
      base_branch: 'dev',
    } as any);
    vi.mocked(getSession).mockReturnValue({
      worktree_path: '/worktree',
    } as any);

    const autofixGate = deferred<{ success: boolean; summary: string }>();
    mockRunAutofix.mockImplementationOnce(() => autofixGate.promise);

    const testGate = deferred<{ passed: boolean; output: string }>();
    mockRunProjectTestRequest.mockImplementationOnce(() => testGate.promise);

    const sm = makeSessionManager();
    const rs = makeReviewService();
    const orch = new ReviewOrchestrator(rs, sm, true);

    const autofixDone = orch.runAutofixPipeline(9, 'org/repo', null);
    const testsDone = orch.runTestPipeline(
      9,
      'org/repo',
      'sha-overlap',
      '/worktree',
      ['npm test'],
      300,
    );

    // Let both calls run past their synchronous setup and acquire the shared
    // in-flight key before either gate resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.isReviewInFlight(9, 'org/repo')).toBe(true);

    // The autofix pipeline finishes first — with ref-counting, the shared
    // key must stay in-flight because the test pipeline is still running.
    autofixGate.resolve({ success: true, summary: 'done' });
    await autofixDone;
    expect(orch.isReviewInFlight(9, 'org/repo')).toBe(true);

    // Only once the last holder releases does the key clear.
    testGate.resolve({ passed: true, output: 'ok' });
    await testsDone;
    expect(orch.isReviewInFlight(9, 'org/repo')).toBe(false);
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
      sessionId: null,
      runOrigin: 'pr_pipeline',
      producer: 'pr_gate',
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
