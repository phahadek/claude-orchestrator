import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mockGetPRByNumber = vi.fn();
const mockSetPauseReason = vi.fn();
const mockSetPreReviewStage = vi.fn();
const mockHasAnalyzeResultForSha = vi.fn().mockReturnValue(false);
const mockUpsertAnalyzeResult = vi.fn();
const mockGetAnalyzeResult = vi.fn().mockReturnValue(null);
const mockGetAnalyzeContentCacheResult = vi.fn().mockReturnValue(undefined);
const mockInsertAnalyzeContentCacheResult = vi.fn();
const mockIncrementFlake = vi.fn();
const mockResetFlake = vi.fn();

vi.mock('../../db/queries', () => ({
  getSetting: () => null,
  getPRByNumber: (...a: unknown[]) => mockGetPRByNumber(...a),
  getSession: () => ({ session_id: 's', worktree_path: '/wt' }),
  setPRReviewResult: vi.fn(),
  setLastReviewedSha: vi.fn(),
  setPreReviewStage: (...a: unknown[]) => mockSetPreReviewStage(...a),
  setPauseReason: (...a: unknown[]) => mockSetPauseReason(...a),
  clearPauseReasonEntry: vi.fn(),
  getLatestTestRequestRun: vi.fn(),
  hasAnalyzeResultForSha: (...a: unknown[]) => mockHasAnalyzeResultForSha(...a),
  upsertAnalyzeResult: (...a: unknown[]) => mockUpsertAnalyzeResult(...a),
  getAnalyzeResult: (...a: unknown[]) => mockGetAnalyzeResult(...a),
  deleteAnalyzeResult: vi.fn(),
  getAnalyzeContentCacheResult: (...a: unknown[]) =>
    mockGetAnalyzeContentCacheResult(...a),
  insertAnalyzeContentCacheResult: (...a: unknown[]) =>
    mockInsertAnalyzeContentCacheResult(...a),
  incrementFlakeRecoveryAttempts: (...a: unknown[]) => mockIncrementFlake(...a),
  resetFlakeRecoveryAttempts: (...a: unknown[]) => mockResetFlake(...a),
  addAutofixSha: vi.fn(),
  getTestRequestRunById: vi.fn(),
  getTestRequestRunOutput: () => '',
  updateTestRequestRunState: vi.fn(),
  getFailingTestIdsForRun: () => [],
  getUnexcusedFailingTestIdsForRun: () => [],
}));

const mockComputeTriggerContentHash = vi.fn().mockResolvedValue(null);
vi.mock('../../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/analyzeGating')>();
  return {
    ...actual,
    computeTriggerContentHash: (...a: unknown[]) =>
      mockComputeTriggerContentHash(...a),
    computeWholeTreeContentHash: vi.fn().mockResolvedValue('h'),
  };
});

vi.mock('../../orchestration/testRequestLane', () => ({
  admitTestRequest: vi.fn(),
  commandsCovered: () => true,
  insertExcusedVerifyCoverageRun: vi.fn(),
  LaneDbLockError: class LaneDbLockError extends Error {},
}));
vi.mock('../../orchestration/verifyRunner', () => ({
  runVerifyAsGate: vi.fn().mockResolvedValue({ passed: true }),
  tailOfLog: (s: string) => s,
}));
vi.mock('../../orchestration/baseAttributableFilter', () => ({
  filterBaseAttributableFailuresForF2Gate: vi.fn(),
  filterVerifyFailureByBaseHealth: vi.fn(),
  renderBaseAttributableFilterDigest: vi.fn(),
}));
vi.mock('../../orchestration/gitConfigIntegrity', () => ({
  validateAndRepairGitConfig: vi
    .fn()
    .mockResolvedValue({ healthy: true, repaired: false }),
}));
const mockGetChangedFiles = vi.fn().mockResolvedValue([]);
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: () => [],
  runAutofix: vi.fn(),
  getChangedFiles: (...a: unknown[]) => mockGetChangedFiles(...a),
  getHeadSha: vi.fn().mockResolvedValue('abc123def456'),
}));
const mockRunTestCommands = vi.fn();
vi.mock('../../session/test-runner', () => ({
  runTestCommands: (...a: unknown[]) => mockRunTestCommands(...a),
}));
vi.mock('../../session/filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));
const mockLoadConfig = vi.fn();
vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: (...a: unknown[]) => mockLoadConfig(...a),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../orchestration/combinedTree', () => ({
  resolveCombinedTree: vi
    .fn()
    .mockResolvedValue({ status: 'error', detail: 'n/a' }),
  createGateScratchTree: vi.fn(),
  readHeadOids: vi.fn().mockResolvedValue({ headSha: 'x', headTree: 'y' }),
}));
vi.mock('../conflictNudge', () => ({ sendConflictNudge: vi.fn() }));

import { PreReviewPipeline } from '../PreReviewPipeline';
import { __resetAnalyzeSemaphoreForTest } from '../analyzeSemaphore';
import type { ReviewJob } from '../types';

const HEAD = 'abc123def456';
const HEAP_OUTPUT =
  'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory';

const job: ReviewJob = {
  prNumber: 42,
  repo: 'org/repo',
  taskId: 't',
  taskUrl: 'u',
  contextUrl: 'c',
};
const project = { id: 'p', projectDir: '/project', contextUrl: 'c' } as any;

