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
import { upsertTaskCache, insertProject, insertMilestone } from '../db/queries';
import type { NotionTask } from '../notion/types';

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
  'notion:cyc-a',
  'notion:cyc-b',
  'notion:cyc-c',
  'notion:cyc-x',
  'notion:l1',
  'notion:l2',
  'notion:l3',
  'notion:l4',
  'notion:l5',
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
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
});

/** A NotionTask fixture as it would appear in a board's task_cache row. */
function boardTask(
  id: string,
  dependsOn: string[] = [],
  overrides: Partial<NotionTask> = {},
): NotionTask {
  return {
    id,
    title: `Task ${id}`,
    status: '🗂️ Ready',
    type: '💻 Code',
    dependsOn,
    notionUrl: `https://notion.so/${id}`,
    ...overrides,
  };
}

/** Registers a project with one milestone board seeded in task_cache — the reverse-edge data assertNoDependencyCycle walks. */
function seedBoard(
  projectId: string,
  milestoneId: string,
  tasks: NotionTask[],
) {
  insertProject({
    id: projectId,
    name: projectId,
    project_dir: `/tmp/${projectId}`,
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
  insertMilestone({
    id: milestoneId,
    project_id: projectId,
    name: milestoneId,
    source_id: null,
    canonical_short_id: null,
    wrapped_at: null,
  });
  upsertTaskCache(`board:${milestoneId}`, JSON.stringify(tasks));
}

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

describe('dependency cycle validation', () => {
  it('rejects a task.setDependsOn closing a two-node cycle, naming both task ids', async () => {
    seedBoard('proj-cycle-2', 'm-2node', [boardTask('cyc-a', ['cyc-b'])]);

    const res = await stagePost(app(), {
      kind: 'task.setDependsOn',
      payload: { taskId: 'notion:cyc-b', dependsOn: ['notion:cyc-a'] },
      projectId: 'proj-cycle-2',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('notion:cyc-a');
    expect(res.body.error).toContain('notion:cyc-b');
  });

  it('rejects a task.setDependsOn closing a three-node cycle, naming all three ids in path order', async () => {
    // Mirrors the observed M15 case: 81d5 -> 8161 -> 81ce -> back to 81d5.
    seedBoard('proj-cycle-3', 'm-3node', [
      boardTask('cyc-b', ['cyc-c']),
      boardTask('cyc-c', ['cyc-a']),
    ]);

    const res = await stagePost(app(), {
      kind: 'task.setDependsOn',
      payload: { taskId: 'notion:cyc-a', dependsOn: ['notion:cyc-b'] },
      projectId: 'proj-cycle-3',
    });

    expect(res.status).toBe(400);
    const idx = (id: string) => res.body.error.indexOf(id);
    expect(idx('notion:cyc-a')).toBeGreaterThanOrEqual(0);
    expect(idx('notion:cyc-b')).toBeGreaterThan(idx('notion:cyc-a'));
    expect(idx('notion:cyc-c')).toBeGreaterThan(idx('notion:cyc-b'));
  });

  it('rejects a task.create whose dependsOn attaches to an already-cyclic subgraph, on the same code path as task.setDependsOn', async () => {
    seedBoard('proj-cycle-create', 'm-create', [
      boardTask('cyc-x', ['cyc-y']),
      boardTask('cyc-y', ['cyc-x']),
    ]);

    const res = await stagePost(app(), {
      kind: 'task.create',
      payload: { title: 'New task', dependsOn: ['notion:cyc-x'] },
      projectId: 'proj-cycle-create',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('notion:cyc-x');
  });

  it('rejects a self-dependency', async () => {
    const res = await stagePost(app(), {
      kind: 'task.setDependsOn',
      payload: { taskId: 'notion:cyc-a', dependsOn: ['notion:cyc-a'] },
      projectId: 'proj-cycle-self',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('notion:cyc-a');
  });

  it('accepts a legitimate deep (4-level) acyclic dependency chain spanning two milestone boards', async () => {
    insertProject({
      id: 'proj-cycle-deep',
      name: 'proj-cycle-deep',
      project_dir: '/tmp/proj-cycle-deep',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: 'm-deep-1',
      project_id: 'proj-cycle-deep',
      name: 'm-deep-1',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    insertMilestone({
      id: 'm-deep-2',
      project_id: 'proj-cycle-deep',
      name: 'm-deep-2',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    upsertTaskCache(
      'board:m-deep-1',
      JSON.stringify([boardTask('l2', ['l3']), boardTask('l4', [])]),
    );
    upsertTaskCache(
      'board:m-deep-2',
      JSON.stringify([boardTask('l3', ['l4'])]),
    );

    const res = await stagePost(app(), {
      kind: 'task.setDependsOn',
      payload: { taskId: 'notion:l1', dependsOn: ['notion:l2'] },
      projectId: 'proj-cycle-deep',
      groupId: 'group-deep',
    });

    expect(res.status).toBe(201);
  });

  it('fails open (allows the write) when a board needed to complete the reverse walk has no task_cache row', async () => {
    insertProject({
      id: 'proj-cycle-cold',
      name: 'proj-cycle-cold',
      project_dir: '/tmp/proj-cycle-cold',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertMilestone({
      id: 'm-cold-cached',
      project_id: 'proj-cycle-cold',
      name: 'm-cold-cached',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    insertMilestone({
      id: 'm-cold-uncached',
      project_id: 'proj-cycle-cold',
      name: 'm-cold-uncached',
      source_id: null,
      canonical_short_id: null,
      wrapped_at: null,
    });
    // cyc-a depends on a task that would live on the uncached board — were
    // that board cached and that task found depending back on cyc-b, this
    // would be a real cycle. With it uncached, the walk can't be completed.
    upsertTaskCache(
      'board:m-cold-cached',
      JSON.stringify([boardTask('cyc-a', ['cyc-mid'])]),
    );
    // No upsertTaskCache call for m-cold-uncached — no task_cache row at all.

    const res = await stagePost(app(), {
      kind: 'task.setDependsOn',
      payload: { taskId: 'notion:cyc-b', dependsOn: ['notion:cyc-a'] },
      projectId: 'proj-cycle-cold',
      groupId: 'group-cold',
    });

    expect(res.status).toBe(201);
  });

  it('issues zero Notion network calls — resolution is served from task_cache only', async () => {
    seedBoard('proj-cycle-net', 'm-net', [boardTask('cyc-a', ['cyc-c'])]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const res = await stagePost(app(), {
        kind: 'task.setDependsOn',
        payload: { taskId: 'notion:cyc-b', dependsOn: ['notion:cyc-a'] },
        projectId: 'proj-cycle-net',
        groupId: 'group-net',
      });
      expect(res.status).toBe(201);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

function app() {
  return buildApp();
}
