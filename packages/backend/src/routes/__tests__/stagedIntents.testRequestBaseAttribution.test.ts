/**
 * Base-attributable-failures exemption for session_test_request_cycles —
 * see baseAttribution.ts. maybeAutoApproveTestRequest skips the cycle-count
 * charge when the run that prompted this test.request cycle failed for a
 * confirmed base-attributable reason: an iterate-on-red loop forced entirely
 * by a broken base branch must not burn this budget. Unlike
 * stalled_pr_retry_count/flake_recovery_attempts, no reset primitive exists
 * for this counter — an already-exhausted session always requires a fresh
 * dispatch (verified below: this exemption never resets, only skips future
 * charges).
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
  mockRunProjectTestRequest,
  mockIsRunFailureBaseAttributable,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockRunProjectTestRequest: vi.fn(),
  mockIsRunFailureBaseAttributable: vi.fn(),
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
  runProjectTestRequest: mockRunProjectTestRequest,
}));

vi.mock('../../orchestration/baseAttribution', () => ({
  isRunFailureBaseAttributable: mockIsRunFailureBaseAttributable,
}));

import { db } from '../../db/db';
import { stageIntent, routeStageTimeBlock } from '../stagedIntents';
import {
  insertSession,
  updateSessionWorktreePath,
  insertTestRequestRun,
  completeTestRequestRun,
  getSessionTestRequestCycleCount,
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';

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

function stageTestRequest(sessionId: string) {
  return stageIntent(
    'test.request',
    { taskId: 'task-1', reason: 'confirm the fix' },
    'proj-1',
    null,
    sessionId,
  );
}

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockRunProjectTestRequest.mockReset();
  mockIsRunFailureBaseAttributable.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();
  db.prepare('DELETE FROM test_request_runs').run();

  mockGetProjectById.mockReturnValue({ id: 'proj-1', projectDir: '/proj' });
  mockLoadOrchestratorConfig.mockReturnValue({
    test: ['npm test'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-1');
  mockRunProjectTestRequest.mockResolvedValue({
    runId: 'run-new',
    passed: true,
    output: 'ok',
  });
  typedSetSetting('test_request_cycle_limit', 3);
});

describe('session_test_request_cycles base-attributable-failures exemption', () => {
  it('does not increment the cycle counter when the prior failing run is confirmed base-attributable', async () => {
    mockIsRunFailureBaseAttributable.mockResolvedValue(true);
    setUpSession('session-base-fail');
    insertTestRequestRun(
      'run-1',
      'proj-1',
      'hash-0',
      'session-base-fail',
      Date.now(),
    );
    completeTestRequestRun('run-1', 'failed', 'boom');

    const intent = stageTestRequest('session-base-fail');
    await routeStageTimeBlock(intent, undefined);

    expect(getSessionTestRequestCycleCount('session-base-fail')).toBe(0);
  });

  it('increments the cycle counter normally when the prior failing run is not base-attributable', async () => {
    mockIsRunFailureBaseAttributable.mockResolvedValue(false);
    setUpSession('session-own-fail');
    insertTestRequestRun(
      'run-2',
      'proj-1',
      'hash-0',
      'session-own-fail',
      Date.now(),
    );
    completeTestRequestRun('run-2', 'failed', 'boom');

    const intent = stageTestRequest('session-own-fail');
    await routeStageTimeBlock(intent, undefined);

    expect(getSessionTestRequestCycleCount('session-own-fail')).toBe(1);
  });

  it('increments the cycle counter when there is no prior run at all (nothing to attribute)', async () => {
    setUpSession('session-first-cycle');

    const intent = stageTestRequest('session-first-cycle');
    await routeStageTimeBlock(intent, undefined);

    expect(getSessionTestRequestCycleCount('session-first-cycle')).toBe(1);
    expect(mockIsRunFailureBaseAttributable).not.toHaveBeenCalled();
  });

  it('has no reset primitive: a session already exhausted before base-attributability was confirmed stays exhausted (a fresh dispatch is required)', async () => {
    mockIsRunFailureBaseAttributable.mockResolvedValue(false);
    setUpSession('session-exhausted');
    for (let i = 0; i < 3; i++) {
      const intent = stageTestRequest('session-exhausted');
      await routeStageTimeBlock(intent, undefined);
    }
    expect(getSessionTestRequestCycleCount('session-exhausted')).toBe(3);

    // Even once a later cycle's prior failure is confirmed base-attributable
    // (so this 4th cycle itself would not have been charged), the count
    // accumulated before that confirmation is never rolled back.
    mockIsRunFailureBaseAttributable.mockResolvedValue(true);
    insertTestRequestRun(
      'run-3',
      'proj-1',
      'hash-1',
      'session-exhausted',
      Date.now(),
    );
    completeTestRequestRun('run-3', 'failed', 'boom');
    const overLimit = stageTestRequest('session-exhausted');
    const checked = await routeStageTimeBlock(overLimit, undefined);

    expect(checked.state).toBe('staged'); // paused, not auto-run
    expect(getSessionTestRequestCycleCount('session-exhausted')).toBe(3);
  });
});
