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
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { getStagedIntent } from '../../db/queries';
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

function makeApp(
  planningOrchestrator?: ReturnType<typeof makePlanningOrchestrator>,
) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(planningOrchestrator));
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
      null,
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
      null,
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
      null,
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
      null,
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
      null,
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
        null,
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
      null,
      'session-long-gone',
    );

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'stale' });

    expect(res.status).toBe(200);
    expect(mockRecordEvent).toHaveBeenCalled();
    expect(getStagedIntent(intent.id)!.disposition_reason).toBe('stale');
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
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const intent = stageIntent(
      'task.setDependsOn',
      { taskId: 't-1', dependsOn: [] },
      'proj-1',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/apply`,
    );

    expect(res.status).toBe(200);
    expect(getStagedIntent(intent.id)!.state).toBe('committed');
  });
});
