import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockGetPRByNumber = vi.fn();
const mockGetSession = vi.fn();
const mockSetPRReviewResult = vi.fn();
const mockSetLastReviewedSha = vi.fn();
const mockSetPreReviewStage = vi.fn();
const mockSetPauseReason = vi.fn();
const mockHasTestResultForSha = vi.fn().mockReturnValue(false);
const mockUpsertTestResult = vi.fn();
const mockHasAnalyzeResultForSha = vi.fn().mockReturnValue(false);
const mockUpsertAnalyzeResult = vi.fn();
const mockGetAnalyzeResult = vi.fn().mockReturnValue(null);
const mockAddAutofixSha = vi.fn();

vi.mock('../../db/queries', () => ({
  getPRByNumber: (...args: unknown[]) => mockGetPRByNumber(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  setPRReviewResult: (...args: unknown[]) => mockSetPRReviewResult(...args),
  setLastReviewedSha: (...args: unknown[]) => mockSetLastReviewedSha(...args),
  setPreReviewStage: (...args: unknown[]) => mockSetPreReviewStage(...args),
  setPauseReason: (...args: unknown[]) => mockSetPauseReason(...args),
  hasTestResultForSha: (...args: unknown[]) => mockHasTestResultForSha(...args),
  upsertTestResult: (...args: unknown[]) => mockUpsertTestResult(...args),
  hasAnalyzeResultForSha: (...args: unknown[]) =>
    mockHasAnalyzeResultForSha(...args),
  upsertAnalyzeResult: (...args: unknown[]) => mockUpsertAnalyzeResult(...args),
  getAnalyzeResult: (...args: unknown[]) => mockGetAnalyzeResult(...args),
  addAutofixSha: (...args: unknown[]) => mockAddAutofixSha(...args),
}));

const mockRunVerifyAsGate = vi.fn().mockResolvedValue({ passed: true });
vi.mock('../../orchestration/verifyRunner', () => ({
  runVerifyAsGate: (...args: unknown[]) => mockRunVerifyAsGate(...args),
}));

const mockLoadAutofixCommands = vi.fn().mockReturnValue([]);
const mockRunAutofix = vi
  .fn()
  .mockResolvedValue({ success: true, summary: 'ok', commitSha: null });
vi.mock('../../session/autofix-runner', () => ({
  loadAutofixCommands: (...args: unknown[]) => mockLoadAutofixCommands(...args),
  runAutofix: (...args: unknown[]) => mockRunAutofix(...args),
}));

const mockRunTestCommands = vi
  .fn()
  .mockResolvedValue({ passed: true, output: '' });
vi.mock('../../session/test-runner', () => ({
  runTestCommands: (...args: unknown[]) => mockRunTestCommands(...args),
}));

const mockRunFilePollutionCheck = vi
  .fn()
  .mockResolvedValue({ revertCommitSha: null });
vi.mock('../../session/filePollutionCheck', () => ({
  runFilePollutionCheck: (...args: unknown[]) =>
    mockRunFilePollutionCheck(...args),
}));

const mockLoadOrchestratorConfig = vi.fn().mockReturnValue({
  verify: [],
  autofix: [],
  analyze: [],
  test: [],
  test_timeout_sec: 300,
  test_max_rss_mb: 0,
  test_fail_fast: true,
  analyze_timeout_sec: 300,
  analyze_max_rss_mb: 0,
  analyze_fail_fast: true,
  ci_check_name: [],
  allowed_tools: [],
  bash_rules: [],
  bootstrap_script: '',
});
vi.mock('../../session/orchestrator-config', () => ({
  loadOrchestratorConfig: (...args: unknown[]) =>
    mockLoadOrchestratorConfig(...args),
}));

const mockRecordEvent = vi.fn();
vi.mock('../../audit/AuditLog', () => ({
  recordEvent: (...args: unknown[]) => mockRecordEvent(...args),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PreReviewPipeline } from '../PreReviewPipeline';
import type { ReviewJob } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PR_NUMBER = 42;
const REPO = 'org/repo';
const HEAD_SHA = 'abc123def456';
const WORKTREE = '/worktree/path';
const SESSION_ID = 'session-abc';

function makeProject() {
  return {
    id: 'proj-1',
    projectDir: '/project',
    contextUrl: 'https://notion.so/proj',
  } as any;
}

function makeJob(): ReviewJob {
  return {
    prNumber: PR_NUMBER,
    repo: REPO,
    taskId: 'task-1',
    taskUrl: 'https://notion.so/task',
    contextUrl: 'https://notion.so/proj',
  };
}

function makePRRow(overrides: Record<string, unknown> = {}) {
  return {
    pr_number: PR_NUMBER,
    repo: REPO,
    session_id: SESSION_ID,
    head_sha: HEAD_SHA,
    base_branch: 'dev',
    ...overrides,
  };
}

function makeSessionRow() {
  return { session_id: SESSION_ID, worktree_path: WORKTREE };
}

function makeSessionManager() {
  const sm = new EventEmitter() as any;
  sm.sendOrResume = vi.fn().mockResolvedValue(SESSION_ID);
  sm.addToRevertLock = vi.fn();
  sm.emit = vi.fn();
  return sm;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPRByNumber.mockReturnValue(makePRRow());
  mockGetSession.mockReturnValue(makeSessionRow());
  mockRunVerifyAsGate.mockResolvedValue({ passed: true });
  mockRunAutofix.mockResolvedValue({
    success: true,
    summary: 'ok',
    commitSha: null,
  });
  mockRunTestCommands.mockResolvedValue({ passed: true, output: '' });
  mockHasTestResultForSha.mockReturnValue(false);
  mockHasAnalyzeResultForSha.mockReturnValue(false);
  mockLoadAutofixCommands.mockReturnValue([]);
  mockLoadOrchestratorConfig.mockReturnValue({
    verify: [],
    autofix: [],
    analyze: [],
    test: [],
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
    analyze_timeout_sec: 300,
    analyze_max_rss_mb: 0,
    analyze_fail_fast: true,
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    bootstrap_script: '',
  });
});

describe('PreReviewPipeline.run — all stages skipped when no config', () => {
  it('returns passed:true when all stages are no-ops', async () => {
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(true);
    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'awaiting_review',
    );
  });
});

describe('PreReviewPipeline — autofix gate', () => {
  it('skips autofix when no commands configured', async () => {
    mockLoadAutofixCommands.mockReturnValue([]);
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(mockRunAutofix).not.toHaveBeenCalled();
  });

  it('runs autofix when commands configured and returns passed:true on success', async () => {
    mockLoadAutofixCommands.mockReturnValue(['npm run fix']);
    mockRunAutofix.mockResolvedValue({
      success: true,
      summary: 'fixed',
      commitSha: null,
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(true);
    expect(mockRunAutofix).toHaveBeenCalledOnce();
  });

  it('gates on autofix failure: sets setPRReviewResult + setLastReviewedSha + blocked stage + sendOrResume', async () => {
    mockLoadAutofixCommands.mockReturnValue(['npm run fix']);
    mockRunAutofix.mockResolvedValue({
      success: false,
      summary: 'fix broke',
      commitSha: null,
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(false);
    expect(mockSetPRReviewResult).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      expect.stringContaining('autofix_failed'),
    );
    expect(mockSetLastReviewedSha).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      HEAD_SHA,
    );
    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'blocked_autofix',
    );
    expect(sm.sendOrResume).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining('Autofix Gate Failure'),
    );
  });

  it('emits pr_review_blocked_by_gate with kind=autofix on failure', async () => {
    mockLoadAutofixCommands.mockReturnValue(['npm run fix']);
    mockRunAutofix.mockResolvedValue({
      success: false,
      summary: 'broke',
      commitSha: null,
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'pr_review_blocked_by_gate',
        kind: 'autofix',
      }),
    );
  });
});

