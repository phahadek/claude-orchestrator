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
import {
  createStagedIntentsRouter,
  READY_PATH_KINDS,
  stageIntent,
} from '../stagedIntents';

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

/**
 * gate.accrete / seed.stage resolve their sourceTask's milestone against a
 * real project (resolveMilestoneForProject -> ProjectService.getById) —
 * seed a project + milestone row so that lookup succeeds.
 */
function insertProjectWithMilestone(
  projectId: string,
  milestone: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, projectId, `/tmp/${projectId}`, 'notion', now, now);
  db.prepare(
    `INSERT INTO milestones (id, project_id, name, source_id, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${projectId}-ms`, projectId, milestone, null, 0, now, now);
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

  it('rejects staging a task.setStatus -> Ready intent with no groupId at all', async () => {
    const app = buildApp();

    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'task.setStatus',
        payload: { taskId: 't-1', status: 'Ready' },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Ready-path member/);
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

// The stage-time enforcement of the Ready-path grouping invariant: staging
// gate.accrete, seed.stage, task.setDependsOn, or a task.setStatus targeting
// Ready without a groupId is rejected before the row ever reaches `staged`,
// naming the Ready-path member set so a session can self-correct in-turn —
// the same actionable shape as the DependsOnCompletenessError guard above,
// but closing the gap that guard leaves open: an intent staged with no
// group at all belongs to no group, so a commit-time within-group check
// never sees it.
describe('stageIntent — Ready-path member set requires a groupId at stage time', () => {
  it('rejects staging gate.accrete without a groupId, naming the missing groupId', () => {
    expect(() =>
      stageIntent(
        'gate.accrete',
        {
          sourceTask: {
            id: 't-1',
            title: 'T',
            project: 'proj-1',
            milestone: 'M1',
          },
          items: [],
          classification: 'n/a',
          reason: 'exempt',
        },
        'proj-1',
      ),
    ).toThrow(/groupId/);
  });

  it('rejects staging seed.stage without a groupId, naming the missing groupId', () => {
    expect(() =>
      stageIntent(
        'seed.stage',
        {
          sourceTask: {
            id: 't-1',
            title: 'T',
            project: 'proj-1',
            milestone: 'M1',
          },
          seeds: [],
          decision: 'n/a',
        },
        'proj-1',
      ),
    ).toThrow(/groupId/);
  });

  it('rejects staging task.setDependsOn without a groupId, naming the missing groupId', () => {
    expect(() =>
      stageIntent(
        'task.setDependsOn',
        { taskId: 't-1', dependsOn: [] },
        'proj-1',
      ),
    ).toThrow(/groupId/);
  });

  it('rejects staging task.setStatus targeting Ready without a groupId', () => {
    expect(() =>
      stageIntent(
        'task.setStatus',
        { taskId: 't-1', status: 'Ready' },
        'proj-1',
      ),
    ).toThrow(/groupId/);
  });

  it('still allows staging task.setStatus targeting Deferred without a groupId', () => {
    expect(() =>
      stageIntent(
        'task.setStatus',
        { taskId: 't-1', status: 'Deferred' },
        'proj-1',
      ),
    ).not.toThrow();
  });

  it('still allows staging decision.pickOne without a groupId, and still rejects it with one', () => {
    expect(() =>
      stageIntent(
        'decision.pickOne',
        {
          prompt: 'Which approach?',
          options: [
            { label: 'A', description: 'first' },
            { label: 'B', description: 'second' },
          ],
          allowFreeForm: false,
        },
        'proj-1',
        null,
        'sess-1',
        'A genuine fork the session cannot resolve confidently.',
      ),
    ).not.toThrow();

    expect(() =>
      stageIntent(
        'decision.pickOne',
        {
          prompt: 'A different question?',
          options: [
            { label: 'A', description: 'first' },
            { label: 'B', description: 'second' },
          ],
          allowFreeForm: false,
        },
        'proj-1',
        'group-1',
        'sess-1',
        'A genuine fork the session cannot resolve confidently.',
      ),
    ).toThrow(/cannot belong to a group/);
  });

  it('still allows staging planning.noOp without a groupId', () => {
    expect(() =>
      stageIntent(
        'planning.noOp',
        { taskId: 't-1', reason: 'nothing to change this pass' },
        'proj-1',
      ),
    ).not.toThrow();
  });

  it('stages a full Ready-path set sharing one groupId unchanged', async () => {
    const app = buildApp();
    insertProjectWithMilestone('proj-1', 'M1');
    const groupId = 'group-full-ready-path';

    const dependsOn = await stage(app, {
      kind: 'task.setDependsOn',
      payload: { taskId: 't-full', dependsOn: [] },
      projectId: 'proj-1',
      groupId,
    });
    const gateAccrete = await stage(app, {
      kind: 'gate.accrete',
      payload: {
        sourceTask: {
          id: 't-full',
          title: 'T',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [],
        classification: 'n/a',
        reason: 'exempt',
      },
      projectId: 'proj-1',
      groupId,
    });
    const seedStage = await stage(app, {
      kind: 'seed.stage',
      payload: {
        sourceTask: {
          id: 't-full',
          title: 'T',
          project: 'proj-1',
          milestone: 'M1',
        },
        seeds: [],
        decision: 'n/a',
      },
      projectId: 'proj-1',
      groupId,
    });
    const setStatus = await stage(app, {
      kind: 'task.setStatus',
      payload: {
        taskId: 't-full',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
        },
      },
      projectId: 'proj-1',
      groupId,
    });

    expect(
      [dependsOn, gateAccrete, seedStage, setStatus].map((i) => i.groupId),
    ).toEqual([groupId, groupId, groupId, groupId]);

    await approve(app, dependsOn.id);
    await approve(app, gateAccrete.id);
    await approve(app, seedStage.id);
    await approve(app, setStatus.id);

    const res = await supertest(app)
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});
    expect(res.status).toBe(200);
  });

  it('names the Ready-path member set in the rejection error, so a session can self-correct from the message alone', () => {
    let error: Error | undefined;
    try {
      stageIntent(
        'task.setDependsOn',
        { taskId: 't-1', dependsOn: [] },
        'proj-1',
      );
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    for (const kind of READY_PATH_KINDS) {
      expect(error!.message).toContain(kind);
    }
  });

  it('single-sources the Ready-path member set — the same set the commit-time completeness guard checks against', () => {
    expect(READY_PATH_KINDS).toEqual(
      expect.arrayContaining([
        'gate.accrete',
        'seed.stage',
        'task.setDependsOn',
        'task.setStatus',
      ]),
    );
    expect(READY_PATH_KINDS).toHaveLength(4);
  });
});
