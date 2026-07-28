import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { TaskBodySections } from '../../tasks/bodyRender';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tasks/TaskBackend')>();
  return { ...actual, getTaskBackend: mockGetTaskBackend };
});

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { composeSplitIntents, stageSplitIntents, ORIGINAL_REF } =
  await import('../splitSession');
const { db } = await import('../../db/db');
const { createStagedIntentsRouter } = await import('../../routes/stagedIntents');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

function sections(summary: string): TaskBodySections {
  return {
    summary,
    dependencies: [],
    context: [],
    automatedCriteria: ['passes'],
    manualCriteria: [],
  };
}

describe('composeSplitIntents', () => {
  it('stages updateBody on the original + N-1 createTask + intra-split setDependsOn, and populates size_check.split_into', () => {
    const result = composeSplitIntents({
      projectId: 'proj-1',
      original: {
        id: 'notion:original-id',
        sections: sections('Narrowed to subset A'),
      },
      siblings: [
        {
          ref: 'sibling-1',
          fields: { databaseId: 'db-1', title: 'Subset B' },
        },
        {
          ref: 'sibling-2',
          fields: { databaseId: 'db-1', title: 'Subset C' },
          dependsOn: ['sibling-1', ORIGINAL_REF],
        },
      ],
    });

    // The original ID is unchanged — updateBody, not a new task.
    const updateBodyIntent = result.intents.find(
      (i) => i.kind === 'task.updateBody',
    );
    expect(updateBodyIntent).toBeDefined();
    expect((updateBodyIntent!.payload as { taskId: string }).taskId).toBe(
      'notion:original-id',
    );
    expect(
      (updateBodyIntent!.payload as { sections: TaskBodySections }).sections
        .summary,
    ).toBe('Narrowed to subset A');

    // N-1 createTask intents, at Backlog (createTask fields never carry status).
    const createIntents = result.intents.filter(
      (i) => i.kind === 'task.create',
    );
    expect(createIntents).toHaveLength(2);
    expect(
      createIntents.map((i) => (i.payload as { title: string }).title),
    ).toEqual(['Subset B', 'Subset C']);

    // Intra-split setDependsOn — only sibling-2 declared deps.
    const dependsOnIntents = result.intents.filter(
      (i) => i.kind === 'task.setDependsOn',
    );
    expect(dependsOnIntents).toHaveLength(1);
    const dependsOnPayload = dependsOnIntents[0].payload as {
      taskId: string;
      dependsOn: string[];
    };
    expect(dependsOnPayload.taskId).toBe('$ref:sibling-2');
    expect(dependsOnPayload.dependsOn).toEqual([
      '$ref:sibling-1',
      'notion:original-id',
    ]);

    // size_check.split_into populated with the new sibling refs.
    expect(result.sizeCheck).toEqual({
      decision: 'split_now',
      splitInto: ['$ref:sibling-1', '$ref:sibling-2'],
    });

    // All intents share one groupId so the display can present them as one unit.
    const groupIds = new Set(result.intents.map((i) => i.groupId));
    expect(groupIds.size).toBe(1);
  });

  it('throws when there are no siblings (a split needs at least one sibling)', () => {
    expect(() =>
      composeSplitIntents({
        projectId: 'proj-1',
        original: { id: 'notion:original-id', sections: sections('x') },
        siblings: [],
      }),
    ).toThrow(/at least one sibling/);
  });

  it('rejects a sibling ref that collides with the reserved original ref', () => {
    expect(() =>
      composeSplitIntents({
        projectId: 'proj-1',
        original: { id: 'notion:original-id', sections: sections('x') },
        siblings: [
          { ref: ORIGINAL_REF, fields: { databaseId: 'db-1', title: 'x' } },
        ],
      }),
    ).toThrow(/reserved/);
  });
});