describe('PreReviewPipeline — verify gate', () => {
  it('skips verify when no worktreePath', async () => {
    mockGetSession.mockReturnValue({
      session_id: SESSION_ID,
      worktree_path: '',
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(mockRunVerifyAsGate).not.toHaveBeenCalled();
  });

  it('gates on verify failure: canonical 5-step', async () => {
    mockRunVerifyAsGate.mockResolvedValue({
      passed: false,
      failedCommand: 'tsc',
      truncatedOutput: 'type error',
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(false);
    expect(mockSetPRReviewResult).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      expect.stringContaining('verify_failed'),
    );
    expect(mockSetLastReviewedSha).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      HEAD_SHA,
    );
    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'pr_review_blocked_by_gate',
        kind: 'verify',
      }),
    );
    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'blocked_verify',
    );
    expect(sm.sendOrResume).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining('CI Failure'),
    );
  });

  it('passes when verify succeeds', async () => {
    mockRunVerifyAsGate.mockResolvedValue({ passed: true });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(true);
    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'verify_pipeline_started' }),
    );
    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'verify_pipeline_complete' }),
    );
  });
});

describe('PreReviewPipeline — analyze gate (parity with autofix/verify)', () => {
  beforeEach(() => {
    mockLoadOrchestratorConfig.mockReturnValue({
      verify: [],
      autofix: [],
      analyze: ['eslint .'],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
  });

  it('skips analyze when no commands configured', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      verify: [],
      autofix: [],
      analyze: [],
      test: [],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(mockRunTestCommands).not.toHaveBeenCalled();
  });

  it('gates on analyze failure: canonical 5-step including setPRReviewResult + setLastReviewedSha (parity fix)', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: 'lint errors',
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(false);
    // Parity: these were missing before the extraction
    expect(mockSetPRReviewResult).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      expect.stringContaining('analyze_failed'),
    );
    expect(mockSetLastReviewedSha).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      HEAD_SHA,
    );
    // blocked_analyze stage (new stage value)
    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'blocked_analyze',
    );
    // pause_reason=analyze_failing (preserved from original)
    expect(mockSetPauseReason).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'analyze_failing',
    );
    // pr_review_blocked_by_gate with kind=analyze
    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'pr_review_blocked_by_gate',
        kind: 'analyze',
      }),
    );
    // sendOrResume with the failure message
    expect(sm.sendOrResume).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining('Analyze Gate Failure'),
    );
  });

  it('passes analyze and emits analyze_pipeline_started/complete events', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(true);
    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'analyze_pipeline_started' }),
    );
    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'analyze_pipeline_complete' }),
    );
  });

  it('uses cached analyze result when sha was already analyzed', async () => {
    mockHasAnalyzeResultForSha.mockReturnValue(true);
    mockGetAnalyzeResult.mockReturnValue({ passed: 1, output: 'cached ok' });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(true);
    expect(mockRunTestCommands).not.toHaveBeenCalled();
  });
});

