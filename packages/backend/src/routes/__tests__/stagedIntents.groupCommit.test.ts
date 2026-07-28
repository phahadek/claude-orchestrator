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
import { getTaskCache, setStagedIntentAdvisory } from '../../db/queries';
import { createStagedIntentsRouter } from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

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
  vi.mocked(getTaskCache).mockReturnValue(null);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

async function stageGroup(
  agent: ReturnType<typeof supertest>,
  projectId: string,
  taskId: string,
  groupId: string,
  updateBodySections?: Record<string, unknown>,
  groomingGateOverrides?: Record<string, unknown>,
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
        ...groomingGateOverrides,
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

  it('does not annotate a 📐 Design task with an open-questions/deferral body as blocked — the interactive type is exempt from those structural checks', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Summary\nClean stored body.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 't-4',
      fetched_at: 0,
      raw_json: JSON.stringify({ type: '📐 Design' }),
    });
    const app = makeApp();
    const agent = supertest(app);

    const { setStatus } = await stageGroup(agent, 'proj-d', 't-4', 'g-d', {
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
    expect(approved.body.annotation).toBeNull();
  });
});

describe('stage-time gate/seed contribution check — grouped Ready-flips', () => {
  function codeGroomingGate(overrides: Record<string, unknown> = {}) {
    return {
      size_check: { decision: 'n/a' },
      type_check: { decision: 'none' },
      type: '💻 Code',
      filesPathsEntries: [
        {
          raw: 'packages/backend/src/foo.ts',
          isNew: true,
          existsInRepo: false,
        },
      ],
      ...overrides,
    };
  }

  it('does not attach a missing-contribution blocked annotation when task.setStatus -> Ready is staged FIRST, before its gate.accrete/seed.stage siblings, in the same group', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const taskId = 't-first';
    const groupId = 'g-first';

    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-first',
      groupId,
      payload: { taskId, status: 'Ready', groomingGate: codeGroomingGate() },
    });
    expect(setStatus.status).toBe(201);
    expect(setStatus.body.annotation).toBeNull();

    const gateAccrete = await agent.post('/api/staged-intents').send({
      kind: 'gate.accrete',
      projectId: 'proj-first',
      groupId,
      payload: {
        sourceTask: {
          id: taskId,
          title: 'Some Code task',
          project: 'proj-first',
          milestone: 'M12',
        },
        items: [],
        classification: 'n/a',
      },
    });
    const seedStage = await agent.post('/api/staged-intents').send({
      kind: 'seed.stage',
      projectId: 'proj-first',
      groupId,
      payload: {
        sourceTask: {
          id: taskId,
          title: 'Some Code task',
          project: 'proj-first',
          milestone: 'M12',
        },
        seeds: [],
        decision: 'n/a',
      },
    });
    expect(gateAccrete.status).toBe(201);
    expect(seedStage.status).toBe(201);
  });

  it('still attaches a missing-contribution blocked annotation to an ungrouped Ready-flip with no applied gate/seed markers', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-ungrouped',
      payload: {
        taskId: 't-ungrouped',
        status: 'Ready',
        groomingGate: codeGroomingGate(),
      },
    });

    expect(setStatus.status).toBe(201);
    expect(setStatus.body.annotation).toEqual({
      blocked: true,
      reasons: expect.arrayContaining([
        expect.stringContaining('gate_contribution'),
        expect.stringContaining('seed_contribution'),
      ]),
    });
  });

  it('is order-insensitive — staging setStatus before or after its group accretions yields the same clean stage-time result', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const appBefore = makeApp();
    const agentBefore = supertest(appBefore);
    const taskBefore = 't-order-before';
    const groupBefore = 'g-order-before';

    const setStatusBefore = await agentBefore.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-order',
      groupId: groupBefore,
      payload: {
        taskId: taskBefore,
        status: 'Ready',
        groomingGate: codeGroomingGate(),
      },
    });
    await agentBefore.post('/api/staged-intents').send({
      kind: 'gate.accrete',
      projectId: 'proj-order',
      groupId: groupBefore,
      payload: {
        sourceTask: {
          id: taskBefore,
          title: 'Task',
          project: 'proj-order',
          milestone: 'M12',
        },
        items: [],
        classification: 'n/a',
      },
    });
    await agentBefore.post('/api/staged-intents').send({
      kind: 'seed.stage',
      projectId: 'proj-order',
      groupId: groupBefore,
      payload: {
        sourceTask: {
          id: taskBefore,
          title: 'Task',
          project: 'proj-order',
          milestone: 'M12',
        },
        seeds: [],
        decision: 'n/a',
      },
    });

    const appAfter = makeApp();
    const agentAfter = supertest(appAfter);
    const taskAfter = 't-order-after';
    const groupAfter = 'g-order-after';

    await agentAfter.post('/api/staged-intents').send({
      kind: 'gate.accrete',
      projectId: 'proj-order',
      groupId: groupAfter,
      payload: {
        sourceTask: {
          id: taskAfter,
          title: 'Task',
          project: 'proj-order',
          milestone: 'M12',
        },
        items: [],
        classification: 'n/a',
      },
    });
    await agentAfter.post('/api/staged-intents').send({
      kind: 'seed.stage',
      projectId: 'proj-order',
      groupId: groupAfter,
      payload: {
        sourceTask: {
          id: taskAfter,
          title: 'Task',
          project: 'proj-order',
          milestone: 'M12',
        },
        seeds: [],
        decision: 'n/a',
      },
    });
    const setStatusAfter = await agentAfter.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-order',
      groupId: groupAfter,
      payload: {
        taskId: taskAfter,
        status: 'Ready',
        groomingGate: codeGroomingGate(),
      },
    });

    expect(setStatusBefore.body.annotation).toBeNull();
    expect(setStatusAfter.body.annotation).toBeNull();
  });

  it('still blocks a grouped Ready-flip on the readiness (Open Questions) portion of the stage-time check — only the contribution-marker portion is deferred', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still unresolved?\n'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-readiness',
      groupId: 'g-readiness',
      payload: {
        taskId: 't-readiness',
        status: 'Ready',
        groomingGate: codeGroomingGate(),
      },
    });

    expect(setStatus.status).toBe(201);
    expect(setStatus.body.annotation).toEqual({
      blocked: true,
      violations: expect.arrayContaining([
        expect.objectContaining({ tier: 'structural' }),
      ]),
    });
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

  it('commits a group containing a task.patchBodySection member atomically alongside setDependsOn/setStatus', async () => {
    const calls: string[] = [];
    const patchBodySection = vi.fn().mockImplementation(async () => {
      calls.push('patchBodySection');
    });
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn().mockImplementation(async () => {
        calls.push('setStatus');
      }),
      setDependsOn: vi.fn().mockImplementation(async () => {
        calls.push('setDependsOn');
      }),
      patchBodySection,
    });
    const app = makeApp();
    const agent = supertest(app);
    const taskId = 't-strip';
    const groupId = 'g-strip';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-strip',
      groupId,
      payload: { taskId, dependsOn: [] },
    });
    const patch = await agent.post('/api/staged-intents').send({
      kind: 'task.patchBodySection',
      projectId: 'proj-strip',
      groupId,
      payload: {
        taskId,
        section: '👁️ Manual verification',
        operation: 'remove',
      },
    });
    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-strip',
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

    await agent
      .post(`/api/staged-intents/${dependsOn.body.id}/approve`)
      .send({});
    await agent.post(`/api/staged-intents/${patch.body.id}/approve`).send({});
    await agent
      .post(`/api/staged-intents/${setStatus.body.id}/approve`)
      .send({});

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed.sort()).toEqual(
      [dependsOn.body.id, patch.body.id, setStatus.body.id].sort(),
    );
    expect(patchBodySection).toHaveBeenCalledWith(
      taskId,
      '👁️ Manual verification',
      expect.objectContaining({ operation: 'remove' }),
      expect.objectContaining({ source: 'human' }),
    );
    // setStatus->Ready commits last, after every sibling in the group.
    expect(calls[calls.length - 1]).toBe('setStatus');

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-strip' });
    expect(list.body.intents).toHaveLength(0);
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

