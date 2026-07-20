/**
 * Route-level tests for the staged-intents apply chokepoint's Ready-transition
 * readiness-gate wiring: a blocked apply surfaces the structured report on the
 * staged intent instead of discarding it, and override + reason applies the
 * intent and records an audit event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockRecordEvent } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import { createStagedIntentsRouter } from '../routes/stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
});

/**
 * A Ready-transition apply also runs through the DependsOnCompleteness
 * invariant (stagedIntents.ts) and the grooming promotion gate
 * (TaskWriteCommands.setStatus) before it ever reaches the readiness gate
 * under test here — stage a satisfying task.setDependsOn sibling in the
 * same group plus a fully-dispositioned groomingGate so those two clear and
 * only the readiness gate is exercised.
 */
async function stageReadyStatus(
  agent: ReturnType<typeof supertest>,
  projectId: string,
  taskId: string,
  groupId: string,
) {
  await agent.post('/api/staged-intents').send({
    kind: 'task.setDependsOn',
    projectId,
    groupId,
    payload: { taskId, dependsOn: [] },
  });
  return agent.post('/api/staged-intents').send({
    kind: 'task.setStatus',
    projectId,
    groupId,
    payload: {
      taskId,
      status: 'Ready',
      groomingGate: {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
      },
    },
  });
}

describe('POST /api/staged-intents/:id/apply — readiness gate', () => {
  it('blocks a Ready transition with an unresolved Open Questions section, and keeps the intent staged with an annotation', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still unresolved?\n'),
      updateStatus: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await stageReadyStatus(
      agent,
      'proj-blocked',
      'notion:abc',
      'group-blocked',
    );
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(409);
    expect(applied.body.violations).toEqual([
      expect.objectContaining({ tier: 'structural' }),
    ]);

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-blocked' });
    const statusIntent = list.body.intents.find(
      (i: { kind: string }) => i.kind === 'task.setStatus',
    );
    expect(statusIntent.annotation).toEqual({
      blocked: true,
      violations: expect.arrayContaining([
        expect.objectContaining({ tier: 'structural' }),
      ]),
    });
  });

  it('applies with override + reason and records an audit event with actor, reason, and tier', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still unresolved?\n'),
      updateStatus,
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await stageReadyStatus(
      agent,
      'proj-2',
      'notion:abc',
      'group-2',
    );

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({ override: true, reason: 'reviewed manually, safe to proceed' });

    expect(applied.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'readiness_override',
        actor_type: 'human',
        payload: expect.objectContaining({
          reason: 'reviewed manually, safe to proceed',
          tiers: ['structural'],
        }),
      }),
    );

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-2' });
    expect(
      list.body.intents.some(
        (i: { kind: string }) => i.kind === 'task.setStatus',
      ),
    ).toBe(false);
  });

  it('requires a reason when override is true', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(''),
      updateStatus: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-no-reason',
      payload: { taskId: 'notion:abc', status: 'Ready' },
    });

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({ override: true });
    expect(applied.status).toBe(400);
  });

  it('applies a clean Ready transition without override', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll clear.'),
      updateStatus,
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await stageReadyStatus(
      agent,
      'proj-clean',
      'notion:abc',
      'group-clean',
    );

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
  });
});

describe('POST /api/staged-intents/:id/apply — grooming promotion gate', () => {
  it('blocks a Ready transition whose staged groomingGate entry is undispositioned, and keeps the intent staged with an annotation', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll clear.'),
      updateStatus,
    });
    const app = makeApp();
    const agent = supertest(app);

    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-groom-blocked',
      groupId: 'group-groom-blocked',
      payload: { taskId: 'notion:abc', dependsOn: [] },
    });
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-groom-blocked',
      groupId: 'group-groom-blocked',
      payload: {
        taskId: 'notion:abc',
        status: 'Ready',
        groomingGate: { size_check: null, type_check: null },
      },
    });
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(409);
    expect(applied.body.reasons.join(' ')).toMatch(/size_check/);
    expect(updateStatus).not.toHaveBeenCalled();

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-groom-blocked' });
    const statusIntent = list.body.intents.find(
      (i: { kind: string }) => i.kind === 'task.setStatus',
    );
    expect(statusIntent.annotation).toEqual({
      blocked: true,
      reasons: expect.arrayContaining([expect.stringMatching(/size_check/)]),
    });
  });

  it('applies a Ready transition whose staged groomingGate entry is fully dispositioned', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll clear.'),
      updateStatus,
    });
    const app = makeApp();
    const agent = supertest(app);

    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-groom-clean',
      groupId: 'group-groom-clean',
      payload: { taskId: 'notion:abc', dependsOn: [] },
    });
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-groom-clean',
      groupId: 'group-groom-clean',
      payload: {
        taskId: 'notion:abc',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'no_split' },
          type_check: { decision: 'none' },
        },
      },
    });

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
  });
});