describe('PreReviewPipeline — tests record stage (non-blocking)', () => {
  beforeEach(() => {
    mockLoadOrchestratorConfig.mockReturnValue({
      verify: [],
      autofix: [],
      analyze: [],
      test: ['npm test'],
      test_timeout_sec: 300,
      test_max_rss_mb: 0,
      test_fail_fast: true,
      analyze_timeout_sec: 300,
      analyze_max_rss_mb: 0,
      analyze_fail_fast: true,
      ci_check_name: [],
      allowed_tools: [],
      bash_rules: [],
      bootstrap_script: '',
    });
  });

  it('records test result and continues to awaiting_review even when tests fail', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: 'test failures',
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    const result = await pipeline.run(makeJob(), makeProject());

    expect(result.passed).toBe(true);
    expect(mockUpsertTestResult).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      HEAD_SHA,
      false,
      'test failures',
    );
    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'awaiting_review',
    );
  });

  it('does not call setPreReviewStage(blocked_tests) — tests is non-blocking', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'FAIL' });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    const calls = (mockSetPreReviewStage as ReturnType<typeof vi.fn>).mock
      .calls;
    const blockedCalls = calls.filter(
      ([, , stage]) => stage === 'blocked_tests',
    );
    expect(blockedCalls).toHaveLength(0);
  });

  it('skips tests when sha already has a result', async () => {
    mockHasTestResultForSha.mockReturnValue(true);
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(mockRunTestCommands).not.toHaveBeenCalled();
    expect(mockUpsertTestResult).not.toHaveBeenCalled();
  });
});

describe('PreReviewPipeline — stage transition sequence', () => {
  it('emits pipeline_stage_entered for verify when worktreePath is present', async () => {
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    const emittedTypes = (sm.emit as ReturnType<typeof vi.fn>).mock.calls
      .filter(([event]: [string]) => event === 'message')
      .map(([, msg]: [string, { type: string }]) => msg.type);

    // verify runs (skipIf only checks worktreePath, which is present)
    expect(emittedTypes).toContain('pipeline_stage_entered');
    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'awaiting_review',
    );
  });

  it('emits pipeline_stage_entered when verify stage runs', async () => {
    mockRunVerifyAsGate.mockResolvedValue({ passed: true });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'pipeline_stage_entered',
        stage: 'verify',
      }),
    );
    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'pipeline_stage_passed',
        stage: 'verify',
      }),
    );
  });

  it('emits pipeline_stage_failed and audit event on gate failure', async () => {
    mockRunVerifyAsGate.mockResolvedValue({
      passed: false,
      failedCommand: 'tsc',
      truncatedOutput: 'error',
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(sm.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'pipeline_stage_failed',
        stage: 'verify',
      }),
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'pipeline_stage_failed' }),
    );
  });
});

describe('PreReviewPipeline — setPreReviewStage transitions', () => {
  it('sets running stage before each active stage', async () => {
    mockRunVerifyAsGate.mockResolvedValue({ passed: true });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'verify',
    );
    expect(mockSetPreReviewStage).toHaveBeenCalledWith(
      PR_NUMBER,
      REPO,
      'awaiting_review',
    );
  });

  it('sets blocked_verify on verify failure, not awaiting_review', async () => {
    mockRunVerifyAsGate.mockResolvedValue({
      passed: false,
      failedCommand: 'tsc',
    });
    const sm = makeSessionManager();
    const pipeline = new PreReviewPipeline(sm);

    await pipeline.run(makeJob(), makeProject());

    const stages = (
      mockSetPreReviewStage as ReturnType<typeof vi.fn>
    ).mock.calls.map(([, , s]) => s);
    expect(stages).toContain('blocked_verify');
    expect(stages).not.toContain('awaiting_review');
  });
});