describe('group commit — whole-group precheck (all-or-nothing)', () => {
  it('a group whose arming Ready intent fails its grooming gate commits none of its member intents', async () => {
    const setDependsOn = vi.fn();
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus,
      setDependsOn,
    });
    const app = makeApp();
    const agent = supertest(app);

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-i',
      groupId: 'g-i',
      payload: { taskId: 't-9', dependsOn: [] },
    });
    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-i',
      groupId: 'g-i',
      payload: {
        taskId: 't-9',
        status: 'Ready',
        // size_check deliberately omitted — fails checkGroomingPromotionGate.
        groomingGate: { type_check: { decision: 'none' } },
      },
    });

    await agent
      .post(`/api/staged-intents/${dependsOn.body.id}/approve`)
      .send({});
    await agent
      .post(`/api/staged-intents/${setStatus.body.id}/approve`)
      .send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-i/commit')
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('size_check')]),
    );
    // The confirmed bug: a sibling non-arming intent must never commit ahead
    // of the arming Ready intent's gate check — neither backend write fires.
    expect(setDependsOn).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-i' });
    const states = Object.fromEntries(
      list.body.intents.map((i: { id: string; state: string }) => [
        i.id,
        i.state,
      ]),
    );
    expect(states[dependsOn.body.id]).toBe('approved');
    expect(states[setStatus.body.id]).toBe('approved');
  });

  it('commits a 📐 Design task.setStatus->Ready group without an override even though the body has a non-empty Open Questions section — the same body for a 💻 Code task still blocks', async () => {
    const openQuestionsBody = () => ({
      ...sections(),
      context: [
        { type: 'heading_3', text: 'Open Questions' },
        { type: 'bulleted_list_item', text: 'Still unresolved?' },
      ],
    });

    // 📐 Design: precheck passes, commits with no readiness_override.
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
    });
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 't-design',
      fetched_at: 0,
      raw_json: JSON.stringify({ type: '📐 Design' }),
    });
    const designApp = makeApp();
    const designAgent = supertest(designApp);
    const design = await stageGroup(
      designAgent,
      'proj-design',
      't-design',
      'g-design',
      openQuestionsBody(),
      { triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true } },
    );
    await designAgent
      .post(`/api/staged-intents/${design.dependsOn.id}/approve`)
      .send({});
    await designAgent
      .post(`/api/staged-intents/${design.updateBody.id}/approve`)
      .send({});
    await designAgent
      .post(`/api/staged-intents/${design.setStatus.id}/approve`)
      .send({});
    const designCommit = await designAgent
      .post('/api/staged-intents/group/g-design/commit')
      .send({});
    expect(designCommit.status).toBe(200);

    // 💻 Code: same body, still blocked by the readiness gate.
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
    });
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 't-code',
      fetched_at: 0,
      raw_json: JSON.stringify({ type: '💻 Code' }),
    });
    recordAccretionMarker({
      sourceTaskId: 't-code',
      project: 'proj-code',
      milestone: 'M12',
      decision: 'n/a',
      reason: 'This task type is exempt from gate accretion.',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedAccretionMarker({
      sourceTaskId: 't-code',
      project: 'proj-code',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });
    const codeApp = makeApp();
    const codeAgent = supertest(codeApp);
    const code = await stageGroup(
      codeAgent,
      'proj-code',
      't-code',
      'g-code',
      openQuestionsBody(),
      {
        type: '💻 Code',
        filesPathsEntries: [
          {
            raw: 'packages/backend/src/foo.ts',
            isNew: true,
            existsInRepo: false,
          },
        ],
      },
    );
    await codeAgent
      .post(`/api/staged-intents/${code.dependsOn.id}/approve`)
      .send({});
    await codeAgent
      .post(`/api/staged-intents/${code.updateBody.id}/approve`)
      .send({});
    await codeAgent
      .post(`/api/staged-intents/${code.setStatus.id}/approve`)
      .send({});
    const codeCommit = await codeAgent
      .post('/api/staged-intents/group/g-code/commit')
      .send({});
    expect(codeCommit.status).toBe(409);
    expect(codeCommit.body.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ tier: 'structural' })]),
    );
  });
});

