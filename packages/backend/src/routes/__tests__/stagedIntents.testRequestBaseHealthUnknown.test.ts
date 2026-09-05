/**
 * Reproduces the observed defect: a session's failed test.request run,
 * measured against a base branch whose health is `unknown` (no usable
 * probe for the current content hash), must not collapse to a plain
 * unfiltered failure. It must:
 *  - carry a distinct `unknown` outcome in the staged_intent_disposition
 *    audit payload (queryable, not silently omitted like `unfiltered`),
 *  - mirror `inconclusive`'s retry-budget treatment (decremented, not
 *    charged) while remaining a separately identifiable outcome,
 *  - never mark the run as passing or flip test_request_runs.state, so
 *    the PR gate stays closed,
 *  - route a "base health unavailable" digest into the session's enqueued
 *    feedback `output` field, not a bare raw failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const {
  mockGetProjectById,
  mockLoadOrchestratorConfig,
  mockComputeHash,
  mockAdmitTestRequest,
  mockFilterBaseAttributableFailuresForF2Gate,
  mockGetChangedFiles,
  mockCheckBaseBranchHealth,
  realFilterHolder,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockAdmitTestRequest: vi.fn(),
  mockFilterBaseAttributableFailuresForF2Gate: vi.fn(),
  mockGetChangedFiles: vi.fn(),
  mockCheckBaseBranchHealth: vi.fn(),
  realFilterHolder: {
    current: null as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>,
  },
}));

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return { ...actual, getProjectById: mockGetProjectById };
});

vi.mock('../../session/orchestrator-config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/orchestrator-config')>();
  return { ...actual, loadOrchestratorConfig: mockLoadOrchestratorConfig };
});

vi.mock('../../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/analyzeGating')>();
  return { ...actual, computeWholeTreeContentHash: mockComputeHash };
});

vi.mock('../../orchestration/testRequestLane', () => ({
  admitTestRequest: mockAdmitTestRequest,
}));

vi.mock(
  '../../orchestration/baseAttributableFilter',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../orchestration/baseAttributableFilter')
      >();
    realFilterHolder.current = actual.filterBaseAttributableFailuresForF2Gate as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    return {
      ...actual,
      filterBaseAttributableFailuresForF2Gate:
        mockFilterBaseAttributableFailuresForF2Gate,
    };
  },
);

vi.mock('../../orchestration/baseHealthCheck', () => ({
  checkBaseBranchHealth: mockCheckBaseBranchHealth,
  classifyRun: vi.fn(),
  classifyTestRunOutcome: vi.fn(),
  getBaseHealthWorktreePath: vi.fn(),
}));

vi.mock('../../session/autofix-runner', () => ({
  getChangedFiles: mockGetChangedFiles,
  expandAutofixCommand: vi.fn(),
}));

vi.mock('../../audit/baseHealthRemediationFiling', () => ({
  recordAndMaybeFileBaseHealthRemediation: vi.fn(async () => ({
    filed: false,
  })),
}));

import { db } from '../../db/db';
import {
  stageIntent,
  setStagedIntentBroadcast,
  triggerTestRequestExecution,
  type StagedIntent,
} from '../stagedIntents';
import type { SessionManager } from '../../session/SessionManager';
import {
  insertSession,
  updateSessionWorktreePath,
  insertTestRequestRun,
  completeTestRequestRun,
  getTestRequestRunById,
  incrementSessionTestRequestCycleCount,
  getSessionTestRequestCycleCount,
  insertTestRunResults,
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';

const PROJECT_ID = 'proj-test-request-base-health-unknown';

function setUpSession(sessionId: string) {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: Date.now(),
  });
  updateSessionWorktreePath(sessionId, '/tmp/wt');
}

function makeSessionManager(): SessionManager & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  }) as unknown as SessionManager & EventEmitter;
}

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockAdmitTestRequest.mockReset();
  mockFilterBaseAttributableFailuresForF2Gate.mockReset();
  mockFilterBaseAttributableFailuresForF2Gate.mockImplementation(
    (...args: unknown[]) => realFilterHolder.current(...args),
  );
  mockCheckBaseBranchHealth.mockReset();
  mockCheckBaseBranchHealth.mockResolvedValue({
    outcome: 'unknown',
    projectId: PROJECT_ID,
    contentHash: null,
    cacheHit: false,
    run: null,
  });
  mockGetChangedFiles.mockReset();
  mockGetChangedFiles.mockResolvedValue([]);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM audit_log').run();

  mockGetProjectById.mockReturnValue({
    id: PROJECT_ID,
    projectDir: '/proj',
    baseBranch: 'main',
  });
  mockLoadOrchestratorConfig.mockReturnValue({
    test: ['npm test'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-1');
  typedSetSetting('test_request_cycle_limit', 10);
  setStagedIntentBroadcast(() => {});
});

function stageTestRequest(sessionId: string) {
  return stageIntent(
    'test.request',
    { taskId: 'task-1', reason: 'confirm the fix' },
    PROJECT_ID,
    null,
    sessionId,
  );
}

function seedRawFailedRun(runId: string) {
  insertTestRequestRun(runId, PROJECT_ID, 'hash-1', 'sess-1', Date.now());
  completeTestRequestRun(runId, 'failed', 'some tests failed');
}

function mockAdmission(runId: string) {
  mockAdmitTestRequest.mockReturnValue({
    runId,
    status: 'running',
    position: 0,
    queueDepth: 0,
    reused: false,
    result: Promise.resolve({
      passed: false,
      output: 'some tests failed',
      runId,
    }),
  });
}

describe('triggerTestRequestExecution — unknown base-health outcome', () => {
  it('does not mark the run as passing and leaves test_request_runs.state failed (PR gate stays closed)', async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-unknown-1';
    seedRawFailedRun(runId);
    mockAdmission(runId);
    mockFilterBaseAttributableFailuresForF2Gate.mockResolvedValue({
      result: {
        outcome: 'unknown',
        passed: false,
        excludedTests: [],
        flakyExcludedTests: [],
        remainingTests: [],
        baseRun: null,
      },
      guardBlocked: [],
    });

    await triggerTestRequestExecution(intent, undefined);

    const row = getTestRequestRunById(runId);
    expect(row?.state).toBe('failed');
  });

  it("mirrors inconclusive's retry-budget treatment (decremented) while remaining a separately identifiable outcome in the audit record", async () => {
    setUpSession('sess-1');
    incrementSessionTestRequestCycleCount('sess-1');
    incrementSessionTestRequestCycleCount('sess-1');
    const beforeCount = getSessionTestRequestCycleCount('sess-1');

    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-unknown-2';
    seedRawFailedRun(runId);
    mockAdmission(runId);
    mockFilterBaseAttributableFailuresForF2Gate.mockResolvedValue({
      result: {
        outcome: 'unknown',
        passed: false,
        excludedTests: [],
        flakyExcludedTests: [],
        remainingTests: [],
        baseRun: null,
      },
      guardBlocked: [],
    });

    await triggerTestRequestExecution(intent, undefined);

    expect(getSessionTestRequestCycleCount('sess-1')).toBe(beforeCount - 1);

    const disposition = db
      .prepare(
        "SELECT payload FROM audit_log WHERE event_type = 'staged_intent_disposition' ORDER BY id DESC LIMIT 1",
      )
      .get() as { payload: string } | undefined;
    expect(disposition).toBeDefined();
    const payload = JSON.parse(disposition!.payload);
    expect(payload.baseAttributableFilterOutcome).toBe('unknown');
    expect(payload.baseAttributableFilterOutcome).not.toBe('inconclusive');
  });

  it("routes an unknown-outcome digest into the session's enqueued feedback output field instead of a bare raw failure", async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-unknown-3';
    seedRawFailedRun(runId);
    mockAdmission(runId);
    mockFilterBaseAttributableFailuresForF2Gate.mockResolvedValue({
      result: {
        outcome: 'unknown',
        passed: false,
        excludedTests: [],
        flakyExcludedTests: [],
        remainingTests: [],
        baseRun: null,
      },
      guardBlocked: [],
    });

    const sessionManager = makeSessionManager();
    await triggerTestRequestExecution(intent, sessionManager);

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [, , payloadJson] = (
      sessionManager.enqueueFeedback as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const payload = JSON.parse(payloadJson as string);
    expect(payload.output).toMatch(/base health.*unavailable/i);
    expect(payload.output).not.toBe('some tests failed');
    expect(payload.passed).toBe(false);
  });

  it("lists the run's own failing tests in the digest when the filter result carries them under the unknown outcome", async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-unknown-4';
    seedRawFailedRun(runId);
    mockAdmission(runId);
    mockFilterBaseAttributableFailuresForF2Gate.mockResolvedValue({
      result: {
        outcome: 'unknown',
        passed: false,
        excludedTests: [],
        flakyExcludedTests: [],
        remainingTests: [{ test_id: 'suite.testA', name: 'testA' }],
        baseRun: null,
      },
      guardBlocked: [],
    });

    const sessionManager = makeSessionManager();
    await triggerTestRequestExecution(intent, sessionManager);

    const [, , payloadJson] = (
      sessionManager.enqueueFeedback as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    const payload = JSON.parse(payloadJson as string);
    expect(payload.output).toMatch(/base health.*unavailable/i);
    expect(payload.output).toContain('suite.testA');
    expect(payload.output).toMatch(
      /not counted against your test-request budget/i,
    );
    expect(payload.passed).toBe(false);
  });
});

function seedBaseRun(
  runId: string,
  failing: { test_id: string; name: string }[],
) {
  insertTestRequestRun(runId, PROJECT_ID, 'base-hash', 'sess-base', Date.now());
  completeTestRequestRun(runId, 'failed', 'some tests failed on base');
  insertTestRunResults(
    runId,
    PROJECT_ID,
    failing.map((t) => ({
      test_id: t.test_id,
      name: t.name,
      outcome: 'failed',
      duration_ms: 1,
      failureMessage: 'boom',
      failureTraceExcerpt: 'trace excerpt',
    })),
    null,
    false,
  );
}

function mockPartialFailBaseHealth(baseRunId: string) {
  mockCheckBaseBranchHealth.mockResolvedValue({
    outcome: 'partial_fail',
    projectId: PROJECT_ID,
    contentHash: 'base-hash',
    cacheHit: true,
    run: getTestRequestRunById(baseRunId),
  });
}

describe('triggerTestRequestExecution — f2 gate masking guards on the session path', () => {
  it('blocks an exclusion for a test whose file appears in the session changed-file list, leaving the run failed', async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-guard-touched';
    seedRawFailedRun(runId);
    insertTestRunResults(
      runId,
      PROJECT_ID,
      [
        {
          test_id: 'mymodule.testA',
          name: 'testA',
          outcome: 'failed',
          duration_ms: 1,
          failureMessage: 'boom',
          failureTraceExcerpt: 'trace excerpt',
        },
      ],
      null,
      false,
    );
    seedBaseRun('run-guard-touched-base', [
      { test_id: 'mymodule.testA', name: 'testA' },
    ]);
    mockPartialFailBaseHealth('run-guard-touched-base');
    mockGetChangedFiles.mockResolvedValue(['mymodule.ts']);
    mockAdmission(runId);

    await triggerTestRequestExecution(intent, undefined);

    expect(getTestRequestRunById(runId)?.state).toBe('failed');
  });

  it('still clears — and rewrites the run to passed — for a test that fails identically on base in a file the session did not touch', async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-guard-untouched';
    seedRawFailedRun(runId);
    insertTestRunResults(
      runId,
      PROJECT_ID,
      [
        {
          test_id: 'mymodule.testA',
          name: 'testA',
          outcome: 'failed',
          duration_ms: 1,
          failureMessage: 'boom',
          failureTraceExcerpt: 'trace excerpt',
        },
      ],
      null,
      false,
    );
    seedBaseRun('run-guard-untouched-base', [
      { test_id: 'mymodule.testA', name: 'testA' },
    ]);
    mockPartialFailBaseHealth('run-guard-untouched-base');
    mockGetChangedFiles.mockResolvedValue(['unrelated/file.ts']);
    mockAdmission(runId);

    await triggerTestRequestExecution(intent, undefined);

    expect(getTestRequestRunById(runId)?.state).toBe('passed');
  });

  it("leaves the run failed when the session's changed files cannot be determined", async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-guard-unknown-diff';
    seedRawFailedRun(runId);
    insertTestRunResults(
      runId,
      PROJECT_ID,
      [
        {
          test_id: 'mymodule.testA',
          name: 'testA',
          outcome: 'failed',
          duration_ms: 1,
          failureMessage: 'boom',
          failureTraceExcerpt: 'trace excerpt',
        },
      ],
      null,
      false,
    );
    seedBaseRun('run-guard-unknown-diff-base', [
      { test_id: 'mymodule.testA', name: 'testA' },
    ]);
    mockPartialFailBaseHealth('run-guard-unknown-diff-base');
    mockGetChangedFiles.mockRejectedValue(new Error('git diff failed'));
    mockAdmission(runId);

    await triggerTestRequestExecution(intent, undefined);

    expect(getTestRequestRunById(runId)?.state).toBe('failed');
    expect(mockFilterBaseAttributableFailuresForF2Gate).not.toHaveBeenCalled();
  });

  it('records the excluded, flaky-excluded and guard-blocked test ids and counts in the staged_intent_disposition payload', async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-guard-payload';
    seedRawFailedRun(runId);
    mockAdmission(runId);
    mockFilterBaseAttributableFailuresForF2Gate.mockResolvedValue({
      result: {
        outcome: 'filtered_partial',
        passed: false,
        excludedTests: [{ test_id: 'suite.t1', name: 't1' }],
        flakyExcludedTests: [{ test_id: 'suite.t2', name: 't2' }],
        remainingTests: [{ test_id: 'suite.t3', name: 't3' }],
        baseRun: null,
      },
      guardBlocked: [{ test_id: 'suite.t3', name: 't3' }],
    });

    await triggerTestRequestExecution(intent, undefined);

    const disposition = db
      .prepare(
        "SELECT payload FROM audit_log WHERE event_type = 'staged_intent_disposition' ORDER BY id DESC LIMIT 1",
      )
      .get() as { payload: string } | undefined;
    expect(disposition).toBeDefined();
    const payload = JSON.parse(disposition!.payload);
    expect(payload.excludedTestCount).toBe(1);
    expect(payload.excludedTestIds).toEqual(['suite.t1']);
    expect(payload.flakyExcludedTestCount).toBe(1);
    expect(payload.flakyExcludedTestIds).toEqual(['suite.t2']);
    expect(payload.guardBlockedTestCount).toBe(1);
    expect(payload.guardBlockedTestIds).toEqual(['suite.t3']);
  });
});
