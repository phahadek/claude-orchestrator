/**
 * A settled test run hands the session's held <pr-body> to
 * AgentSession.openHeldPullRequest — with the passed tree's hash only when
 * the run genuinely passed — before the completion feedback is enqueued.
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
    await importOriginal<
      typeof import('../../orchestration/runTestOutcomes')
    >();
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

const PROJECT_ID = 'proj-test-request-held-pr-body';

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
    test: ['npm test'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-1');
  mockGetChangedFiles.mockResolvedValue([]);
  mockGetRunTestOutcomes.mockResolvedValue({
    incomplete: false,
    failingTests: [],
    totals: { passed: 1, failed: 0, skipped: 0, errors: 0, total: 1 },
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
  typedSetSetting('test_request_cycle_limit', 10);
  setStagedIntentBroadcast(() => {});
});

async function runWith(
  runResult: Record<string, unknown>,
  state: 'passed' | 'failed',
) {
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
  const runId = 'run-held-1';
  insertTestRequestRun(runId, PROJECT_ID, 'hash-1', 'sess-1', Date.now());
  completeTestRequestRun(runId, state, 'out');
  mockAdmitTestRequest.mockReturnValue({
    runId,
    status: 'running',
    position: 0,
    queueDepth: 0,
    reused: false,
    result: Promise.resolve({ output: 'out', runId, ...runResult }),
  });
  const openHeldPullRequest = vi.fn().mockResolvedValue(undefined);
  const enqueueFeedback = vi.fn().mockResolvedValue(undefined);
  await triggerTestRequestExecution(intent, {
    enqueueFeedback,
    getLiveSession: () => ({ openHeldPullRequest }),
  } as unknown as SessionManager);
  return { openHeldPullRequest, enqueueFeedback };
}

describe('triggerTestRequestExecution — held PR body', () => {
  it('hands the passed tree hash to the live session before enqueueing feedback', async () => {
    const { openHeldPullRequest, enqueueFeedback } = await runWith(
      { passed: true },
      'passed',
    );
    expect(openHeldPullRequest).toHaveBeenCalledWith('hash-1');
    expect(enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(openHeldPullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueFeedback.mock.invocationCallOrder[0],
    );
  });

  it('passes null (clearing the hold) for a failed run', async () => {
    const { openHeldPullRequest } = await runWith({ passed: false }, 'failed');
    expect(openHeldPullRequest).toHaveBeenCalledWith(null);
  });

  it('passes null for a superseded run', async () => {
    const { openHeldPullRequest } = await runWith(
      { passed: false, superseded: true },
      'failed',
    );
    expect(openHeldPullRequest).toHaveBeenCalledWith(null);
  });

  it('passes null for a cancelled run', async () => {
    const { openHeldPullRequest } = await runWith(
      { passed: false, cancelled: true },
      'failed',
    );
    expect(openHeldPullRequest).toHaveBeenCalledWith(null);
  });
});