describe('Manual-verification-strip grouping — commit-time hard enforcement', () => {
  it('blocks a grouped Ready-flip whose group has no Manual-verification-strip patch when the pre-groom body carried that section', async () => {
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
      'proj-mv-missing',
      't-mv-missing',
      'g-mv-missing',
      undefined,
      { hasManualVerificationSection: true },
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-mv-missing/commit')
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.error).toContain('Manual verification');
  });

  it('commits cleanly when the group carries a task.patchBodySection remove targeting the Manual verification heading', async () => {
    const patchBodySection = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      patchBodySection,
    });
    const app = makeApp();
    const agent = supertest(app);
    const projectId = 'proj-mv-strip';
    const taskId = 't-mv-strip';
    const groupId = 'g-mv-strip';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId,
      groupId,
      payload: { taskId, dependsOn: [] },
    });
    const patch = await agent.post('/api/staged-intents').send({
      kind: 'task.patchBodySection',
      projectId,
      groupId,
      payload: {
        taskId,
        section: '👁️ Manual verification',
        operation: 'remove',
      },
    });
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
          hasManualVerificationSection: true,
        },
      },
    });

    await agent
      .post(`/api/staged-intents/${dependsOn.body.id}/approve`)
      .send({});
    await agent.post(`/api/staged-intents/${patch.body.id}/approve`).send({});
    await agent
      .post(`/api/staged-intents/${setStatus.body.id}/approve`)
      .send({});

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
  });

  it('never blocks a grouped Ready-flip missing the strip when the pre-groom body carried no Manual verification section', async () => {
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
      'proj-mv-none',
      't-mv-none',
      'g-mv-none',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-mv-none/commit')
      .send({});

    expect(commit.status).toBe(200);
  });
});

