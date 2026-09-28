/**
 * A standard or ops session's standalone planning.noOp — the terminal
 * declaration that a dispatched task's work is already satisfied elsewhere —
 * no longer commits itself at stage time (see the 2026-09-27 operator
 * ruling: a session's own say-so can no longer conclude it). It stays
 * `staged` for an explicit operator Approve (which then drives the task to
 * Done and terminates the staging session) or Reject (which leaves both
 * untouched and resumes the session with the operator's reason). A
 * groom/design no-op (still "nothing to change this turn", not "already
 * done") is untouched either way.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { insertSession, getStagedIntent, getSession } from '../../db/queries';
import {
  stageIntent,
  routeStageTimeBlock,
  createStagedIntentsRouter,
} from '../stagedIntents';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
  });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined));
  return app;
}

// Seeded as 'idle' rather than 'running' — markSessionDone defers a
// running→done write until the in-flight turn drains (see its in-flight
// guard doc comment), same as every other completion path. Seeding idle
// (a resumed session concluding its no-op) isolates the behavior under test
// from that unrelated, already-covered deferral mechanism.
function seedSession(
  sessionId: string,
  overrides: Partial<{ task_id: string; session_type: string }> = {},
) {
  insertSession({
    session_id: sessionId,
    task_id: overrides.task_id ?? 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: (overrides.session_type ?? 'standard') as never,
  });
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('planning.noOp at stage time — no longer auto-resolves', () => {
  it('stays staged for a standard session — no task write, session stays non-terminal', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const appendImplementationNote = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      updateStatus,
      appendImplementationNote,
    });

    seedSession('sess-code-1', { task_id: 'task-1', session_type: 'standard' });
    const intent = stageIntent(
      'planning.noOp',
      {
        taskId: 'task-1',
        reason: 'already resolved by commit 95507034 on dev',
      },
      'proj-1',
      null,
      'sess-code-1',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('staged');
    expect(getStagedIntent(intent.id)?.state).toBe('staged');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(appendImplementationNote).not.toHaveBeenCalled();

    const session = getSession('sess-code-1');
    expect(session?.status).toBe('idle');
    expect(session?.terminal_completion_reason).toBeFalsy();
  });

  it('stays staged the same way for an ops session', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      updateStatus: vi.fn(),
    });

    seedSession('sess-ops-1', { task_id: 'task-2', session_type: 'ops' });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-2', reason: 'already resolved by PR #42' },
      'proj-1',
      null,
      'sess-ops-1',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('staged');
    expect(getSession('sess-ops-1')?.status).toBe('idle');
  });

  it('leaves a groom session no-op untouched (still requires operator Acknowledge)', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({ type: 'notion', updateStatus });

    seedSession('sess-groom-1', { task_id: 'task-3', session_type: 'groom' });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-3', reason: 'nothing to groom this turn' },
      'proj-1',
      null,
      'sess-groom-1',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('staged');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(getSession('sess-groom-1')?.status).toBe('idle');
  });

  it('leaves a grouped planning.noOp untouched — it commits only via the group-commit path', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({ type: 'notion', updateStatus });

    seedSession('sess-code-grouped', {
      task_id: 'task-4',
      session_type: 'standard',
    });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-4', reason: 'nothing else to add' },
      'proj-1',
      'g-1',
      'sess-code-grouped',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('staged');
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe('operator disposition of a standard/ops session standalone planning.noOp', () => {
  it('Approve commits the intent, closes the task Done with evidence, and terminates the session', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const appendImplementationNote = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      updateStatus,
      appendImplementationNote,
    });

    seedSession('sess-code-2', { task_id: 'task-5', session_type: 'standard' });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-5', reason: 'already resolved by commit abc123' },
      'proj-1',
      null,
      'sess-code-2',
    );

    const app = makeApp();
    const agent = supertest(app);
    const approved = await agent
      .post(`/api/staged-intents/${intent.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(approved.body.state).toBe('committed');
    expect(getStagedIntent(intent.id)?.state).toBe('committed');
    expect(updateStatus).toHaveBeenCalledWith('task-5', '✅ Done');
    expect(appendImplementationNote).toHaveBeenCalledWith(
      'task-5',
      expect.stringContaining('abc123'),
    );

    const session = getSession('sess-code-2');
    expect(session?.status).toBe('done');
    expect(session?.terminal_completion_reason).toBe('no_op_resolved');
  });

  it('Reject leaves the session non-terminal, the task untouched, and enqueues the reason to feedback', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({ type: 'notion', updateStatus });

    seedSession('sess-code-3', { task_id: 'task-6', session_type: 'standard' });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-6', reason: 'thought this was already done' },
      'proj-1',
      null,
      'sess-code-3',
    );

    const sm = makeSessionManager();
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sm as any));
    const agent = supertest(app);

    const rejected = await agent
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'that PR never merged — keep going' });

    expect(rejected.status).toBe(200);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(getSession('sess-code-3')?.status).not.toBe('done');
    expect(sm.enqueueFeedback).toHaveBeenCalledWith(
      'sess-code-3',
      'no_op_rejected',
      expect.stringContaining('that PR never merged — keep going'),
    );
  });

  it('/apply is refused for an operator-approvable no-op — must go through /approve or /reject', async () => {
    mockGetTaskBackend.mockReturnValue({ type: 'notion' });
    seedSession('sess-code-4', { task_id: 'task-7', session_type: 'standard' });
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-7', reason: 'already resolved' },
      'proj-1',
      null,
      'sess-code-4',
    );

    const app = makeApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(applied.status).toBe(409);
    expect(getStagedIntent(intent.id)?.state).toBe('staged');
  });
});
