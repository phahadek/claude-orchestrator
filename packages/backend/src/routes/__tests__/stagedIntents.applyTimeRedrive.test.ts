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
import { insertSession, getSession, getStagedIntent } from '../../db/queries';
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
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

function makeApp(planningOrchestrator: PlanningOrchestrator) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(planningOrchestrator));
  return app;
}

function seedPlanningSession(sessionId: string, taskId: string = 'task-1') {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
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
      setDependsOn: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
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
    // The feedback text ("sent back for revision") and the state the intent
    // actually lands in (needs_revision) must be asserted together — an
    // apply-time failure is always a pushback, so the two cannot drift apart.
    expect(message).toContain('sent back for revision');
    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');
  });

  it('an apply-time failure lands in needs_revision and can be superseded by the staging session', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setDependsOn: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-6', 'task-6');
    const intent = stageDependsOnIntent('session-6', 'notion:task-6');

    const app = makeApp(planningOrchestrator);
    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');

    const corrected = stageIntent(
      'task.setDependsOn',
      { taskId: 'notion:task-6', dependsOn: ['notion:task-other'] },
      'proj-1',
      null,
      'session-6',
      null,
      null,
      intent.id,
    );

    expect(getStagedIntent(corrected.id)!.supersedes).toBe(intent.id);
    expect(getStagedIntent(intent.id)!.state).toBe('superseded');
  });

  it('does not auto-retry the apply — the backend write is attempted exactly once, and the intent requires a fresh disposition', async () => {
    const setDependsOn = vi
      .fn()
      .mockRejectedValue(new Error('backend write failed'));
    mockGetTaskBackend.mockReturnValue({ type: 'notion', setDependsOn });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-2', 'task-2');
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
    seedPlanningSession('session-3', '3a922f91-52f3-8151-9de8-e513f7b9de4d');
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
      setDependsOn: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
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
    seedPlanningSession('session-5', 'task-5');
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
