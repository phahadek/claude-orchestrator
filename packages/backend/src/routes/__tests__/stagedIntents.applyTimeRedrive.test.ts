/**
 * Apply-time twin of stagedIntents.stageTimeRedrive.test.ts: a provider
 * exception thrown by applyIntent used to reach the operator as a raw error
 * with the staged intent left dangling — no route back to the session that
 * staged it, forcing a human to hand-paste the provider error into a manual
 * pushback. routeApplyTimeFailure closes that gap by reusing
 * PlanningOrchestrator's existing pushback-disposition path (the same
 * enqueue-and-resume mechanics an operator pushback already drives) rather
 * than adding a parallel one.
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
import { insertSession, getSession } from '../../db/queries';
import {
  createStagedIntentsRouter,
  stageIntent,
  translateApplyError,
} from '../stagedIntents';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';
import { NotionApiError } from '../../notion/types';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
  });
}

function makeApp(planningOrchestrator: PlanningOrchestrator) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(planningOrchestrator));
  return app;
}

function seedPlanningSession(sessionId: string) {
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

function stageDependsOnIntent(sessionId: string | null, taskId: string) {
  return stageIntent(
    'task.setDependsOn',
    { taskId, dependsOn: [] },
    'proj-1',
    null,
    sessionId,
  );
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('apply-time redrive — routeApplyTimeFailure via POST /staged-intents/:id/apply', () => {
  it('enqueues a pushback to the originating session carrying the failure reason, and resumes it', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setDependsOn: vi.fn().mockRejectedValue(new Error('backend write failed')),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-1');
    const intent = stageDependsOnIntent('session-1', 'notion:task-1');

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(500);
    expect(sm.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] = sm.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(source).toBe('operator-disposition');
    expect(message).toContain('backend write failed');
    expect(message).toContain('sent back for revision');
  });

  it('does not auto-retry the apply — the backend write is attempted exactly once, and the intent requires a fresh disposition', async () => {
    const setDependsOn = vi
      .fn()
      .mockRejectedValue(new Error('backend write failed'));
    mockGetTaskBackend.mockReturnValue({ type: 'notion', setDependsOn });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-2');
    const intent = stageDependsOnIntent('session-2', 'notion:task-2');

    const app = makeApp(planningOrchestrator);
    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(setDependsOn).toHaveBeenCalledTimes(1);

    // The intent is no longer live/appliable — a retry against the same id
    // 404s rather than re-invoking applyIntent.
    const retry = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});
    expect(retry.status).toBe(404);
    expect(setDependsOn).toHaveBeenCalledTimes(1);
  });

  it('translates a Notion object_not_found into a message naming the unresolvable task id, not the raw sharing-permissions text', async () => {
    const notionError = new NotionApiError(
      404,
      '{"object":"error","status":404,"code":"object_not_found",' +
        '"message":"Could not find page with ID: 3a922f91-52f3-8151-9de8-e513f7b9de4d. ' +
        'Make sure the relevant pages and databases are shared with your integration."}',
    );
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setDependsOn: vi.fn().mockRejectedValue(notionError),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-3');
    const intent = stageDependsOnIntent(
      'session-3',
      '3a922f91-52f3-8151-9de8-e513f7b9de4d',
    );

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.body.error).toContain('3a922f91-52f3-8151-9de8-e513f7b9de4d');
    expect(res.body.error).not.toMatch(/shared with your integration/);

    const [, , message] = sm.enqueueFeedback.mock.calls[0];
    expect(message).toContain('3a922f91-52f3-8151-9de8-e513f7b9de4d');
    expect(message).not.toMatch(/shared with your integration/);
  });

  it('an apply-time failure whose originating session no longer exists surfaces to the operator instead of being dropped', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setDependsOn: vi.fn().mockRejectedValue(new Error('backend write failed')),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    // No seedPlanningSession call — 'session-dead' has no session row.
    const intent = stageDependsOnIntent('session-dead', 'notion:task-4');

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('backend write failed');
    expect(res.body.redrivenToSession).toBe(false);
    expect(sm.enqueueFeedback).not.toHaveBeenCalled();
    expect(getSession('session-dead')).toBeUndefined();
  });

  it('a successful apply is unaffected — no redrive on the happy path', async () => {
    const setDependsOn = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({ type: 'notion', setDependsOn });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-5');
    const intent = stageDependsOnIntent('session-5', 'notion:task-5');

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(200);
    expect(setDependsOn).toHaveBeenCalledTimes(1);
    // The session may still get a coalesced approval acknowledgment, but
    // never a pushback — there was no failure to redrive.
    for (const call of sm.enqueueFeedback.mock.calls) {
      expect(call[2]).not.toMatch(/sent back for revision/);
    }
  });
});

describe('translateApplyError', () => {
  it('renames a Notion object_not_found to the unresolvable task id rather than the sharing-permissions text', () => {
    const notionError = new NotionApiError(
      404,
      'Could not find page with ID: abc-123. Make sure the relevant pages and databases are shared with your integration.',
    );
    const message = translateApplyError(notionError, {
      id: 'intent-1',
      kind: 'task.setDependsOn',
      payload: { taskId: 'abc-123', dependsOn: [] },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-1',
      state: 'approved',
      supersedes: null,
      annotation: null,
      groupId: null,
      decisionProposal: null,
      groomProposal: null,
      advisory: null,
      dispositionReason: null,
      answer: null,
    });

    expect(message).toContain('abc-123');
    expect(message).not.toMatch(/shared with your integration/);
  });

  it('passes an unrelated error through unchanged', () => {
    const message = translateApplyError(new Error('backend write failed'), {
      id: 'intent-1',
      kind: 'task.setDependsOn',
      payload: { taskId: 'abc-123', dependsOn: [] },
      projectId: 'proj-1',
      createdAt: 0,
      sessionId: 'session-1',
      state: 'approved',
      supersedes: null,
      annotation: null,
      groupId: null,
      decisionProposal: null,
      groomProposal: null,
      advisory: null,
      dispositionReason: null,
      answer: null,
    });

    expect(message).toBe('backend write failed');
  });
});
