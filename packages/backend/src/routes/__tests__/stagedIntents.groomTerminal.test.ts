/**
 * A dispatched groom session parks idle after each turn, resumable through
 * the operator-disposition loop. Once its group is fully disposed and the
 * target task promoted to Ready, nothing re-dispatches the session, so it
 * never re-parks and PlanningOrchestrator's onSessionParked-driven terminal
 * check never fires — it lingers idle instead of being swept by
 * ConcludedSessionArchiver. Covers the fix: commitGroupIntents invokes the
 * terminal check directly on the applied terminal grooming disposition.
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
  getSession,
} from '../../db/queries';
import { createStagedIntentsRouter } from '../stagedIntents';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    evictSession: vi.fn(),
  });
}

function makeApp(planningOrchestrator: PlanningOrchestrator) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(planningOrchestrator));
  return app;
}

function seedGroomSession(sessionId: string) {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'idle',
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

function stageDependsOn(
  id: string,
  sessionId: string,
  groupId: string,
  taskId: string,
) {
  insertStagedIntent({
    id,
    kind: 'task.setDependsOn',
    payload: JSON.stringify({ taskId, dependsOn: [] }),
    payload_hash: `hash-${id}`,
    task_id: taskId,
    project_id: 'proj-groom',
    session_id: sessionId,
    group_id: groupId,
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
}

function stageSetStatusReady(
  id: string,
  sessionId: string,
  groupId: string,
  taskId: string,
) {
  insertStagedIntent({
    id,
    kind: 'task.setStatus',
    payload: JSON.stringify({
      taskId,
      status: 'Ready',
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
      },
    }),
    payload_hash: `hash-${id}`,
    task_id: taskId,
    project_id: 'proj-groom',
    session_id: sessionId,
    group_id: groupId,
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
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('group commit drives a groom session terminal on the applied terminal grooming disposition', () => {
  it('transitions the session to done once its group is fully disposed and the target task promoted, even though it never re-parks', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedGroomSession('groom-session-final');
    stageDependsOn('intent-dep', 'groom-session-final', 'g-final', 'task-1');
    stageSetStatusReady(
      'intent-status',
      'groom-session-final',
      'g-final',
      'task-1',
    );
    // Simulate the turn that staged these intents parking (idle) before any
    // operator disposition — priming checkTerminal's snapshot, exactly as
    // onSessionParked would in production.
    planningOrchestrator.checkTerminal('groom-session-final');

    const app = makeApp(planningOrchestrator);
    const agent = supertest(app);

    const commit = await agent
      .post('/api/staged-intents/group/g-final/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed.sort()).toEqual(
      ['intent-dep', 'intent-status'].sort(),
    );

    // No session_ended(idle) re-park event was ever emitted — the terminal
    // check fired straight off the apply path.
    const row = getSession('groom-session-final');
    expect(row?.status).toBe('done');
  });

  it('leaves a session with a still-pending (staged) intent in another group resumable — not prematurely closed', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedGroomSession('groom-session-mid');
    stageDependsOn('intent-dep-2', 'groom-session-mid', 'g-mid', 'task-2');
    stageSetStatusReady(
      'intent-status-2',
      'groom-session-mid',
      'g-mid',
      'task-2',
    );
    // A second, unrelated intent for the same session is still awaiting
    // operator disposition — the session must stay resumable.
    insertStagedIntent({
      id: 'intent-other-task',
      kind: 'task.setDependsOn',
      payload: JSON.stringify({ taskId: 'task-3', dependsOn: [] }),
      payload_hash: 'hash-intent-other-task',
      task_id: 'task-3',
      project_id: 'proj-groom',
      session_id: 'groom-session-mid',
      group_id: 'g-other',
      state: 'staged',
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
    // Simulate the turn that staged these intents parking (idle) before any
    // operator disposition — priming checkTerminal's snapshot, exactly as
    // onSessionParked would in production.
    planningOrchestrator.checkTerminal('groom-session-mid');

    const app = makeApp(planningOrchestrator);
    const agent = supertest(app);

    const commit = await agent
      .post('/api/staged-intents/group/g-mid/commit')
      .send({});

    expect(commit.status).toBe(200);

    const row = getSession('groom-session-mid');
    expect(row?.status).toBe('idle');
  });
});