describe('group-level atomic disposition (approve / pushback / decline the whole groom)', () => {
  it('POST /group/:groupId/approve commits all members in dependency order without a prior per-item approve', async () => {
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
      'proj-j',
      't-10',
      'g-j',
    );

    const approve = await agent
      .post('/api/staged-intents/group/g-j/approve')
      .send({});

    expect(approve.status).toBe(200);
    expect(approve.body.committed).toEqual([dependsOn.id, setStatus.id]);
    expect(calls).toEqual(['setDependsOn', 'setStatus']);

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-j' });
    expect(list.body.intents).toHaveLength(0);
  });

  it('POST /group/:groupId/reject with outcome=pushback rejects every live member and commits none', async () => {
    const setDependsOn = vi.fn();
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus,
      setDependsOn,
    });
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-k',
      't-11',
      'g-k',
    );

    const reject = await agent
      .post('/api/staged-intents/group/g-k/reject')
      .send({ outcome: 'pushback', reason: 'revise the dep classification' });

    expect(reject.status).toBe(200);
    expect(reject.body.rejected.sort()).toEqual(
      [dependsOn.id, setStatus.id].sort(),
    );
    expect(setDependsOn).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-k' });
    expect(list.body.intents).toHaveLength(0);
  });

  it('POST /group/:groupId/reject with outcome=decline requires a non-blank reason', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    await stageGroup(agent, 'proj-l', 't-12', 'g-l');

    const reject = await agent
      .post('/api/staged-intents/group/g-l/reject')
      .send({ outcome: 'decline', reason: '' });

    expect(reject.status).toBe(400);
  });

  it('POST /group/:groupId/approve is all-or-nothing when the arming Ready intent fails its gate', async () => {
    const setDependsOn = vi.fn();
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus,
      setDependsOn,
    });
    const app = makeApp();
    const agent = supertest(app);

    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-m',
      groupId: 'g-m',
      payload: { taskId: 't-13', dependsOn: [] },
    });
    await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-m',
      groupId: 'g-m',
      payload: {
        taskId: 't-13',
        status: 'Ready',
        groomingGate: { type_check: { decision: 'none' } },
      },
    });

    const approve = await agent
      .post('/api/staged-intents/group/g-m/approve')
      .send({});

    expect(approve.status).toBe(409);
    expect(setDependsOn).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe('Tier-3 advisory vs. annotation — commit-time channel independence', () => {
  it('never blocks the commit on a populated advisory, while an annotation still does', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    vi.mocked(getTaskCache).mockReturnValue(null);
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-advisory',
      't-advisory',
      'g-advisory',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    // Simulate a flagged Tier-3 advisory landing on the arming intent —
    // exactly what classifyReadyProposal writes via setStagedIntentAdvisory.
    setStagedIntentAdvisory(
      setStatus.id,
      JSON.stringify({
        tier: 'semantic',
        status: 'flagged',
        confidence: 0.9,
        findings: [{ detail: 'looks deferred' }],
        model: 'test-model',
        checkedAt: 0,
      }),
    );

    const commit = await agent
      .post('/api/staged-intents/group/g-advisory/commit')
      .send({});

    expect(commit.status).toBe(200);
  });

  it('still blocks the commit on a populated annotation', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('This detail will be decided by the implementer.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    vi.mocked(getTaskCache).mockReturnValue(null);
    const app = makeApp();
    const agent = supertest(app);

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-annotation',
      't-annotation',
      'g-annotation',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-annotation/commit')
      .send({});

    expect(commit.status).toBe(409);
  });
});

