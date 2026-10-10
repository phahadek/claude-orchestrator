/**
 * A failed run whose structured outcomes show zero failing tests (e.g. a
 * command that writes no JUnit report) must still deliver the failing
 * command and a line of the raw output to the session — not a bare
 * "N passed, 0 failed" digest.
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
  mockFilterBaseAttributableFailuresForF2Gate,
  mockGetChangedFiles,
  mockGetRunTestOutcomes,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockAdmitTestRequest: vi.fn(),
  mockFilterBaseAttributableFailuresForF2Gate: vi.fn(),
  mockGetChangedFiles: vi.fn(),
  mockGetRunTestOutcomes: vi.fn(),
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

vi.mock('../../orchestration/runTestOutcomes', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../orchestration/runTestOutcomes')>();
  return { ...actual, getRunTestOutcomes: mockGetRunTestOutcomes };
});

vi.mock(
  '../../orchestration/baseAttributableFilter',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../orchestration/baseAttributableFilter')
      >();
    return {
      ...actual,
      filterBaseAttributableFailuresForF2Gate:
        mockFilterBaseAttributableFailuresForF2Gate,
    };
  },
);

vi.mock('../../session/autofix-runner', () => ({
  getChangedFiles: mockGetChangedFiles,
  expandAutofixCommand: vi.fn(),
}));

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
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';
import type { SessionManager } from '../../session/SessionManager';

const PROJECT_ID = 'proj-test-request-run-failure-digest';

beforeEach(() => {
  vi.clearAllMocks();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();
  db.prepare('DELETE FROM test_request_runs').run();
  mockGetProjectById.mockReturnValue({ id: PROJECT_ID, projectDir: '/proj' });
  mockLoadOrchestratorConfig.mockReturnValue({
    test: ['uv run task test-static'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-1');
  mockGetChangedFiles.mockResolvedValue([]);
  typedSetSetting('test_request_cycle_limit', 10);
  setStagedIntentBroadcast(() => {});
});

describe('triggerTestRequestExecution — run failure outside structured report', () => {
  it('delivers the failed command and raw output line when outcomes show 0 failures', async () => {
    insertSession({
      session_id: 'sess-1',
      task_id: 'task-1',
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    updateSessionWorktreePath('sess-1', '/tmp/wt');
    const intent = stageIntent(
      'test.request',
      { taskId: 'task-1', reason: 'confirm' },
      PROJECT_ID,
      null,
      'sess-1',
    ) as StagedIntent;
    const runId = 'run-static-fail';
    insertTestRequestRun(runId, PROJECT_ID, 'hash-1', 'sess-1', Date.now());
    completeTestRequestRun(runId, 'failed', 'FAILED tests/test_audit.py::x');

    const output =
      'collected\nFAILED tests/test_audit.py::test_no_new_over_budget_files';
    mockAdmitTestRequest.mockReturnValue({
      runId,
      status: 'running',
      position: 0,
      queueDepth: 0,
      reused: false,
      result: Promise.resolve({
        passed: false,
        output,
        runId,
        failedCommand: 'uv run task test-static',
      }),
    });
    mockFilterBaseAttributableFailuresForF2Gate.mockResolvedValue({
      result: {
        outcome: 'unfiltered',
        passed: false,
        excludedTests: [],
        flakyExcludedTests: [],
        remainingTests: [],
        baseRun: null,
      },
      guardBlocked: [],
    });
    mockGetRunTestOutcomes.mockResolvedValue({
      incomplete: true,
      failingTests: [],
      totals: { passed: 14805, failed: 0, skipped: 2, errors: 0, total: 14807 },
    });

    const enqueueFeedback = vi.fn().mockResolvedValue(undefined);
    await triggerTestRequestExecution(intent, {
      enqueueFeedback,
    } as unknown as SessionManager);

    expect(enqueueFeedback).toHaveBeenCalledTimes(1);
    const body = JSON.parse(enqueueFeedback.mock.calls[0][2] as string);
    expect(body.passed).toBe(false);
    expect(body.output).toContain('14805 passed, 0 failed');
    expect(body.output).toContain('uv run task test-static');
    expect(body.output).toContain('test_no_new_over_budget_files');
  });
});
