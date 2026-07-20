import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

// Isolated in-memory db (test/helpers/setupTestDb.ts) instead of the real
// file-backed singleton — otherwise staged_intent rows persist across test
// cases (and test files, and CI runs) and produce spurious dedup/lock
// collisions.
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';

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

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue(makeBackend());
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('POST /api/staged-intents/:id/apply — setDependsOn group-completeness invariant', () => {
  it('rejects a task.setStatus -> Ready apply when the group has no task.setDependsOn for the same task', async () => {
    const app = buildApp();
    const intent = await stage(app, {
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'Ready' },
      projectId: 'proj-1',
      groupId: 'group-1',
    });

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/task\.setDependsOn/);
  });

  it('rejects a Ready apply when the intent has no groupId at all', async () => {
    const app = buildApp();
    const intent = await stage(app, {
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'Ready' },
      projectId: 'proj-1',
    });

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(409);
  });

  it('succeeds when the group includes a still-staged task.setDependsOn (including an empty array)', async () => {
    const app = buildApp();
    await stage(app, {
      kind: 'task.setDependsOn',
      payload: { taskId: 't-2', dependsOn: [] },
      projectId: 'proj-1',
      groupId: 'group-2',
    });
    const statusIntent = await stage(app, {
      kind: 'task.setStatus',
      payload: {
        taskId: 't-2',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
        },
      },
      projectId: 'proj-1',
      groupId: 'group-2',
    });

    const res = await supertest(app)
      .post(`/api/staged-intents/${statusIntent.id}/apply`)
      .send({});

    expect(res.status).toBe(200);
  });

  it('succeeds when the sibling task.setDependsOn was already applied earlier in the same group', async () => {
    const app = buildApp();
    const dependsOnIntent = await stage(app, {
      kind: 'task.setDependsOn',
      payload: { taskId: 't-3', dependsOn: ['t-0'] },
      projectId: 'proj-1',
      groupId: 'group-3',
    });
    const applyDeps = await supertest(app)
      .post(`/api/staged-intents/${dependsOnIntent.id}/apply`)
      .send({});
    expect(applyDeps.status).toBe(200);

    const statusIntent = await stage(app, {
      kind: 'task.setStatus',
      payload: {
        taskId: 't-3',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
        },
      },
      projectId: 'proj-1',
      groupId: 'group-3',
    });

    const res = await supertest(app)
      .post(`/api/staged-intents/${statusIntent.id}/apply`)
      .send({});

    expect(res.status).toBe(200);
  });

  it('leaves a non-Ready task.setStatus apply unaffected by the invariant', async () => {
    const app = buildApp();
    const intent = await stage(app, {
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'In Progress' },
      projectId: 'proj-1',
      groupId: 'group-4',
    });

    const res = await supertest(app)
      .post(`/api/staged-intents/${intent.id}/apply`)
      .send({});

    expect(res.status).toBe(200);
  });
});
