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

async function approve(app: ReturnType<typeof buildApp>, id: string) {
  const res = await supertest(app)
    .post(`/api/staged-intents/${id}/approve`)
    .send({});
  expect(res.status).toBe(200);
}

// Grouped intents are only ever written through the group's atomic commit
// route (Approve->Commit unification) — POST /:id/apply is standalone-only
// and 409s for any intent carrying a group_id, so these cases exercise the
// invariant via approve + group commit instead of a direct apply.
describe('POST /api/staged-intents/group/:groupId/commit — setDependsOn group-completeness invariant', () => {
  it('rejects a task.setStatus -> Ready commit when the group has no task.setDependsOn for the same task', async () => {
    const app = buildApp();
    const intent = await stage(app, {
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'Ready' },
      projectId: 'proj-1',
      groupId: 'group-1',
    });
    await approve(app, intent.id);

    const res = await supertest(app)
      .post('/api/staged-intents/group/group-1/commit')
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

  it('succeeds when the group includes a still-staged (now approved) task.setDependsOn (including an empty array)', async () => {
    const app = buildApp();
    const dependsOnIntent = await stage(app, {
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
    await approve(app, dependsOnIntent.id);
    await approve(app, statusIntent.id);

    const res = await supertest(app)
      .post('/api/staged-intents/group/group-2/commit')
      .send({});

    expect(res.status).toBe(200);
  });

  it('succeeds when the sibling task.setDependsOn was already committed earlier in the same group', async () => {
    const app = buildApp();
    const dependsOnIntent = await stage(app, {
      kind: 'task.setDependsOn',
      payload: { taskId: 't-3', dependsOn: ['t-0'] },
      projectId: 'proj-1',
      groupId: 'group-3',
    });
    await approve(app, dependsOnIntent.id);
    const firstCommit = await supertest(app)
      .post('/api/staged-intents/group/group-3/commit')
      .send({});
    expect(firstCommit.status).toBe(200);

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
    await approve(app, statusIntent.id);

    const res = await supertest(app)
      .post('/api/staged-intents/group/group-3/commit')
      .send({});

    expect(res.status).toBe(200);
  });

  it('leaves a non-Ready task.setStatus commit unaffected by the invariant', async () => {
    const app = buildApp();
    const intent = await stage(app, {
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'In Progress' },
      projectId: 'proj-1',
      groupId: 'group-4',
    });
    await approve(app, intent.id);

    const res = await supertest(app)
      .post('/api/staged-intents/group/group-4/commit')
      .send({});

    expect(res.status).toBe(200);
  });
});
