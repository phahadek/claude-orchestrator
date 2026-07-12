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

vi.mock('../db/queries', () => ({
  getTaskCache: vi.fn().mockReturnValue(null),
}));

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

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-blocked',
      payload: { taskId: 'notion:abc', status: 'Ready' },
    });
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
    expect(list.body.intents).toHaveLength(1);
    expect(list.body.intents[0].annotation).toEqual({
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

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-2',
      payload: { taskId: 'notion:abc', status: 'Ready' },
    });

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
    expect(list.body.intents).toHaveLength(0);
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

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-clean',
      payload: { taskId: 'notion:abc', status: 'Ready' },
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

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-groom-blocked',
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
    expect(list.body.intents[0].annotation).toEqual({
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

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-groom-clean',
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
