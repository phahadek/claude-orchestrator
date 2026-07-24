import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

// Isolated in-memory db (test/helpers/setupTestDb.ts) — otherwise
// staged_intent/gate_accretion/seed_accretion rows persist across test cases
// and produce spurious dedup collisions or stale markers.
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';
import { getAccretionMarker as getGateAccretionMarker } from '../../gate/gateStore';
import { getAccretionMarker as getSeedAccretionMarker } from '../../seed/seedStore';

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

async function stage(app: ReturnType<typeof buildApp>, body: unknown) {
  const res = await supertest(app).post('/api/staged-intents').send(body);
  expect(res.status).toBe(201);
  return res.body;
}

async function approve(app: ReturnType<typeof buildApp>, id: string) {
  const res = await supertest(app)
    .post(`/api/staged-intents/${id}/approve`)
    .send({});
  expect(res.status).toBe(200);
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue(makeBackend());
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('POST /api/staged-intents/group/:groupId/commit — dispatched-groom Ready-flip with in-group accretion', () => {
  it('applies a group of gate.accrete + seed.stage + setDependsOn + task.setStatus->Ready cleanly for a Code task, writing both accretion markers', async () => {
    const app = buildApp();
    const taskId = 'notion:code-task-1';
    const groupId = 'group-accretion-1';

    const gateIntent = await stage(app, {
      kind: 'gate.accrete',
      payload: {
        sourceTask: {
          id: taskId,
          title: 'Some Code task',
          project: 'polimarket-analyser',
          milestone: 'M12',
        },
        items: [],
        classification: 'n/a',
      },
      projectId: 'proj-1',
      groupId,
    });
    const seedIntent = await stage(app, {
      kind: 'seed.stage',
      payload: {
        sourceTask: {
          id: taskId,
          title: 'Some Code task',
          project: 'polimarket-analyser',
          milestone: 'M12',
        },
        seeds: [],
        decision: 'n/a',
      },
      projectId: 'proj-1',
      groupId,
    });
    const dependsOnIntent = await stage(app, {
      kind: 'task.setDependsOn',
      payload: { taskId, dependsOn: [] },
      projectId: 'proj-1',
      groupId,
    });
    const statusIntent = await stage(app, {
      kind: 'task.setStatus',
      payload: {
        taskId,
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
          type: '💻 Code',
          filesPathsEntries: [
            {
              raw: 'packages/backend/src/foo.ts',
              isNew: true,
              existsInRepo: false,
            },
          ],
        },
      },
      projectId: 'proj-1',
      groupId,
    });

    // Staging the Ready-flip intent eagerly, in the same group as the still-
    // staged accretion siblings, must not annotate it blocked — the group's
    // own gate.accrete/seed.stage will apply for real ahead of it.
    expect(statusIntent.annotation).toBeNull();

    await approve(app, gateIntent.id);
    await approve(app, seedIntent.id);
    await approve(app, dependsOnIntent.id);
    await approve(app, statusIntent.id);

    const res = await supertest(app)
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(res.status).toBe(200);
    expect(getGateAccretionMarker(taskId)).toBeDefined();
    expect(getSeedAccretionMarker(taskId)).toBeDefined();
  });

  it('still blocks a Ready-flip with no accretion staged in the group and none persisted', async () => {
    const app = buildApp();
    const taskId = 'notion:code-task-2';
    const groupId = 'group-no-accretion';

    const dependsOnIntent = await stage(app, {
      kind: 'task.setDependsOn',
      payload: { taskId, dependsOn: [] },
      projectId: 'proj-1',
      groupId,
    });
    const statusIntent = await stage(app, {
      kind: 'task.setStatus',
      payload: {
        taskId,
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
          type: '💻 Code',
          filesPathsEntries: [
            {
              raw: 'packages/backend/src/foo.ts',
              isNew: true,
              existsInRepo: false,
            },
          ],
        },
      },
      projectId: 'proj-1',
      groupId,
    });

    expect(statusIntent.annotation).toBeTruthy();
    expect(statusIntent.annotation.blocked).toBe(true);
    expect(
      statusIntent.annotation.reasons.some((r: string) =>
        r.includes('gate_contribution'),
      ),
    ).toBe(true);
    expect(
      statusIntent.annotation.reasons.some((r: string) =>
        r.includes('seed_contribution'),
      ),
    ).toBe(true);

    await approve(app, dependsOnIntent.id);
    await approve(app, statusIntent.id);

    const res = await supertest(app)
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/gate_contribution|seed_contribution/);
    expect(getGateAccretionMarker(taskId)).toBeUndefined();
    expect(getSeedAccretionMarker(taskId)).toBeUndefined();
  });
});
