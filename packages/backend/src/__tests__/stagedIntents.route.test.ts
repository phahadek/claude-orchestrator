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
