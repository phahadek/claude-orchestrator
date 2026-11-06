/**
 * applyIntent's `planning.noOp` case: a design closing-synthesis group
 * legitimately carries a planning.noOp as one of its members (see
 * assertExpectedTerminalKinds), so the group-commit apply path must be able
 * to commit it — not fall through to the `default:` unknown-kind throw,
 * which would wedge the whole group (see the acknowledge route's comment,
 * and assertReadyPathGrouped's, for the standalone-vs-grouped distinction).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertSession,
  insertStagedIntent,
  getStagedIntent,
  getSession,
} from '../../db/queries';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

function makeApp(planningOrchestrator?: PlanningOrchestrator) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(planningOrchestrator));
  return app;
}

function seedSession(
  sessionId: string,
  overrides: Partial<{
    task_id: string | null;
    status: 'starting' | 'running' | 'idle' | 'done';
    session_type: string;
  }> = {},
) {
  insertSession({
    session_id: sessionId,
    task_id: overrides.task_id ?? 'task-1',
    task_url: null,
    project_context_url: null,
    status: overrides.status ?? 'idle',
    started_at: 0,
    session_type: (overrides.session_type ?? 'design') as never,
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

function stageRow(overrides: {
  id: string;
  kind: string;
  payload: unknown;
  sessionId: string;
  groupId: string;
  taskId?: string;
  state?: 'staged' | 'approved' | 'committed';
}) {
  insertStagedIntent({
    id: overrides.id,
    kind: overrides.kind,
    payload: JSON.stringify(overrides.payload),
    payload_hash: `hash-${overrides.id}`,
    task_id: overrides.taskId ?? 'task-1',
    project_id: 'proj-1',
    session_id: overrides.sessionId,
    group_id: overrides.groupId,
    milestone: null,
    state: overrides.state ?? 'approved',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    investigation: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    applied_task_id: null,
    created_at: 1,
    updated_at: 1,
  });
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('applyIntent — grouped planning.noOp commits instead of throwing', () => {
  it('commits every member of a group containing a planning.noOp alongside other members, including the noOp', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:new-task-id');
    mockGetTaskBackend.mockReturnValue({ type: 'notion', createTask });

    seedSession('sess-mixed');
    stageRow({
      id: 'intent-create',
      kind: 'task.create',
      payload: {
        databaseId: 'db-1',
        title: 'Follow-on task',
        type: '💻 Code',
      },
      sessionId: 'sess-mixed',
      groupId: 'g-mixed',
    });
    stageRow({
      id: 'intent-noop',
      kind: 'planning.noOp',
      payload: { taskId: 'task-1', reason: 'nothing else to add this pass' },
      sessionId: 'sess-mixed',
      groupId: 'g-mixed',
    });

    const app = makeApp();
    const agent = supertest(app);
    const commit = await agent
      .post('/api/staged-intents/group/g-mixed/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed.sort()).toEqual(
      ['intent-create', 'intent-noop'].sort(),
    );
    expect(getStagedIntent('intent-create')?.state).toBe('committed');
    expect(getStagedIntent('intent-noop')?.state).toBe('committed');
  });

  it('commits a design closing-synthesis group (artifact + skippedKind noOp + closing task.updateBody) with no member left staged', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:new-followon-id');
    const updateBody = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
      updateBody,
      fetchTaskPage: vi.fn().mockResolvedValue(''),
    });

    seedSession('sess-closing', { task_id: 'task-closing' });
    stageRow({
      id: 'intent-followon',
      kind: 'task.create',
      payload: {
        databaseId: 'db-1',
        title: 'Follow-on Code task',
        type: '💻 Code',
      },
      sessionId: 'sess-closing',
      groupId: 'g-closing',
      taskId: 'task-closing',
    });
    stageRow({
      id: 'intent-arch-noop',
      kind: 'planning.noOp',
      payload: {
        taskId: 'task-closing',
        reason: 'no architecture unit changed this pass',
        skippedKind: 'architecture',
      },
      sessionId: 'sess-closing',
      groupId: 'g-closing',
      taskId: 'task-closing',
    });
    stageRow({
      id: 'intent-closing-body',
      kind: 'task.updateBody',
      payload: {
        taskId: 'task-closing',
        sections: { summary: 'Closing synthesis.' },
      },
      sessionId: 'sess-closing',
      groupId: 'g-closing',
      taskId: 'task-closing',
    });

    const app = makeApp();
    const agent = supertest(app);
    const commit = await agent
      .post('/api/staged-intents/group/g-closing/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed.sort()).toEqual(
      ['intent-followon', 'intent-arch-noop', 'intent-closing-body'].sort(),
    );
    for (const id of [
      'intent-followon',
      'intent-arch-noop',
      'intent-closing-body',
    ]) {
      expect(getStagedIntent(id)?.state).toBe('committed');
    }
    expect(updateBody).toHaveBeenCalledTimes(1);
  });

  it('applying a planning.noOp produces no side effect — no task-backend write, no applied_task_id set', async () => {
    const createTask = vi.fn();
    const setStatus = vi.fn();
    const updateBody = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
      setStatus,
      updateBody,
    });

    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-1', reason: 'nothing to change this turn' },
      'proj-1',
      null,
      'sess-standalone',
    );

    const app = makeApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(applied.status).toBe(200);
    expect(applied.body.result).toEqual({});
    expect(createTask).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(updateBody).not.toHaveBeenCalled();

    const row = getStagedIntent(intent.id);
    expect(row?.state).toBe('committed');
    expect(row?.applied_task_id).toBeNull();
  });

  it('never throws unknown intent kind "planning.noOp" — regression, with and without skippedKind', async () => {
    mockGetTaskBackend.mockReturnValue({ type: 'notion' });
    const app = makeApp();
    const agent = supertest(app);

    const withoutSkipped = stageIntent(
      'planning.noOp',
      { taskId: 'task-1', reason: 'already ready, nothing to add' },
      'proj-1',
      null,
      'sess-regress-1',
    );
    const withSkipped = stageIntent(
      'planning.noOp',
      {
        taskId: 'task-1',
        reason: 'no follow-on task warranted',
        skippedKind: 'task.create',
      },
      'proj-1',
      null,
      'sess-regress-2',
    );

    for (const intent of [withoutSkipped, withSkipped]) {
      const applied = await agent
        .post(`/api/staged-intents/${intent.id}/apply`)
        .send({});
      expect(applied.status).toBe(200);
      expect(applied.body.error).toBeUndefined();
    }
  });

  it('the standalone /staged-intents/:id/acknowledge route still commits a groupless noOp, and still rejects a non-noOp kind with 409', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const noOp = stageIntent(
      'planning.noOp',
      { taskId: 'task-1', reason: 'nothing to change' },
      'proj-1',
      null,
      'sess-ack-1',
    );
    const ackRes = await agent.post(
      `/api/staged-intents/${noOp.id}/acknowledge`,
    );
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.state).toBe('committed');

    const other = stageIntent(
      'task.setDependsOn',
      { taskId: 'task-2', dependsOn: [] },
      'proj-1',
      'g-non-noop',
      'sess-ack-2',
    );
    const rejectRes = await agent.post(
      `/api/staged-intents/${other.id}/acknowledge`,
    );
    expect(rejectRes.status).toBe(409);
  });

  it('committing a grouped noOp member does not trigger a resume of a session that is already terminal', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:new-id');
    mockGetTaskBackend.mockReturnValue({ type: 'notion', createTask });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);

    // Session already reached terminal (e.g. checkTerminal's `countable`
    // filter already excluded the noOp and drove it done) before the
    // operator later commits the group.
    seedSession('sess-terminal', { status: 'done', task_id: 'task-1' });
    stageRow({
      id: 'intent-terminal-create',
      kind: 'task.create',
      payload: {
        databaseId: 'db-1',
        title: 'Follow-on task',
        type: '💻 Code',
      },
      sessionId: 'sess-terminal',
      groupId: 'g-terminal',
    });
    stageRow({
      id: 'intent-terminal-noop',
      kind: 'planning.noOp',
      payload: { taskId: 'task-1', reason: 'nothing else to add' },
      sessionId: 'sess-terminal',
      groupId: 'g-terminal',
    });

    const app = makeApp(planningOrchestrator);
    const agent = supertest(app);
    const commit = await agent
      .post('/api/staged-intents/group/g-terminal/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(getSession('sess-terminal')?.status).toBe('done');
  });
});
