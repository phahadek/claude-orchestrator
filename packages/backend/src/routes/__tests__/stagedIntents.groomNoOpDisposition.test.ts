/**
 * A standalone planning.noOp from a groom session is operator-dispositioned:
 * Acknowledge ends the held-open session, Reject (pushback) resumes it with
 * the operator's reason. A standard/ops noOp keeps its own approve-writes-Done
 * semantics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { EventEmitter } from 'events';

const { mockApplyResolvedNoOp } = vi.hoisted(() => ({
  mockApplyResolvedNoOp: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({}),
}));
vi.mock('../../github/NoOpInvestigator', () => ({
  applyResolvedNoOp: mockApplyResolvedNoOp,
}));
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import {
  insertSession,
  getSession,
  getStagedIntent,
  isNoOpSuppressed,
} from '../../db/queries';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';
import type { SessionManager } from '../../session/SessionManager';

const SESSION_ID = 'sess-noop-1';
const TASK_ID = 'task-noop-1';

function makeSessionManager() {
  return Object.assign(new EventEmitter(), {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
    grantCapability: vi.fn().mockResolvedValue([]),
  }) as unknown as SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
  };
}

function seedSession(sessionType: string): void {
  insertSession({
    session_id: SESSION_ID,
    task_id: TASK_ID,
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: sessionType,
    project_id: null,
  });
}

function setup() {
  const sessionManager = makeSessionManager();
  const orchestrator = new PlanningOrchestrator(sessionManager);
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(orchestrator, sessionManager));
  return { app, sessionManager };
}

function stageNoOp() {
  return stageIntent(
    'planning.noOp',
    { taskId: TASK_ID, reason: 'nothing to groom' },
    'proj-1',
    null,
    SESSION_ID,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  mockApplyResolvedNoOp.mockReset();
});

describe('groom planning.noOp operator disposition', () => {
  it('acknowledge commits the noOp and the held-open groom session reaches done', async () => {
    seedSession('groom');
    const { app } = setup();
    const intent = stageNoOp();

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/acknowledge`,
    );

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    const row = db
      .prepare(
        'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
      )
      .get(SESSION_ID) as { terminal_completion_reason: string | null };
    expect(row.terminal_completion_reason).toBe(
      'planning_no_pending_dispositions',
    );
  });

  it('reject with pushback sends the noOp back for revision, enqueues the reason to the live session, and does not suppress the task', async () => {
    seedSession('groom');
    const { app, sessionManager } = setup();
    const intent = stageNoOp();

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'pushback', reason: 'this task needs a split first' });

    expect(res.status).toBe(200);
    expect(getStagedIntent(intent.id)?.state).toBe('needs_revision');
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    expect(sessionManager.enqueueFeedback.mock.calls[0][0]).toBe(SESSION_ID);
    expect(
      JSON.stringify(sessionManager.enqueueFeedback.mock.calls[0]),
    ).toContain('this task needs a split first');
    expect(getSession(SESSION_ID)?.status).toBe('running');
    expect(isNoOpSuppressed(TASK_ID)).toBe(false);
  });
});

describe('standard/ops planning.noOp regression', () => {
  it('stays operator-approvable and approving it writes the task Done', async () => {
    seedSession('standard');
    const { app } = setup();
    const intent = stageNoOp();

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/approve`,
    );

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    expect(mockApplyResolvedNoOp).toHaveBeenCalledTimes(1);
    expect(mockApplyResolvedNoOp.mock.calls[0][1]).toBe(TASK_ID);
  });
});
