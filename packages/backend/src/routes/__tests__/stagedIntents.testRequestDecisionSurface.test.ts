/**
 * A test.request is auto-granted mechanically (maybeAutoApproveTestRequest)
 * and, per its own stage-time validator, never needs an operator — it
 * applies via a direct auto-grant + execution, never a group commit. It must
 * therefore never occupy a decision-inbox slot for the entire `approved`
 * phase of its (up to several-minute) lane run: isVisibleOnDecisionSurfaceCore
 * withholds it, listStagedIntentsByMilestone excludes it, and the
 * staged_intent_changed broadcast on its auto-grant is suppressed. A rejected
 * test.request (an operator-actionable outcome) and an approved intent of any
 * other kind are unaffected.
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
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockLoadOrchestratorConfig: vi.fn(),
  mockComputeHash: vi.fn(),
  mockAdmitTestRequest: vi.fn(),
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

import { db } from '../../db/db';
import {
  stageIntent,
  routeStageTimeBlock,
  setStagedIntentBroadcast,
  isVisibleOnDecisionSurface,
  isIntentVisibleOnDecisionSurface,
  type StagedIntent,
} from '../stagedIntents';
import {
  insertSession,
  updateSessionWorktreePath,
  insertStagedIntent,
  listStagedIntentsByMilestone,
  hashIntentPayload,
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';
import type { StagedIntentRow, StagedIntentState } from '../../db/types';

const PROJECT_ID = 'proj-test-request-visibility';

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

function makeRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  const payload = overrides.payload ?? JSON.stringify({ taskId: 'task-1' });
  return {
    id: 'row-1',
    kind: 'test.request',
    payload,
    payload_hash: hashIntentPayload(JSON.parse(payload)),
    task_id: 'task-1',
    project_id: PROJECT_ID,
    session_id: null,
    group_id: null,
    milestone: 'M1',
    state: 'approved',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    investigation: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    applied_task_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  } as StagedIntentRow;
}

function rowToIntentShape(row: StagedIntentRow): StagedIntent {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    projectId: row.project_id,
    createdAt: row.created_at,
    sessionId: row.session_id,
    state: row.state,
    supersedes: row.supersedes,
    annotation: null,
    groupId: row.group_id,
    milestone: row.milestone,
  };
}

beforeEach(() => {
  mockGetProjectById.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockComputeHash.mockReset();
  mockAdmitTestRequest.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();
  db.prepare('DELETE FROM session_feedback_inbox').run();

  mockGetProjectById.mockReturnValue({ id: PROJECT_ID, projectDir: '/proj' });
  mockLoadOrchestratorConfig.mockReturnValue({
    test: ['npm test'],
    test_timeout_sec: 60,
    test_max_rss_mb: 0,
    test_fail_fast: true,
  });
  mockComputeHash.mockResolvedValue('hash-1');
  // `result` never resolves: keeps triggerTestRequestExecution's
  // fire-and-forget tail from reaching its post-run `committed`
  // transition/broadcast mid-test.
  mockAdmitTestRequest.mockImplementation(() => ({
    runId: 'run-pending',
    status: 'running',
    position: 0,
    queueDepth: 0,
    reused: false,
    result: new Promise(() => {}),
  }));
  typedSetSetting('test_request_cycle_limit', 10);
  setStagedIntentBroadcast(() => {});
});

describe('isVisibleOnDecisionSurface(Core) — test.request', () => {
  it('withholds an auto-granted test.request in state approved', () => {
    const row = makeRow({ state: 'approved' });
    expect(isVisibleOnDecisionSurface(row, undefined)).toBe(false);
  });

  it('keeps a rejected test.request visible — the operator-actionable outcome', () => {
    const row = makeRow({ state: 'rejected' });
    expect(isVisibleOnDecisionSurface(row, undefined)).toBe(true);
  });

  it('does not withhold an approved intent of another kind', () => {
    const row = makeRow({ kind: 'task.setProperties', state: 'approved' });
    expect(isVisibleOnDecisionSurface(row, undefined)).toBe(true);
  });

  it('row-shaped and API-shaped helpers agree for an identical test.request', () => {
    for (const state of [
      'staged',
      'approved',
      'rejected',
      'committed',
    ] as StagedIntentState[]) {
      const row = makeRow({ state });
      const intent = rowToIntentShape(row);
      expect(isIntentVisibleOnDecisionSurface(intent, undefined)).toBe(
        isVisibleOnDecisionSurface(row, undefined),
      );
    }
  });
});

describe('listStagedIntentsByMilestone — test.request', () => {
  it('excludes an approved test.request and includes it again neither before nor after (rejected/committed stay excluded too)', () => {
    insertStagedIntent(
      makeRow({ id: 'tr-approved', milestone: 'M1', state: 'approved' }),
    );
    insertStagedIntent(
      makeRow({ id: 'tr-committed', milestone: 'M1', state: 'committed' }),
    );
    insertStagedIntent(
      makeRow({
        id: 'other-approved',
        kind: 'task.setProperties',
        milestone: 'M1',
        state: 'approved',
      }),
    );

    const rows = listStagedIntentsByMilestone(PROJECT_ID, 'M1');

    expect(rows.map((r) => r.id)).toEqual(['other-approved']);
  });
});

describe('staged_intent_changed broadcast — test.request auto-grant', () => {
  it('is not emitted when a test.request auto-transitions to approved', async () => {
    setUpSession('session-1');
    const intent = stageTestRequest('session-1');
    const broadcastFn = vi.fn();
    setStagedIntentBroadcast(broadcastFn);

    const checked = await routeStageTimeBlock(intent, undefined);

    expect(checked.state).toBe('approved');
    expect(broadcastFn).not.toHaveBeenCalled();
  });
});
