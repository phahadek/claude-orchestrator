import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

// Isolated in-memory db, matching stagedIntents.dependsOnGate.test.ts's setup
// — otherwise staged_intent / gate_accretion / seed_accretion rows persist
// across test cases and produce spurious dedup collisions or stale markers.
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function makeBackend() {
  return {
    type: 'local' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(''),
  };
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue(makeBackend());
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('POST /api/staged-intents — stage-time gate/seed accretion feedback', () => {
  it('annotates a Code task.setStatus -> Ready intent staged with no gate/seed accretion marker', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'task.setStatus',
        payload: {
          taskId: 'notion:no-accretion',
          status: 'Ready',
          groomingGate: {
            size_check: { decision: 'n/a' },
            type_check: { decision: 'none' },
            type: '💻 Code',
          },
        },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.annotation).toBeTruthy();
    expect(res.body.annotation.blocked).toBe(true);
    expect(
      res.body.annotation.reasons.some((r: string) =>
        r.includes('gate_contribution'),
      ),
    ).toBe(true);
    expect(
      res.body.annotation.reasons.some((r: string) =>
        r.includes('seed_contribution'),
      ),
    ).toBe(true);
  });

  it('does not annotate when both accretion markers are already recorded', async () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:has-accretion',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 'notion:has-accretion',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });

    const app = buildApp();
    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'task.setStatus',
        payload: {
          taskId: 'notion:has-accretion',
          status: 'Ready',
          groomingGate: {
            size_check: { decision: 'n/a' },
            type_check: { decision: 'none' },
            type: '💻 Code',
          },
        },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.annotation).toBeNull();
  });

  it('does not annotate a non-Ready task.setStatus intent', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'task.setStatus',
        payload: {
          taskId: 'notion:in-progress',
          status: 'In Progress',
        },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(201);
    expect(res.body.annotation).toBeNull();
  });
});
