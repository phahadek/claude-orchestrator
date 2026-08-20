/**
 * completeTestRequestRun (queries.ts) writes test_request_runs.state from
 * the raw test result, before filterBaseAttributableFailures ever runs.
 * When that filter fully excuses a raw failure (outcome filtered_pass),
 * triggerTestRequestExecution must also flip the stored run's state to
 * 'passed' — otherwise AgentSession's test_request_gate PR check, which
 * reads that same stored row, keeps blocking PR creation even though the
 * session's failures were entirely base-attributable/flaky.
 *
 * A genuinely-failing run (filter outcome 'unfiltered', passed: false)
 * must leave the stored state as 'failed'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const {
  mockGetProjectById,
  mockLoadOrchestratorConfig,
  mockComputeHash,
  mockAdmitTestRequest,
  mockFilterBaseAttributableFailures,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockAdmitTestRequest: vi.fn(),
  mockFilterBaseAttributableFailures: vi.fn(),
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

vi.mock('../../orchestration/baseAttributableFilter', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../orchestration/baseAttributableFilter')
  >();
  return {
    ...actual,
    filterBaseAttributableFailures: mockFilterBaseAttributableFailures,
  };
});

import { db } from '../../db/db';
import {
  stageIntent,
  setStagedIntentBroadcast,
  triggerTestRequestExecution,
  type StagedIntent,
} from '../stagedIntents';
import {
  insertSession,
  updateSessionWorktreePath,
  insertTestRequestRun,
  completeTestRequestRun,
  getTestRequestRunById,
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';

const PROJECT_ID = 'proj-test-request-gate-filtered-pass';

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

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockAdmitTestRequest.mockReset();
  mockFilterBaseAttributableFailures.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();
  db.prepare('DELETE FROM test_request_runs').run();

  mockGetProjectById.mockReturnValue({ id: PROJECT_ID, projectDir: '/proj' });
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

describe('triggerTestRequestExecution — test_request_gate state consistency', () => {
  it("flips the stored run's state to 'passed' when the base-attribution filter reports filtered_pass", async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-filtered-pass';
    seedRawFailedRun(runId);

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
    mockFilterBaseAttributableFailures.mockResolvedValue({
      outcome: 'filtered_pass',
      passed: true,
      excludedTests: [{ test_id: 't1', name: 'flaky test' }],
      flakyExcludedTests: [],
      remainingTests: [],
    });

    await triggerTestRequestExecution(intent, undefined);

    const row = getTestRequestRunById(runId);
    expect(row?.state).toBe('passed');
  });

  it('leaves the stored run state as failed for a genuinely-failing (unfiltered) run', async () => {
    setUpSession('sess-1');
    const intent = stageTestRequest('sess-1') as StagedIntent;
    const runId = 'run-genuine-fail';
    seedRawFailedRun(runId);

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
    mockFilterBaseAttributableFailures.mockResolvedValue({
      outcome: 'unfiltered',
      passed: false,
      excludedTests: [],
      flakyExcludedTests: [],
      remainingTests: [{ test_id: 't1', name: 'real failure' }],
    });

    await triggerTestRequestExecution(intent, undefined);

    const row = getTestRequestRunById(runId);
    expect(row?.state).toBe('failed');
  });
});
