/**
 * The self-caught-mistake escape hatch (the confirmed-bug fix): a dispatched
 * planning session that notices it staged a wrong intent used to have no
 * channel to retract it other than prose in its closing message — which
 * carried no weight in the apply path and let a mistaken intent reach
 * state='committed' regardless. withdrawIntent gives the staging session a
 * direct, immediate way to move its own intent to a terminal, non-appliable
 * state, with the reason recorded for the operator to see.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertSession,
  insertStagedIntent,
  getSession,
} from '../../db/queries';
import {
  createStagedIntentsRouter,
  stageIntent,
  withdrawIntent,
  IntentWithdrawError,
} from '../stagedIntents';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

function seedSession(sessionId: string, taskId: string | null = 'task-1') {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: 0,
    session_type: 'groom',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
  });
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({
    type: 'notion',
    fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
  });
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('withdrawIntent', () => {
  it('moves the intent to a terminal withdrawn state and records the reason', () => {
    seedSession('sess-1');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'sess-1',
    );

    const withdrawn = withdrawIntent(
      intent.id,
      'staged against the wrong field',
      'sess-1',
    );

    expect(withdrawn.state).toBe('withdrawn');
    expect(withdrawn.dispositionReason).toBe('staged against the wrong field');
  });

  it('rejects withdrawing an intent staged by a different session', () => {
    seedSession('sess-1');
    seedSession('sess-2', 'task-2');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'sess-1',
    );

    expect(() =>
      withdrawIntent(intent.id, 'not mine to withdraw', 'sess-2'),
    ).toThrow(IntentWithdrawError);
  });

  it('requires a non-empty reason', () => {
    seedSession('sess-1');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'sess-1',
    );

    expect(() => withdrawIntent(intent.id, '   ', 'sess-1')).toThrow(
      IntentWithdrawError,
    );
  });

  it('rejects withdrawing an intent that is not found', () => {
    expect(() => withdrawIntent('does-not-exist', 'reason', 'sess-1')).toThrow(
      IntentWithdrawError,
    );
  });

  it('rejects re-withdrawing an already-terminal intent', () => {
    seedSession('sess-1');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'sess-1',
    );
    withdrawIntent(intent.id, 'first withdrawal', 'sess-1');

    expect(() =>
      withdrawIntent(intent.id, 'second withdrawal', 'sess-1'),
    ).toThrow(IntentWithdrawError);
  });

  it('does not itself drive the staging session to a terminal state', () => {
    seedSession('sess-1');
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'sess-1',
    );

    withdrawIntent(intent.id, 'wrong task', 'sess-1');

    expect(getSession('sess-1')?.status).toBe('running');
  });
});

describe('a withdrawn intent is never applied', () => {
  function makeApp(planningOrchestrator: PlanningOrchestrator) {
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(planningOrchestrator));
    return app;
  }

  it('is skipped by an individual apply — the standalone surface 404s once withdrawn', async () => {
    seedSession('sess-1');
    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'task-1', patch: { priority: 'High' } },
      'proj-1',
      null,
      'sess-1',
    );
    withdrawIntent(intent.id, 'staged by mistake', 'sess-1');

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/apply`,
    );

    expect(res.status).toBe(404);
  });

  it('withdrawing the task.setStatus -> Ready intent from a group leaves the group un-promoted on commit', async () => {
    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedSession('sess-1');

    insertStagedIntent({
      id: 'intent-dep',
      kind: 'task.setDependsOn',
      payload: JSON.stringify({ taskId: 'task-1', dependsOn: [] }),
      payload_hash: 'hash-dep',
      task_id: 'task-1',
      project_id: 'proj-1',
      session_id: 'sess-1',
      group_id: 'group-1',
      state: 'approved',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: 1,
      updated_at: 1,
    });
    insertStagedIntent({
      id: 'intent-status',
      kind: 'task.setStatus',
      payload: JSON.stringify({
        taskId: 'task-1',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
        },
      }),
      payload_hash: 'hash-status',
      task_id: 'task-1',
      project_id: 'proj-1',
      session_id: 'sess-1',
      group_id: 'group-1',
      state: 'approved',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: 1,
      updated_at: 1,
    });

    withdrawIntent('intent-status', 'staged against the wrong task', 'sess-1');

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post('/api/staged-intents/group/group-1/commit')
      .send({});

    // Only the remaining live (non-withdrawn) member commits — the Ready
    // flip never runs, so the task is never promoted by this commit.
    expect(res.status).toBe(200);
    expect(res.body.committed).toEqual(['intent-dep']);
  });
});
