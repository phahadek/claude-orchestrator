/**
 * The reject/approve disposition model: reject requires an explicit
 * operator-chosen outcome (pushback | decline) and a non-blank reason.
 * pushback re-turns the originating planning session to revise and
 * re-emit; decline is terminal — the session is informed but not asked
 * to re-emit. Approve->Commit unification: apply is standalone-intents
 * only — a grouped intent must go through the group commit route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockRecordEvent, mockGetTaskBackend } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
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
  createStagedIntentsRouter,
  stageIntent,
  SessionStagedDoneError,
} from '../stagedIntents';
import { getStagedIntent, listStagedIntentsBySession } from '../../db/queries';
import type { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator';

function makePlanningOrchestrator() {
  return {
    handleDisposition: vi.fn().mockResolvedValue(undefined),
    handleGroupDisposition: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlanningOrchestrator & {
    handleDisposition: ReturnType<typeof vi.fn>;
    handleGroupDisposition: ReturnType<typeof vi.fn>;
  };
}

function makeSessionManager() {
  return {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    grantCapability: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
  } as unknown as import('../../session/SessionManager').SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
    grantCapability: ReturnType<typeof vi.fn>;
  };
}

function makeApp(
  planningOrchestrator?: ReturnType<typeof makePlanningOrchestrator>,
  sessionManager?: ReturnType<typeof makeSessionManager>,
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createStagedIntentsRouter(planningOrchestrator, sessionManager as any),
  );
  return app;
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('POST /api/staged-intents/:id/reject', () => {
  it('returns 400 when reason is empty or blank', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-1', dependsOn: [] },
      'proj-1',
      'group-1',
    );

    const empty = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: '' });
    expect(empty.status).toBe(400);

    const blank = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: '   ' });
    expect(blank.status).toBe(400);

    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });

  it('returns 400 when outcome is missing or invalid', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-1', dependsOn: [] },
      'proj-1',
      'group-1',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ reason: 'a reason' });
    expect(res.status).toBe(400);

    const invalid = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'reject', reason: 'a reason' });
    expect(invalid.status).toBe(400);
  });

  it('outcome "decline" persists disposition_reason, transitions to rejected, audits, and routes decline (not asked to re-emit)', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-1', dependsOn: [] },
      'proj-1',
      'group-1',
      'planning-session-1',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'no longer needed' });

    expect(res.status).toBe(200);
    const row = getStagedIntent(intent.id)!;
    expect(row.state).toBe('rejected');
    expect(row.disposition_reason).toBe('no longer needed');

    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'staged_intent_disposition',
        // An operator disposition is a human judgement call, unchanged by
        // the auto-rejection provenance work — the audit trail must still
        // attribute it to a human, never 'system'.
        actor_type: 'human',
        payload: expect.objectContaining({
          intentId: intent.id,
          disposition: 'decline',
          reason: 'no longer needed',
        }),
      }),
    );

    expect(planningOrchestrator.handleDisposition).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'decline',
        reason: 'no longer needed',
      }),
    );
  });

  it('outcome "pushback" persists the reason, lands in needs_revision (not rejected), and re-turns the originating session to revise', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-1', dependsOn: [] },
      'proj-1',
      'group-1',
      'planning-session-1',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'pushback', reason: 'please reconsider' });

    expect(res.status).toBe(200);
    const row = getStagedIntent(intent.id)!;
    // pushback is revisable, so it lands in needs_revision — not the
    // terminal rejected state, which is reserved for an operator decline.
    expect(row.state).toBe('needs_revision');
    expect(row.disposition_reason).toBe('please reconsider');

    // An operator pushback is still a human judgement call — unchanged by
    // the auto-rejection provenance work.
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'staged_intent_disposition',
        actor_type: 'human',
        payload: expect.objectContaining({
          intentId: intent.id,
          disposition: 'pushback',
          reason: 'please reconsider',
        }),
      }),
    );

    expect(planningOrchestrator.handleDisposition).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'pushback',
        reason: 'please reconsider',
      }),
    );
  });

  it('a pushed-back intent (needs_revision) can be superseded by the staging session, and the supersede link is recorded', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-9', dependsOn: [] },
      'proj-1',
      'group-1',
      'planning-session-1',
    );

    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'pushback', reason: 'please reconsider' });
    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');

    const corrected = stageIntent(
      'task.setDependsOn',
      { taskId: 't-9', dependsOn: ['t-other'] },
      'proj-1',
      'group-1',
      'planning-session-1',
      null,
      null,
      intent.id,
    );

    expect(getStagedIntent(corrected.id)!.supersedes).toBe(intent.id);
    expect(getStagedIntent(intent.id)!.state).toBe('superseded');
  });

  it('an intent an operator declined stays in rejected and is refused by the supersede guard', async () => {
    const app = makeApp(makePlanningOrchestrator());
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-10', dependsOn: [] },
      'proj-1',
      'group-1',
      'planning-session-1',
    );

    await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'no longer needed' });
    expect(getStagedIntent(intent.id)!.state).toBe('rejected');

    expect(() =>
      stageIntent(
        'task.setDependsOn',
        { taskId: 't-10', dependsOn: ['t-other'] },
        'proj-1',
        'group-1',
        'planning-session-1',
        null,
        null,
        intent.id,
      ),
    ).toThrow(/cannot be superseded/);
  });

  it('records the disposition even when the originating session has already ended', async () => {
    const app = makeApp(undefined);
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-1', dependsOn: [] },
      'proj-1',
      'group-1',
      'session-long-gone',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'stale' });

    expect(res.status).toBe(200);
    expect(mockRecordEvent).toHaveBeenCalled();
    expect(getStagedIntent(intent.id)!.disposition_reason).toBe('stale');
  });

  it('a capability-request decline still transitions the intent to rejected and routes the outcome via enqueueFeedback with attemptTerminalResume:false, so a terminal originating session is not resumed', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(makePlanningOrchestrator(), sessionManager);
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(ls)',
        plan: 'verify a gate item',
        evidence: 'no other grantable capability reaches this',
      },
      'proj-1',
      null,
      'planning-session-1',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'not needed' });

    expect(res.status).toBe(200);
    expect(getStagedIntent(intent.id)!.state).toBe('rejected');
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.any(String),
      { attemptTerminalResume: false },
    );
  });

  it('a capability-request pushback lands in needs_revision and also routes via enqueueFeedback with attemptTerminalResume:false', async () => {
    const sessionManager = makeSessionManager();
    const app = makeApp(makePlanningOrchestrator(), sessionManager);
    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(ls)',
        plan: 'verify a gate item',
        evidence: 'no other grantable capability reaches this',
      },
      'proj-1',
      null,
      'planning-session-1',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'pushback', reason: 'reconsider' });

    expect(res.status).toBe(200);
    expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledWith(
      'planning-session-1',
      'operator-disposition',
      expect.any(String),
      { attemptTerminalResume: false },
    );
  });
});

describe('POST /api/staged-intents/group/:groupId/reject — coalesced feedback', () => {
  it('rejects a group of 4 intents and sends exactly one group disposition, not one per intent', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);
    const intents = [
      stageIntent(
        'task.setDependsOn',
        { taskId: 't-1', dependsOn: [] },
        'proj-1',
        'group-1',
        'planning-session-1',
      ),
      stageIntent(
        'task.setStatus',
        { taskId: 't-2', status: 'Ready' },
        'proj-1',
        'group-1',
        'planning-session-1',
      ),
      stageIntent(
        'task.setStatus',
        { taskId: 't-3', status: 'Ready' },
        'proj-1',
        'group-1',
        'planning-session-1',
      ),
      stageIntent(
        'task.setStatus',
        { taskId: 't-4', status: 'Ready' },
        'proj-1',
        'group-1',
        'planning-session-1',
      ),
    ];

    const res = await supertest(app)
      .post('/api/staged-intents/group/group-1/reject')
      .send({ outcome: 'pushback', reason: 'revise the whole group' });

    expect(res.status).toBe(200);
    expect(res.body.rejected.sort()).toEqual(intents.map((i) => i.id).sort());
    intents.forEach((intent) => {
      // pushback lands in needs_revision, not rejected — see the
      // single-item "outcome pushback" test above for the same assertion.
      expect(getStagedIntent(intent.id)!.state).toBe('needs_revision');
    });

    expect(planningOrchestrator.handleDisposition).not.toHaveBeenCalled();
    expect(planningOrchestrator.handleGroupDisposition).toHaveBeenCalledTimes(
      1,
    );
    expect(planningOrchestrator.handleGroupDisposition).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'pushback',
        reason: 'revise the whole group',
        groupId: 'group-1',
      }),
    );
  });

  it('rejects a single-item group and still sends exactly one message', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-solo', dependsOn: [] },
      'proj-1',
      'group-solo',
      'planning-session-1',
    );

    const res = await supertest(app)
      .post('/api/staged-intents/group/group-solo/reject')
      .send({ outcome: 'decline', reason: 'no longer needed' });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([intent.id]);
    expect(planningOrchestrator.handleGroupDisposition).toHaveBeenCalledTimes(
      1,
    );
  });
});

describe('POST /api/staged-intents/:id/apply — group atomicity', () => {
  it('rejects a grouped intent with 409 and does not write to the store', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-1', dependsOn: [] },
      'proj-1',
      'group-1',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/apply`,
    );

    expect(res.status).toBe(409);
    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });

  it('applies a standalone (ungrouped) intent normally', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      setProperties: vi.fn(),
    });
    const app = makeApp();
    // task.setProperties, not task.setDependsOn — task.setDependsOn is a
    // Ready-path member and must always carry a groupId (see
    // ReadyPathMissingGroupError), which would force it through the group
    // commit route instead of standalone /apply.
    const intent = stageIntent(
      'task.setProperties',
      { taskId: 't-1', patch: { title: 'Renamed' } },
      'proj-1',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/apply`,
    );

    expect(res.status).toBe(200);
    expect(getStagedIntent(intent.id)!.state).toBe('committed');
  });
});

describe('stageIntent — a session-staged task.setStatus -> Done is refused at stage time', () => {
  for (const sessionType of [
    'groom-session',
    'design-session',
    'ops-session',
  ]) {
    it(`refuses a task.setStatus -> Done staged by a ${sessionType}, naming that Done is the orchestrator's to set, and creates no row`, () => {
      expect(() =>
        stageIntent(
          'task.setStatus',
          { taskId: 't-1', status: 'Done' },
          'proj-1',
          null,
          sessionType,
        ),
      ).toThrow(SessionStagedDoneError);

      expect(() =>
        stageIntent(
          'task.setStatus',
          { taskId: 't-1', status: 'Done' },
          'proj-1',
          null,
          sessionType,
        ),
      ).toThrow(/orchestrator/);

      // No row of any state — rejected or otherwise — was ever created.
      expect(listStagedIntentsBySession(sessionType)).toHaveLength(0);
    });
  }

  it('a human-staged (no sessionId) task.setStatus -> Done is unaffected by the refusal', () => {
    const intent = stageIntent(
      'task.setStatus',
      { taskId: 't-1', status: 'Done' },
      'proj-1',
      null,
      null,
    );
    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });

  it('an ops session staging task.setStatus -> a legitimate target (Blocked) still succeeds', () => {
    const intent = stageIntent(
      'task.setStatus',
      { taskId: 't-2', status: 'Blocked' },
      'proj-1',
      null,
      'ops-session-2',
    );
    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });

  it('an ops session staging task.setStatus -> Deferred still succeeds', () => {
    const intent = stageIntent(
      'task.setStatus',
      { taskId: 't-3', status: 'Deferred' },
      'proj-1',
      null,
      'ops-session-3',
    );
    expect(getStagedIntent(intent.id)!.state).toBe('staged');
  });

  it("a refused Done proposal leaves the rest of the session's closing group intact — no wedged member", () => {
    const sessionId = 'design-session-4';
    const kept = stageIntent(
      'task.setDependsOn',
      { taskId: 't-4', dependsOn: [] },
      'proj-1',
      'group-4',
      sessionId,
    );

    expect(() =>
      stageIntent(
        'task.setStatus',
        { taskId: 't-4', status: 'Done' },
        'proj-1',
        'group-4',
        sessionId,
      ),
    ).toThrow(SessionStagedDoneError);

    // The refused Done never became a row, so it cannot wedge the group —
    // the sibling member staged before it is untouched.
    expect(getStagedIntent(kept.id)!.state).toBe('staged');
    expect(listStagedIntentsBySession(sessionId)).toHaveLength(1);
  });
});
