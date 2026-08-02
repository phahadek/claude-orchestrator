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

const { mockRecordEvent } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertSession,
  getSession,
  getStagedIntent,
  setStagedIntentAppliedTaskId,
} from '../../db/queries';
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

// task.setProperties — a standalone (ungrouped) Ready-path-agnostic kind —
// exercises the /apply route's redrive logic; task.setDependsOn cannot be
// used here since it is a Ready-path member and must always carry a
// groupId (see ReadyPathMissingGroupError), which forces it through the
// group commit route instead of standalone /apply.
function stagePropertiesIntent(sessionId: string | null, taskId: string) {
  return stageIntent(
    'task.setProperties',
    { taskId, patch: { title: 'Renamed' } },
    'proj-1',
    null,
    sessionId,
  );
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('apply-time redrive — routeApplyTimeFailure via POST /staged-intents/:id/apply', () => {
  it('enqueues a pushback to the originating session carrying the failure reason, and resumes it', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setProperties: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-1');
    const intent = stagePropertiesIntent('session-1', 'notion:task-1');

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(500);
    expect(sm.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] = sm.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('session-1');
    // An apply-time failure is validator-driven (the session's mistake to
    // fix), not an operator judgement call — it must route with a distinct
    // source, never the operator-disposition label/prefix an operator
    // pushback carries.
    expect(source).toBe('validation-error');
    expect(source).not.toBe('operator-disposition');
    expect(message).toContain('backend write failed');
    expect(message).toContain('failed validation');
    // The feedback text ("sent back for revision") and the state the intent
    // actually lands in (needs_revision) must be asserted together — an
    // apply-time failure is always a pushback, so the two cannot drift apart.
    expect(message).toContain('sent back for revision');
    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');

    // A validator-driven rejection is machine attribution, not an operator
    // decision — the audit trail must record it as such.
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'staged_intent_disposition',
        actor_type: 'system',
        payload: expect.objectContaining({
          intentId: intent.id,
          disposition: 'pushback',
          provenance: 'auto',
        }),
      }),
    );
  });

  it('an auto-rejected member is hidden from the decision surface while its session is still active, and surfaced once the session ends without correcting it', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setProperties: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-visibility');
    const intent = stagePropertiesIntent('session-visibility', 'notion:task-1');

    const app = makeApp(planningOrchestrator);
    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});
    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');

    // Session still active (idle, not terminal) — the session still has a
    // turn coming to correct this by superseding it, so it stays out of the
    // operator's decision queue.
    const whileActive = await supertest(app).get(
      '/api/staged-intents?sessionId=session-visibility',
    );
    expect(
      whileActive.body.intents.map((i: { id: string }) => i.id),
    ).not.toContain(intent.id);

    // Session ends without correcting it — no further session-side fix is
    // coming, so it surfaces for the operator to decline.
    db.prepare('UPDATE sessions SET status = ? WHERE session_id = ?').run(
      'done',
      'session-visibility',
    );
    const afterEnded = await supertest(app).get(
      '/api/staged-intents?sessionId=session-visibility',
    );
    expect(afterEnded.body.intents.map((i: { id: string }) => i.id)).toContain(
      intent.id,
    );
  });

  it('a session superseding an auto-rejected group member unblocks the group commit guard — no operator action required', async () => {
    const setProperties = vi
      .fn()
      .mockRejectedValueOnce(new Error('backend write failed'))
      .mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({ type: 'notion', setProperties });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-group-unblock', 'notion:task-group');
    const groupId = 'group-auto-reject-unblock';
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 'notion:task-group', patch: { title: 'Renamed' } },
      'proj-1',
      groupId,
      'session-group-unblock',
    );

    const app = makeApp(planningOrchestrator);
    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/approve`)
      .send({});

    // First attempt: the member is `approved`, so precheckGroupCommit lets
    // the commit through to applyIntent, which fails and auto-rejects the
    // member to needs_revision.
    const commitFails = await supertest(app)
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});
    expect(commitFails.status).toBe(500);
    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');

    // A retry now finds the member already blocked and refuses up front.
    const commitBlocked = await supertest(app)
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});
    expect(commitBlocked.status).toBe(409);
    expect(commitBlocked.body.blockingId).toBe(intent.id);

    // The staging session, not an operator, corrects the mistake by
    // superseding the auto-rejected member.
    const corrected = stageIntent(
      'task.setProperties',
      { taskId: 'notion:task-group', patch: { title: 'Renamed correctly' } },
      'proj-1',
      groupId,
      'session-group-unblock',
      null,
      null,
      intent.id,
    );
    expect(getStagedIntent(intent.id)!.state).toBe('superseded');
    await supertest(app)
      .post(`/api/staged-intents/${corrected.id}/approve`)
      .send({});

    const commitAfter = await supertest(app)
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});
    expect(commitAfter.status).toBe(200);
    expect(commitAfter.body.committed).toEqual([corrected.id]);
  });

  it('an apply-time failure lands in needs_revision and can be superseded by the staging session', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setProperties: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-6', 'task-6');
    const intent = stagePropertiesIntent('session-6', 'notion:task-6');

    const app = makeApp(planningOrchestrator);
    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');

    const corrected = stageIntent(
      'task.setProperties',
      { taskId: 'notion:task-6', patch: { title: 'Renamed again' } },
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
    const setProperties = vi
      .fn()
      .mockRejectedValue(new Error('backend write failed'));
    mockGetTaskBackend.mockReturnValue({ type: 'notion', setProperties });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-2', 'task-2');
    const intent = stagePropertiesIntent('session-2', 'notion:task-2');

    const app = makeApp(planningOrchestrator);
    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(setProperties).toHaveBeenCalledTimes(1);

    // The intent is no longer live/appliable — a retry against the same id
    // 404s rather than re-invoking applyIntent.
    const retry = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});
    expect(retry.status).toBe(404);
    expect(setProperties).toHaveBeenCalledTimes(1);
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
      setProperties: vi.fn().mockRejectedValue(notionError),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-3', '3a922f91-52f3-8151-9de8-e513f7b9de4d');
    const intent = stagePropertiesIntent(
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
      setProperties: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
    });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    // No seedPlanningSession call — 'session-dead' has no session row.
    const intent = stagePropertiesIntent('session-dead', 'notion:task-4');

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
    const setProperties = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({ type: 'notion', setProperties });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-5', 'task-5');
    const intent = stagePropertiesIntent('session-5', 'notion:task-5');

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(200);
    expect(setProperties).toHaveBeenCalledTimes(1);
    // The session may still get a coalesced approval acknowledgment, but
    // never a pushback — there was no failure to redrive.
    for (const call of sm.enqueueFeedback.mock.calls) {
      expect(call[2]).not.toMatch(/sent back for revision/);
    }
  });
});

// ── task.create supersede of an already-applied intent — non-idempotent
// apply's exposure under the supersede model ────────────────────────────────
//
// task.create's apply is not idempotent: each application mints a new task.
// The state machine's supersede/dedup logic assumes a still-staged/approved
// target hasn't taken effect yet — true for every other kind (each of their
// applies converges on the same end state, so a stale assumption costs
// nothing), but false for a create whose own apply raced a concurrent
// supersede of its row and never reached `committed`, even though the task it
// created is real. `applied_task_id` (set the instant the create's backend
// write succeeds, independent of that row's own state transition) is the
// fix's source of truth for "did this already happen" instead of `state`.
describe('task.create supersede of an already-applied intent', () => {
  it('a task.create superseding an intent whose apply already produced a task refuses instead of creating a second one', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:task-original');
    mockGetTaskBackend.mockReturnValue({ type: 'notion', createTask });

    seedPlanningSession('session-create-1', 'task-parent-1');
    const original = stageIntent(
      'task.create',
      { title: 'New follow-on', body: 'x', databaseId: 'db-1' },
      'proj-1',
      null,
      'session-create-1',
    );

    // The race this fix closes: the original's create already ran (a real
    // task exists) but its own staged -> committed transition hasn't landed
    // yet, so the row still reads 'staged' — exactly the state an explicit
    // supersede is allowed to target.
    setStagedIntentAppliedTaskId(original.id, 'notion:task-original');

    const superseding = stageIntent(
      'task.create',
      { title: 'New follow-on (corrected)', body: 'y', databaseId: 'db-1' },
      'proj-1',
      null,
      'session-create-1',
      null,
      null,
      original.id,
    );
    expect(superseding.supersedes).toBe(original.id);
    expect(getStagedIntent(original.id)!.state).toBe('superseded');

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${superseding.id}/apply`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain(original.id);
    expect(res.body.error).toContain('notion:task-original');
    expect(createTask).not.toHaveBeenCalled();
    expect(getStagedIntent(superseding.id)!.state).toBe('needs_revision');

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'staged_intent_create_supersede_noop',
        actor_type: 'system',
        payload: expect.objectContaining({
          supersedingIntentId: superseding.id,
          supersededIntentId: original.id,
          resultId: 'notion:task-original',
        }),
      }),
    );
  });

  it('a task.create superseding an intent that has not applied yet still creates exactly one task, as today', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:task-new');
    mockGetTaskBackend.mockReturnValue({ type: 'notion', createTask });

    seedPlanningSession('session-create-2', 'task-parent-2');
    const original = stageIntent(
      'task.create',
      { title: 'New follow-on', body: 'x', databaseId: 'db-1' },
      'proj-1',
      null,
      'session-create-2',
    );

    const superseding = stageIntent(
      'task.create',
      { title: 'New follow-on (corrected)', body: 'y', databaseId: 'db-1' },
      'proj-1',
      null,
      'session-create-2',
      null,
      null,
      original.id,
    );
    expect(getStagedIntent(original.id)!.state).toBe('superseded');

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${superseding.id}/apply`)
      .send({});

    expect(res.status).toBe(200);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(getStagedIntent(superseding.id)!.state).toBe('committed');
    expect(getStagedIntent(superseding.id)!.applied_task_id).toBe(
      'notion:task-new',
    );
  });

  it('supersede behaviour for a non-create kind is unchanged — applied_task_id is never consulted', async () => {
    const setProperties = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({ type: 'notion', setProperties });

    const sm = makeSessionManager();
    const planningOrchestrator = new PlanningOrchestrator(sm as any);
    seedPlanningSession('session-create-3', 'task-7');
    const original = stagePropertiesIntent('session-create-3', 'notion:task-7');

    const superseding = stageIntent(
      'task.setProperties',
      { taskId: 'notion:task-7', patch: { title: 'Renamed twice' } },
      'proj-1',
      null,
      'session-create-3',
      null,
      null,
      original.id,
    );

    const app = makeApp(planningOrchestrator);
    const res = await supertest(app)
      .post(`/api/staged-intents/${superseding.id}/apply`)
      .send({});

    expect(res.status).toBe(200);
    expect(setProperties).toHaveBeenCalledTimes(1);
    expect(getStagedIntent(superseding.id)!.state).toBe('committed');
    expect(getStagedIntent(superseding.id)!.applied_task_id ?? null).toBeNull();
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
