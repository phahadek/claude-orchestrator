/**
 * Stage-time validation of a staged intent's task references (taskId,
 * dependsOn[]) — a corrupted or unprefixed id must be caught here, not
 * discovered later as a raw provider 404 or a taskId.ts parser exception at
 * apply time. See taskId.ts's parseTaskId/normalizeTaskId for the shape
 * rules this reuses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db';
import { createStagedIntentsRouter } from '../routes/stagedIntents';
import { upsertTaskCache } from '../db/queries';

const KNOWN_TASK_IDS = new Set([
  'notion:known-task-1',
  'notion:known-task-2',
  // Ids only ever seeded into the task cache by individual tests below, not
  // fetched live before this suite's assertTaskIdResolves stopped trusting
  // the cache — must also resolve via fetchTaskPage now that every
  // existence check is a live call.
  'notion:t-1',
  'notion:3aa22f91-52f3-81a7-a58b-db94fe13e649',
  'jira:PROJ-123',
  'notion:code-2',
]);

function makeBackend() {
  return {
    type: 'notion' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn(async (taskId: string) => {
      if (KNOWN_TASK_IDS.has(taskId)) return '## Summary\nok';
      throw new Error(
        `{"object":"error","status":404,"code":"object_not_found","message":"Could not find page with ID: ${taskId}"}`,
      );
    }),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

async function stagePost(app: ReturnType<typeof buildApp>, body: unknown) {
  return supertest(app).post('/api/staged-intents').send(body);
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue(makeBackend());
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM task_cache').run();
});

describe('stage-time task reference validation', () => {
  it('rejects a taskId that names no existing task, naming the unresolvable id', async () => {
    const res = await stagePost(app(), {
      kind: 'task.setStatus',
      payload: {
        taskId: 'notion:does-not-exist',
        status: 'In Progress',
      },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('notion:does-not-exist');
  });

  it('normalizes a bare uuid dependsOn entry to the prefixed form and stages successfully', async () => {
    upsertTaskCache('notion:t-1', JSON.stringify({ status: 'In Progress' }));

    const res = await stagePost(app(), {
      kind: 'task.setDependsOn',
      payload: { taskId: 't-1', dependsOn: ['known-task-1'] },
      projectId: 'proj-1',
      groupId: 'group-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.payload).toEqual({
      taskId: 'notion:t-1',
      dependsOn: ['notion:known-task-1'],
    });
  });

  it('converges a hyphenless, a hyphenated, and a notion:-prefixed form of the same taskId subject on one canonical stored value', async () => {
    const hyphenated = '3aa22f91-52f3-81a7-a58b-db94fe13e649';
    const hyphenless = '3aa22f9152f381a7a58bdb94fe13e649';
    const canonical = `notion:${hyphenated}`;
    upsertTaskCache(canonical, JSON.stringify({ status: 'In Progress' }));

    for (const raw of [hyphenless, hyphenated, canonical]) {
      const res = await stagePost(app(), {
        kind: 'task.setStatus',
        payload: { taskId: raw, status: 'In Progress' },
        projectId: 'proj-1',
      });
      expect(res.status).toBe(201);
      expect(res.body.payload.taskId).toBe(canonical);
    }
  });

  it('preserves a non-Notion source prefix — a jira-backed taskId is not coerced to a notion-shaped id', async () => {
    upsertTaskCache('jira:PROJ-123', JSON.stringify({ status: 'In Progress' }));

    const res = await stagePost(app(), {
      kind: 'task.setStatus',
      payload: { taskId: 'jira:PROJ-123', status: 'In Progress' },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.payload.taskId).toBe('jira:PROJ-123');
  });

  it('normalizes a gate.accrete sourceTask.id on the same rule as a taskId subject', async () => {
    upsertTaskCache(
      'notion:3aa22f91-52f3-81a7-a58b-db94fe13e649',
      JSON.stringify({ type: '💻 Code' }),
    );

    const res = await stagePost(app(), {
      kind: 'gate.accrete',
      payload: {
        sourceTask: {
          id: '3aa22f9152f381a7a58bdb94fe13e649',
          title: 'Some Code task',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [{ text: 'Launch-and-observe the new endpoint' }],
        classification: 'Human-Observation',
      },
      projectId: 'proj-1',
      groupId: 'group-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.payload.sourceTask.id).toBe(
      'notion:3aa22f91-52f3-81a7-a58b-db94fe13e649',
    );
  });

  it('rejects an unparseable id, naming the offending value and the expected shape', async () => {
    const res = await stagePost(app(), {
      kind: 'task.setStatus',
      payload: {
        taskId: 'bogus-source:some-id',
        status: 'In Progress',
      },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('bogus-source:some-id');
    expect(res.body.error).toContain('source:externalId');
  });

  it('stages a task.create with no subject id while still validating its dependsOn entries', async () => {
    const ok = await stagePost(app(), {
      kind: 'task.create',
      payload: {
        title: 'A new task',
        dependsOn: ['notion:known-task-1', 'known-task-2'],
      },
      projectId: 'proj-1',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.payload.dependsOn).toEqual([
      'notion:known-task-1',
      'notion:known-task-2',
    ]);

    const bad = await stagePost(app(), {
      kind: 'task.create',
      payload: {
        title: 'Another new task',
        dependsOn: ['notion:missing-task'],
      },
      projectId: 'proj-1',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('notion:missing-task');
  });

  it('rejects a near-miss uuid outright rather than resolving it to a similar task', async () => {
    upsertTaskCache(
      'notion:3a922f91-52f3-8151-a8e6-f513f7b9de4d',
      JSON.stringify({ status: 'In Progress' }),
    );

    const res = await stagePost(app(), {
      kind: 'task.setStatus',
      // Single-character corruption vs. the cached id above.
      payload: {
        taskId: 'notion:3a922f91-52f3-8151-9de8-e513f7b9de4d',
        status: 'In Progress',
      },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(
      'notion:3a922f91-52f3-8151-9de8-e513f7b9de4d',
    );
  });

  it.each([
    ['task.updateBody', { taskId: 'notion:missing', sections: {} }],
    [
      'task.patchBodySection',
      {
        taskId: 'notion:missing',
        section: 'Summary',
        op: 'append',
        markdown: 'x',
      },
    ],
    [
      'task.setProperties',
      { taskId: 'notion:missing', patch: { priority: 'P1' } },
    ],
    ['task.setDependsOn', { taskId: 'notion:missing', dependsOn: [] }],
  ])('validates %s against the task store', async (kind, payload) => {
    const res = await stagePost(app(), { kind, payload, projectId: 'proj-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('notion:missing');
  });

  it('leaves a valid intent unaffected — no extra rejection on the happy path', async () => {
    upsertTaskCache(
      'notion:known-task-1',
      JSON.stringify({ status: 'Backlog' }),
    );

    const res = await stagePost(app(), {
      kind: 'task.setStatus',
      payload: { taskId: 'notion:known-task-1', status: 'In Progress' },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(201);
    expect(res.body.payload.taskId).toBe('notion:known-task-1');
  });
});

describe('Investigation accretion rejection', () => {
  it('rejects a gate.accrete whose source task is 🔎 Investigation, naming the type as the reason', async () => {
    upsertTaskCache(
      'notion:investigation-1',
      JSON.stringify({ type: '🔎 Investigation' }),
    );

    const res = await stagePost(app(), {
      kind: 'gate.accrete',
      payload: {
        sourceTask: {
          id: 'notion:investigation-1',
          title: 'Some Investigation',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [{ text: 'Confirm the falsification run was performed' }],
        classification: 'Human-Observation',
      },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('🔎 Investigation');
  });

  it('allows a gate.accrete whose source task is 🔧 Operational', async () => {
    upsertTaskCache(
      'notion:operational-1',
      JSON.stringify({ type: '🔧 Operational' }),
    );

    const res = await stagePost(app(), {
      kind: 'gate.accrete',
      payload: {
        sourceTask: {
          id: 'notion:operational-1',
          title: 'Some Operational task',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [{ text: 'Confirm the backfill landed' }],
        classification: 'Human-Observation',
      },
      projectId: 'proj-1',
      groupId: 'group-1',
    });

    expect(res.status).toBe(201);
  });

  it('allows a gate.accrete whose source task is 💻 Code (no regression)', async () => {
    upsertTaskCache('notion:code-1', JSON.stringify({ type: '💻 Code' }));

    const res = await stagePost(app(), {
      kind: 'gate.accrete',
      payload: {
        sourceTask: {
          id: 'notion:code-1',
          title: 'Some Code task',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [{ text: 'Launch-and-observe the new endpoint' }],
        classification: 'Human-Observation',
      },
      projectId: 'proj-1',
      groupId: 'group-1',
    });

    expect(res.status).toBe(201);
  });

  it('rejects a task.patchBodySection remove of 👁️ Manual verification on an 🔎 Investigation task', async () => {
    upsertTaskCache(
      'notion:investigation-2',
      JSON.stringify({ type: '🔎 Investigation' }),
    );

    const res = await stagePost(app(), {
      kind: 'task.patchBodySection',
      payload: {
        taskId: 'notion:investigation-2',
        section: '👁️ Manual verification',
        operation: 'remove',
      },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('🔎 Investigation');
  });

  it('allows a task.patchBodySection remove of Manual verification on a 💻 Code task', async () => {
    upsertTaskCache('notion:code-2', JSON.stringify({ type: '💻 Code' }));

    const res = await stagePost(app(), {
      kind: 'task.patchBodySection',
      payload: {
        taskId: 'notion:code-2',
        section: '👁️ Manual verification',
        operation: 'remove',
      },
      projectId: 'proj-1',
    });

    expect(res.status).toBe(201);
  });
});

function app() {
  return buildApp();
}
