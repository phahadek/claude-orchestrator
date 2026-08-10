/**
 * Stage-time mechanical auto-grant for test.request — routeStageTimeBlock's
 * maybeAutoApproveTestRequest. Unlike gate.accrete/seed.stage's own-payload
 * content match, this never trusts a session-asserted claim: it recomputes a
 * project-scoped whole-tree content hash off the requesting session's live
 * worktree. Also covers the per-session cycle-counter escalation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockGetProjectById, mockLoadOrchestratorConfig, mockComputeHash, mockRunProjectTestRequest } =
  vi.hoisted(() => ({
    mockGetProjectById: vi.fn(),
    mockLoadOrchestratorConfig: vi.fn(),
    mockComputeHash: vi.fn(),
    mockRunProjectTestRequest: vi.fn(),
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

import { db } from '../../db/db';
import { stageIntent, routeStageTimeBlock } from '../stagedIntents';
import { insertSession, updateSessionWorktreePath } from '../../db/queries';
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
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();

  mockGetProjectById.mockReturnValue({ id: 'proj-1', projectDir: '/proj' });
  mockLoadOrchestratorConfig.mockReturnValue({
    test: ['npm test'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-1');
  mockRunProjectTestRequest.mockResolvedValue({ passed: true, output: 'ok' });
  typedSetSetting('test_request_cycle_limit', 3);
});

describe('test.request stage-time auto-grant (routeStageTimeBlock)', () => {
  it('auto-transitions staged -> approved for a project with test: configured on a matching content-hash', async () => {
    setUpSession('session-1');
    const intent = stageTestRequest('session-1');
    expect(intent.state).toBe('staged');

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('approved');
    expect(mockComputeHash).toHaveBeenCalledWith('/tmp/wt');
  });

  it('leaves the intent staged when the project has no test: commands configured', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test: [],
      test_timeout_sec: 60,
      test_max_rss_mb: 0,
      test_fail_fast: true,
    });
    setUpSession('session-2');
    const intent = stageTestRequest('session-2');

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('staged');
    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
  });

  it('a session exceeding the cycle limit is paused instead of further auto-running', async () => {
    setUpSession('session-3');

    for (let i = 0; i < 3; i++) {
      const intent = stageTestRequest('session-3');
      const checked = await routeStageTimeBlock(intent, undefined);
      expect(checked.state).toBe('approved');
    }

    // The 4th staged test.request within this session exceeds the limit of 3.
    const overLimit = stageTestRequest('session-3');
    const checkedOverLimit = await routeStageTimeBlock(overLimit, undefined);

    expect(checkedOverLimit.state).toBe('staged');

    const session = db
      .prepare('SELECT pause_reason FROM sessions WHERE session_id = ?')
      .get('session-3') as { pause_reason: string | null };
    expect(session.pause_reason).toBe('test_request_cycle_exceeded');
  });
});