describe('task.setDependsOn symbolic reference to a sibling task.create — commit-loop resolution', () => {
  it('resolves the symbolic reference to the real created task id at commit, and does not block the arming Ready flip', async () => {
    const setDependsOn = vi.fn().mockResolvedValue(undefined);
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const createTask = vi.fn().mockResolvedValue('notion:new-prereq-id');
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus,
      setDependsOn,
      createTask,
    });
    const app = makeApp();
    const agent = supertest(app);
    const projectId = 'proj-symref';
    const groupId = 'g-symref';
    const taskId = 't-symref';

    const create = await agent.post('/api/staged-intents').send({
      kind: 'task.create',
      projectId,
      groupId,
      payload: {
        databaseId: 'db-1',
        title: 'Missing prerequisite endpoint',
        type: '💻 Code',
      },
    });
    expect(create.status).toBe(201);

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId,
      groupId,
      payload: {
        taskId,
        dependsOn: [`staged-intent:${create.body.id}`],
      },
    });
    expect(dependsOn.status).toBe(201);

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
    expect(setStatus.status).toBe(201);

    for (const id of [create.body.id, dependsOn.body.id, setStatus.body.id]) {
      const approved = await agent
        .post(`/api/staged-intents/${id}/approve`)
        .send({});
      expect(approved.status).toBe(200);
    }

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed).toEqual([
      create.body.id,
      dependsOn.body.id,
      setStatus.body.id,
    ]);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(setDependsOn).toHaveBeenCalledWith(
      taskId,
      ['notion:new-prereq-id'],
      expect.objectContaining({ source: 'human' }),
    );
    expect(updateStatus).toHaveBeenCalledWith(
      taskId,
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
  });

  it('surfaces a mid-commit failure without silently dropping the already-applied task.create from the reported outcome', async () => {
    const createTask = vi.fn().mockResolvedValue('notion:new-prereq-id-2');
    const setDependsOn = vi
      .fn()
      .mockRejectedValue(new Error('backend write failed'));
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn,
      createTask,
    });
    const app = makeApp();
    const agent = supertest(app);
    const projectId = 'proj-symref-fail';
    const groupId = 'g-symref-fail';
    const taskId = 't-symref-fail';

    const create = await agent.post('/api/staged-intents').send({
      kind: 'task.create',
      projectId,
      groupId,
      payload: {
        databaseId: 'db-1',
        title: 'Missing prerequisite endpoint',
        type: '💻 Code',
      },
    });
    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId,
      groupId,
      payload: {
        taskId,
        dependsOn: [`staged-intent:${create.body.id}`],
      },
    });
    for (const id of [create.body.id, dependsOn.body.id]) {
      await agent.post(`/api/staged-intents/${id}/approve`).send({});
    }

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(500);
    expect(createTask).toHaveBeenCalledTimes(1);
    // The task.create is not silently dropped from the reported outcome even
    // though the group commit as a whole failed: it is listed as committed,
    // and the failing intent is named explicitly.
    expect(commit.body.committed).toEqual([create.body.id]);
    expect(commit.body.failedId).toBe(dependsOn.body.id);

    // The create is no longer live (it committed for real, so it drops out
    // of the active-intents listing); the failed dependsOn intent stays
    // live/approved, retryable in a follow-up commit.
    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId });
    const liveIds = list.body.intents.map((i: { id: string }) => i.id);
    expect(liveIds).not.toContain(create.body.id);
    expect(liveIds).toContain(dependsOn.body.id);
    const dependsOnRow = list.body.intents.find(
      (i: { id: string }) => i.id === dependsOn.body.id,
    );
    expect(dependsOnRow.state).toBe('approved');
  });
});
