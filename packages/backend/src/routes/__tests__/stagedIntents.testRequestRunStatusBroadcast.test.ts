/**
 * test_request_run_status is a new, separate WS channel from
 * staged_intent_changed — see stagedIntents.testRequestDecisionSurface.test.ts
 * for the latter's decision-surface gate, which withholds a test.request
 * intent for its entire `approved` phase. This broadcast must fire on the
 * same lane run regardless: run-started (`running`) and run-completed
 * (`passed` / `failed-with-cause`), independent of that visibility rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockGetProjectById, mockLoadOrchestratorConfig, mockComputeHash } =
  vi.hoisted(() => ({
    mockGetProjectById: vi.fn(),
    mockLoadOrchestratorConfig: vi.fn(),
    mockComputeHash: vi.fn(),
  }));

const { mockRunTestCommands } = vi.hoisted(() => ({
  mockRunTestCommands: vi.fn(),
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

// The real testRequestLane runs, but its actual subprocess dependency is
// mocked out — this is what lets a real run-started/run-completed lifecycle
// fire through the real broadcast wiring under test.
vi.mock('../../session/test-runner', () => ({
  runTestCommands: mockRunTestCommands,
}));

vi.mock('../../orchestration/memoryAdmission', () => ({
  hasTestRequestAdmission: () => true,
}));

import { db } from '../../db/db';
import {
  stageIntent,
  routeStageTimeBlock,
  setStagedIntentBroadcast,
} from '../stagedIntents';
import { setTestRequestLaneBroadcast } from '../../orchestration/testRequestLane';
import {
  insertSession,
  updateSessionWorktreePath,
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';
import type { ServerMessage } from '../../ws/types';

const PROJECT_ID = 'proj-test-request-run-status';

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
    PROJECT_ID,
    null,
    sessionId,
  );
}

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockRunTestCommands.mockReset();
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
  setTestRequestLaneBroadcast(() => {});
});

describe('test_request_run_status broadcast — decoupled from decision-surface visibility', () => {
  it('fires running then passed while staged_intent_changed stays silent for the approved intent', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    setUpSession('session-1');

    const intentBroadcast = vi.fn();
    const runStatusBroadcast = vi.fn();
    setStagedIntentBroadcast(intentBroadcast);
    setTestRequestLaneBroadcast(runStatusBroadcast);

    const intent = stageTestRequest('session-1');
    const checked = await routeStageTimeBlock(intent, undefined);
    expect(checked.state).toBe('approved');

    await vi.waitFor(() => {
      expect(runStatusBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'test_request_run_status',
          status: 'passed',
        }),
      );
    });

    const statuses = runStatusBroadcast.mock.calls.map(
      (call: [ServerMessage]) =>
        (call[0] as { status: string }).status,
    );
    expect(statuses).toEqual(['running', 'passed']);

    // The intent itself sat at `approved` for the whole lane run — the
    // decision-surface gate must never have let staged_intent_changed carry
    // that state, even though it does fire on the surrounding staged/
    // committed transitions.
    const intentStates = intentBroadcast.mock.calls.map(
      (call: [{ intent: { state: string } }]) => call[0].intent.state,
    );
    expect(intentStates).not.toContain('approved');
  });

  it('fires failed-with-cause on a failing run, still without a staged_intent_changed broadcast', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'boom' });
    setUpSession('session-2');

    const intentBroadcast = vi.fn();
    const runStatusBroadcast = vi.fn();
    setStagedIntentBroadcast(intentBroadcast);
    setTestRequestLaneBroadcast(runStatusBroadcast);

    const intent = stageTestRequest('session-2');
    await routeStageTimeBlock(intent, undefined);

    await vi.waitFor(() => {
      expect(runStatusBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'test_request_run_status',
          status: 'failed-with-cause',
          output: 'boom',
        }),
      );
    });

    const intentStates = intentBroadcast.mock.calls.map(
      (call: [{ intent: { state: string } }]) => call[0].intent.state,
    );
    expect(intentStates).not.toContain('approved');
  });
});
