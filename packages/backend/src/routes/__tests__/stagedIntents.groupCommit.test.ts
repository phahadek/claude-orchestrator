/**
 * Two-phase apply: approve(intentId) marks an intent approved without
 * writing anything, and POST /staged-intents/group/:groupId/commit commits
 * every live intent in a group atomically, all-or-nothing, in dependency
 * order (setStatus -> Ready last). Also covers the eager readiness gate
 * evaluating the composed proposed body at approve time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockRecordEvent } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function sections(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'A summary.',
    dependencies: [],
    context: [{ type: 'paragraph', text: 'Some context.' }],
    automatedCriteria: ['tests pass'],
    manualCriteria: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

async function stageGroup(
  agent: ReturnType<typeof supertest>,
  projectId: string,
  taskId: string,
  groupId: string,
  updateBodySections?: Record<string, unknown>,
) {
  const dependsOn = await agent.post('/api/staged-intents').send({
    kind: 'task.setDependsOn',
    projectId,
    groupId,
    payload: { taskId, dependsOn: [] },
  });
  let updateBody;
  if (updateBodySections) {
    updateBody = await agent.post('/api/staged-intents').send({
      kind: 'task.updateBody',
      projectId,
      groupId,
      payload: { taskId, sections: updateBodySections },
    });
  }
  const setStatus = await agent.post('/api/staged-intents').send({
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
  return {
    dependsOn: dependsOn.body,
    updateBody: updateBody?.body,
    setStatus: setStatus.body,
  };
}

describe('POST /api/staged-intents/:id/approve', () => {
  it('marks an intent approved without writing to the backend', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus,
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { setStatus } = await stageGroup(agent, 'proj-a', 't-1', 'g-a');
    const approved = await agent
      .post(`/api/staged-intents/${setStatus.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(approved.body.state).toBe('approved');
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('eagerly evaluates the composed proposed body — a sibling updateBody in the group is reflected, not the stale stored body', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Summary\nClean stored body.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { setStatus } = await stageGroup(agent, 'proj-b', 't-2', 'g-b', {
      ...sections(),
      context: [
        { type: 'heading_3', text: 'Open Questions' },
        { type: 'bulleted_list_item', text: 'Still unresolved?' },
      ],
    });

    const approved = await agent
      .post(`/api/staged-intents/${setStatus.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(approved.body.annotation).toEqual({
      blocked: true,
      violations: expect.arrayContaining([
        expect.objectContaining({ tier: 'structural' }),
      ]),
    });
  });

  it('does not annotate when the composed proposed body is clean even though nothing was fetched from the stale body', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- unresolved in storage\n'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { setStatus } = await stageGroup(agent, 'proj-c', 't-3', 'g-c', {
      ...sections(),
      context: [{ type: 'paragraph', text: 'No open questions here.' }],
    });

    const approved = await agent
      .post(`/api/staged-intents/${setStatus.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(approved.body.annotation).toBeNull();
  });
});

describe('POST /api/staged-intents/group/:groupId/commit', () => {
  it('refuses to commit while any live intent in the group is still staged', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-d',
      't-4',
      'g-d',
    );
    // Only approve one of the two live intents.
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-d/commit')
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.pendingIds).toEqual([setStatus.id]);
  });

  it('commits all-or-nothing once every live intent is approved, applying in dependency order with setStatus->Ready last', async () => {
    const calls: string[] = [];
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn().mockImplementation(async () => {
        calls.push('setStatus');
      }),
      setDependsOn: vi.fn().mockImplementation(async () => {
        calls.push('setDependsOn');
      }),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-e',
      't-5',
      'g-e',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-e/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed).toEqual([dependsOn.id, setStatus.id]);
    expect(calls).toEqual(['setDependsOn', 'setStatus']);

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-e' });
    expect(list.body.intents).toHaveLength(0);
  });

  it('halts before the Ready flip on a mid-commit failure, leaving the task un-Ready and the remaining intents retryable', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus,
      setDependsOn: vi
        .fn()
        .mockRejectedValue(new Error('backend write failed')),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-f',
      't-6',
      'g-f',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-f/commit')
      .send({});

    expect(commit.status).toBe(500);
    expect(commit.body.committed).toEqual([]);
    expect(commit.body.failedId).toBe(dependsOn.id);
    expect(commit.body.remaining).toEqual([setStatus.id]);
    expect(updateStatus).not.toHaveBeenCalled();

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-f' });
    const states = Object.fromEntries(
      list.body.intents.map((i: { id: string; state: string }) => [
        i.id,
        i.state,
      ]),
    );
    expect(states[dependsOn.id]).toBe('approved');
    expect(states[setStatus.id]).toBe('approved');
  });

  it('threads override + reason through the commit and records a readiness_override audit event', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still unresolved?\n'),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-g',
      't-7',
      'g-g',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-g/commit')
      .send({ override: true, reason: 'reviewed manually, safe to proceed' });

    expect(commit.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      't-7',
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'readiness_override',
        payload: expect.objectContaining({
          reason: 'reviewed manually, safe to proceed',
          tiers: ['structural'],
        }),
      }),
    );
  });

  it('requires a reason when override is true', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(''),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-h',
      't-8',
      'g-h',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-h/commit')
      .send({ override: true });

    expect(commit.status).toBe(400);
  });
});
