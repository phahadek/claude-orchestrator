/**
 * planning.noOp's acknowledge disposition: the only operator action offered
 * for a no-op marker. Unlike every other kind, acknowledge never routes
 * through applyIntent (there is nothing to apply) — it transitions the row
 * straight to `committed` and records the same staged_intent_disposition
 * audit event every other disposition uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

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
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
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
  db.prepare('DELETE FROM staged_intent').run();
  mockRecordEvent.mockClear();
});

describe('planning.noOp acknowledge disposition', () => {
  it('commits the intent without ever calling applyIntent or writing to a task store', async () => {
    const planningOrchestrator = makePlanningOrchestrator();
    const app = makeApp(planningOrchestrator);

    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-1', reason: 'already Ready, nothing to add' },
      'proj-1',
      null,
      'sess-1',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/acknowledge`,
    );

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    // applyIntent's task-store writes always flow through
    // planningOrchestrator.handleDisposition after a commit — acknowledge
    // never calls it, since there is no session decision to route back.
    expect(planningOrchestrator.handleDisposition).not.toHaveBeenCalled();
  });

  it('records an audited staged_intent_disposition naming the actor', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'planning.noOp',
      { taskId: 'task-2', reason: 'nothing to change this turn' },
      'proj-1',
      null,
      'sess-2',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/acknowledge`,
    );

    expect(res.status).toBe(200);
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'staged_intent_disposition',
        actor_type: 'human',
        payload: expect.objectContaining({
          intentId: intent.id,
          disposition: 'acknowledge',
        }),
      }),
    );
  });

  it('refuses to acknowledge a non-noOp intent', async () => {
    const app = makeApp();
    const intent = stageIntent(
      'task.setStatus',
      { taskId: 'task-3', status: 'Ready' },
      'proj-1',
      null,
      'sess-3',
    );

    const res = await supertest(app).post(
      `/api/staged-intents/${intent.id}/acknowledge`,
    );

    expect(res.status).toBe(409);
  });

  it('404s for an unknown or already-resolved intent id', async () => {
    const app = makeApp();
    const res = await supertest(app).post(
      `/api/staged-intents/does-not-exist/acknowledge`,
    );
    expect(res.status).toBe(404);
  });
});