describe('POST /api/staged-intents — kind validation', () => {
  it('accepts task.updateBody, task.setProperties, and task.archive', async () => {
    const app = makeApp();
    const agent = supertest(app);

    for (const kind of [
      'task.updateBody',
      'task.setProperties',
      'task.setType',
      'task.archive',
      'task.move',
    ]) {
      const res = await agent.post('/api/staged-intents').send({
        kind,
        projectId: 'proj-kinds',
        payload: { taskId: 'notion:abc' },
      });
      expect(res.status).toBe(201);
    }
  });

  it('rejects an unknown intent kind', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const res = await agent
      .post('/api/staged-intents')
      .send({ kind: 'task.doSomethingUnknown', projectId: 'proj-kinds' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/staged-intents/:id/apply — new kinds', () => {
  it('applies task.updateBody, task.setProperties, and task.archive', async () => {
    const updateBody = vi.fn().mockResolvedValue(undefined);
    const setProperties = vi.fn().mockResolvedValue(undefined);
    const archive = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      updateBody,
      setProperties,
      archive,
    });
    const app = makeApp();
    const agent = supertest(app);

    const bodyIntent = await agent.post('/api/staged-intents').send({
      kind: 'task.updateBody',
      projectId: 'proj-new-kinds',
      payload: { taskId: 'notion:abc', sections: { summary: 'hi' } },
    });
    const bodyApplied = await agent
      .post(`/api/staged-intents/${bodyIntent.body.id}/apply`)
      .send({});
    expect(bodyApplied.status).toBe(200);
    expect(updateBody).toHaveBeenCalledWith(
      'notion:abc',
      { summary: 'hi' },
      expect.objectContaining({ source: 'human' }),
    );

    const propsIntent = await agent.post('/api/staged-intents').send({
      kind: 'task.setProperties',
      projectId: 'proj-new-kinds',
      payload: { taskId: 'notion:abc', patch: { priority: '🔴 High' } },
    });
    const propsApplied = await agent
      .post(`/api/staged-intents/${propsIntent.body.id}/apply`)
      .send({});
    expect(propsApplied.status).toBe(200);
    expect(setProperties).toHaveBeenCalledWith(
      'notion:abc',
      { priority: '🔴 High' },
      expect.objectContaining({ source: 'human' }),
    );

    const archiveIntent = await agent.post('/api/staged-intents').send({
      kind: 'task.archive',
      projectId: 'proj-new-kinds',
      payload: { taskId: 'notion:abc' },
    });
    const archiveApplied = await agent
      .post(`/api/staged-intents/${archiveIntent.body.id}/apply`)
      .send({});
    expect(archiveApplied.status).toBe(200);
    expect(archive).toHaveBeenCalledWith(
      'notion:abc',
      expect.objectContaining({ source: 'human' }),
    );
  });

  it('rejects applying archive / structural intents with a session credential (human-apply-only)', async () => {
    const archive = vi.fn().mockResolvedValue(undefined);
    const updateBody = vi.fn().mockResolvedValue(undefined);
    const setProperties = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      archive,
      updateBody,
      setProperties,
    });
    const app = makeApp();
    const agent = supertest(app);

    for (const [kind, payload] of [
      ['task.archive', { taskId: 'notion:abc' }],
      ['task.updateBody', { taskId: 'notion:abc', sections: {} }],
      ['task.setProperties', { taskId: 'notion:abc', patch: {} }],
      [
        'task.move',
        {
          taskId: 'notion:abc',
          content: { title: 't', sections: {}, status: 'Backlog' },
          sourceMilestone: { id: 'm1', displayOrder: 0 },
          targetMilestone: { id: 'm2', displayOrder: 1, databaseId: 'db2' },
          originalDisposition: 'archive',
        },
      ],
    ] as const) {
      const staged = await agent.post('/api/staged-intents').send({
        kind,
        projectId: 'proj-session',
        payload,
      });
      const applied = await agent
        .post(`/api/staged-intents/${staged.body.id}/apply`)
        .send({ actorType: 'session' });
      expect(applied.status).toBe(403);
    }
    expect(archive).not.toHaveBeenCalled();
    expect(updateBody).not.toHaveBeenCalled();
    expect(setProperties).not.toHaveBeenCalled();
  });
});

describe('POST /api/staged-intents/:id/apply — task.setType', () => {
  it('applies a valid Type transition', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Summary\nSome design doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId: 'proj-set-type',
      payload: { taskId: 'notion:abc', type: '📐 Design' },
    });
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(setType).toHaveBeenCalledWith(
      'notion:abc',
      '📐 Design',
      expect.objectContaining({ source: 'human' }),
    );
  });

  it('rejects an invalid Type transition (unknown type) without calling the backend', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId: 'proj-set-type-invalid',
      payload: { taskId: 'notion:abc', type: '🚫 NotAType' },
    });
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(500);
    expect(setType).not.toHaveBeenCalled();
  });

  it('rejects applying task.setType with a session credential (human-apply-only)', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId: 'proj-set-type-session',
      payload: { taskId: 'notion:abc', type: '📐 Design' },
    });

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({ actorType: 'session' });
    expect(applied.status).toBe(403);
    expect(setType).not.toHaveBeenCalled();
  });
});