let attempts = 0;
function makeSm() {
  const sm = new EventEmitter() as any;
  sm.sendOrResume = vi.fn().mockResolvedValue('s');
  sm.emit = vi.fn();
  return sm;
}
function setConfig(analyze: unknown[] = ['pyright']) {
  mockLoadConfig.mockReturnValue({
    verify: [],
    autofix: [],
    analyze,
    test: [],
    analyze_timeout_sec: 300,
    analyze_max_rss_mb: 0,
    analyze_fail_fast: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAnalyzeSemaphoreForTest();
  attempts = 0;
  mockIncrementFlake.mockImplementation(() => {
    attempts++;
  });
  mockGetPRByNumber.mockImplementation(() => ({
    pr_number: 42,
    repo: 'org/repo',
    session_id: 's',
    head_sha: HEAD,
    base_branch: 'dev',
    flake_recovery_attempts: attempts,
  }));
  mockHasAnalyzeResultForSha.mockReturnValue(false);
  mockGetAnalyzeResult.mockReturnValue(null);
  mockGetAnalyzeContentCacheResult.mockReturnValue(undefined);
  mockComputeTriggerContentHash.mockResolvedValue(null);
  mockGetChangedFiles.mockResolvedValue([]);
  setConfig();
});

describe('analyze gate — transient failure recovery', () => {
  it.each([
    ['JavaScript heap out of memory', 'JavaScript heap out of memory', {}],
    [
      'Ineffective mark-compacts near heap limit',
      'Ineffective mark-compacts near heap limit',
      {},
    ],
    ['timeout', 'killed', { timedOut: true }],
    ['oom-kill', 'killed', { oomKilled: true }],
  ])('records is_transient=1 for %s', async (_n, output, flags) => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output,
      ...flags,
    });
    await new PreReviewPipeline(makeSm()).run(job, project);
    expect(mockUpsertAnalyzeResult.mock.calls[0][5]).toBe(true);
  });

  it('records is_transient=1 for a configured transient_output_patterns match', async () => {
    setConfig([{ command: 'x', transient_output_patterns: ['ECONNRESET'] }]);
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: 'ECONNRESET',
    });
    await new PreReviewPipeline(makeSm()).run(job, project);
    expect(mockUpsertAnalyzeResult.mock.calls[0][5]).toBe(true);
  });

  it('re-runs a heap OOM on the same head without messaging the session, and proceeds when it passes', async () => {
    mockRunTestCommands
      .mockResolvedValueOnce({ passed: false, output: HEAP_OUTPUT })
      .mockResolvedValueOnce({ passed: true, output: 'ok' });
    const sm = makeSm();
    const result = await new PreReviewPipeline(sm).run(job, project);

    expect(mockIncrementFlake).toHaveBeenCalledTimes(1);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
    expect(sm.sendOrResume).not.toHaveBeenCalled();
    expect(mockSetPauseReason).not.toHaveBeenCalled();
    expect(result.passed).toBe(true);
  });

  it('after the retry budget, sends one infrastructure message and pauses with a non-automatic reason', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: HEAP_OUTPUT,
    });
    const sm = makeSm();
    const result = await new PreReviewPipeline(sm).run(job, project);

    expect(result.passed).toBe(false);
    expect(mockIncrementFlake).toHaveBeenCalledTimes(2);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(3);
    expect(sm.sendOrResume).toHaveBeenCalledTimes(1);
    const msg = sm.sendOrResume.mock.calls[0][1] as string;
    expect(msg).toContain('heap');
    expect(msg).toContain('No push is expected');
    expect(mockSetPauseReason).toHaveBeenCalledWith(
      42,
      'org/repo',
      'analyze_infra_failure',
      undefined,
    );
  });

  it('routes a real failure to the session with no orchestrator re-run', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: 'error: type mismatch',
    });
    const sm = makeSm();
    await new PreReviewPipeline(sm).run(job, project);

    expect(mockIncrementFlake).not.toHaveBeenCalled();
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);
    expect(sm.sendOrResume).toHaveBeenCalledWith(
      's',
      expect.stringContaining('Analyze Gate Failure'),
    );
  });

  it('re-runs a cached transient failure from the stored row', async () => {
    mockHasAnalyzeResultForSha.mockReturnValue(true);
    mockGetAnalyzeResult.mockReturnValue({
      passed: 0,
      output: HEAP_OUTPUT,
      is_transient: 1,
    });
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    const sm = makeSm();
    const result = await new PreReviewPipeline(sm).run(job, project);
    expect(mockIncrementFlake).toHaveBeenCalledTimes(1);
    expect(sm.sendOrResume).not.toHaveBeenCalled();
    expect(result.passed).toBe(true);
  });
});

describe('analyze gate — content cache', () => {
  beforeEach(() => {
    setConfig([{ command: 'x', trigger_paths: ['pkg.json'] }]);
    mockGetChangedFiles.mockResolvedValue(['pkg.json']);
    mockComputeTriggerContentHash.mockResolvedValue('hash');
  });

  it('does not cache a transient failure', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: HEAP_OUTPUT,
    });
    await new PreReviewPipeline(makeSm()).run(job, project);
    expect(mockInsertAnalyzeContentCacheResult).not.toHaveBeenCalled();
  });

  it('still caches a non-transient failure', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: 'real error',
    });
    await new PreReviewPipeline(makeSm()).run(job, project);
    expect(mockInsertAnalyzeContentCacheResult).toHaveBeenCalledWith(
      'x',
      'hash',
      false,
      'real error',
    );
  });
});