describe('stageSplitIntents', () => {
  it('stages the composed updateBody + task.create sibling intents on the shared staged-intent display', () => {
    const result = stageSplitIntents({
      projectId: 'proj-1',
      original: {
        id: 'notion:original-id',
        sections: sections('Narrowed to subset A'),
      },
      siblings: [
        { ref: 'sibling-1', fields: { databaseId: 'db-1', title: 'Subset B' } },
      ],
    });

    expect(result.staged).toHaveLength(2);
    const kinds = result.staged.map((s) => s.kind).sort();
    expect(kinds).toEqual(['task.create', 'task.updateBody']);
    expect(result.staged.every((s) => s.state === 'staged')).toBe(true);
    expect(result.sizeCheck).toEqual({
      decision: 'split_now',
      splitInto: ['$ref:sibling-1'],
    });

    const rows = db
      .prepare('SELECT kind, project_id, group_id FROM staged_intent')
      .all() as { kind: string; project_id: string; group_id: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
    expect(rows.every((r) => r.project_id === 'proj-1')).toBe(true);
  });
});

describe('committing a split group resolves $ref placeholders', () => {
  async function approveAndCommit(groupId: string, stagedIds: string[]) {
    const app = makeApp();
    const agent = supertest(app);
    for (const id of stagedIds) {
      const approved = await agent
        .post(`/api/staged-intents/${id}/approve`)
        .send({});
      expect(approved.status).toBe(200);
    }
    return agent.post(`/api/staged-intents/group/${groupId}/commit`).send({});
  }

  it('commits a sibling depending on another sibling — the stored dependency holds the real created task id, no $ref remains', async () => {
    const createTask = vi.fn();
    createTask
      .mockResolvedValueOnce('notion:sibling-1-id')
      .mockResolvedValueOnce('notion:sibling-2-id');
    const setDependsOn = vi.fn().mockResolvedValue(undefined);
    const updateBody = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
      setDependsOn,
      updateBody,
    });

    const { staged, groupId } = stageSplitIntents({
      projectId: 'proj-1',
      original: {
        id: 'notion:original-id',
        sections: sections('Narrowed to subset A'),
      },
      siblings: [
        { ref: 'sibling-1', fields: { databaseId: 'db-1', title: 'Subset B' } },
        {
          ref: 'sibling-2',
          fields: { databaseId: 'db-1', title: 'Subset C' },
          dependsOn: ['sibling-1'],
        },
      ],
    });

    // Even before commit, the staged task.setDependsOn payload already
    // carries the `staged-intent:<id>` symbolic reference, not a bare
    // `$ref:<ref>` token — stageSplitIntents rewrites it at stage time.
    const dependsOnRow = db
      .prepare(`SELECT payload FROM staged_intent WHERE kind = 'task.setDependsOn'`)
      .get() as { payload: string };
    expect(dependsOnRow.payload).not.toContain('$ref:');

    const result = await approveAndCommit(
      groupId,
      staged.map((s) => s.id),
    );

    expect(result.status).toBe(200);
    expect(createTask).toHaveBeenCalledTimes(2);
    // The $ref tag never reaches the backend's createTask call.
    for (const [fields] of createTask.mock.calls) {
      expect(fields).not.toHaveProperty('$ref');
    }

    expect(setDependsOn).toHaveBeenCalledTimes(1);
    const [depTaskId, depsOn] = setDependsOn.mock.calls[0];
    expect(depTaskId).toBe('notion:sibling-2-id');
    expect(depsOn).toEqual(['notion:sibling-1-id']);
    expect(depTaskId).not.toContain('$ref:');
    for (const dep of depsOn) {
      expect(dep).not.toContain('$ref:');
    }
  });

  it('commits a sibling depending on the original, already-existing task exactly as today', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:sibling-1-id');
    const setDependsOn = vi.fn().mockResolvedValue(undefined);
    const updateBody = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
      setDependsOn,
      updateBody,
    });

    const { staged, groupId } = stageSplitIntents({
      projectId: 'proj-1',
      original: {
        id: 'notion:original-id',
        sections: sections('Narrowed to subset A'),
      },
      siblings: [
        {
          ref: 'sibling-1',
          fields: { databaseId: 'db-1', title: 'Subset B' },
          dependsOn: [ORIGINAL_REF],
        },
      ],
    });

    const result = await approveAndCommit(
      groupId,
      staged.map((s) => s.id),
    );

    expect(result.status).toBe(200);
    expect(setDependsOn).toHaveBeenCalledTimes(1);
    const [depTaskId, depsOn] = setDependsOn.mock.calls[0];
    expect(depTaskId).toBe('notion:sibling-1-id');
    expect(depsOn).toEqual(['notion:original-id']);
  });
});
