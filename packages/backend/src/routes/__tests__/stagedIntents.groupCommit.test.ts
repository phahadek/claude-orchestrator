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

// Only the strip⇔accrete content-match tests below drive a real
// accreteGateContribution apply (resolveMilestoneForProject) — every other
// project id in this file never reaches that code path.
vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) => {
      if (!id.startsWith('proj-cm')) return undefined;
      return {
        id,
        milestones: [{ id: 'M1', name: 'M1', canonicalShortId: 'M1' }],
      };
    },
  },
}));

import { db } from '../../db/db';
import {
  getTaskCache,
  setStagedIntentAdvisory,
  insertStagedIntent,
  getStagedIntent,
  insertSession,
} from '../../db/queries';
import {
  createStagedIntentsRouter,
  stageIntent,
  TaskCreateMissingGroupError,
} from '../stagedIntents';
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

describe('strip⇔accrete content-verification hard gate', () => {
  const MV_BODY =
    '## Summary\nClean.\n\n### 👁️ Manual verification\n- Click the button and confirm a toast appears\n- Reload the page and confirm state persists\n';

  async function stageContentMatchGroup(
    agent: ReturnType<typeof supertest>,
    projectId: string,
    taskId: string,
    groupId: string,
    gateAccreteOverrides: Record<string, unknown>,
  ) {
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
    const gateAccrete = await agent.post('/api/staged-intents').send({
      kind: 'gate.accrete',
      projectId,
      groupId,
      payload: {
        sourceTask: {
          id: taskId,
          title: 'A task',
          project: projectId,
          milestone: 'M1',
        },
        items: [],
        classification: 'items',
        ...gateAccreteOverrides,
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
    for (const intent of [dependsOn, patch, gateAccrete, setStatus]) {
      await agent
        .post(`/api/staged-intents/${intent.body.id}/approve`)
        .send({});
    }
    return { dependsOn, patch, gateAccrete, setStatus };
  }

  it('commits cleanly when N stripped items match N accreted items', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(MV_BODY),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      patchBodySection: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-content-match';
    await stageContentMatchGroup(agent, 'proj-cm', 't-cm', groupId, {
      items: [
        { text: 'Click the button and confirm a toast appears' },
        { text: 'Reload the page and confirm state persists' },
      ],
    });

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
  });

  it('hard-blocks the whole group when fewer items were accreted than stripped', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(MV_BODY),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      patchBodySection: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-content-fewer';
    const { setStatus } = await stageContentMatchGroup(
      agent,
      'proj-cm-fewer',
      't-cm-fewer',
      groupId,
      {
        items: [{ text: 'Click the button and confirm a toast appears' }],
      },
    );

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.error).toContain('content mismatch');
    expect(commit.body.reasons[0]).toContain(
      'Reload the page and confirm state persists',
    );

    const annotated = await getStagedIntent(setStatus.body.id);
    expect(
      annotated ? JSON.parse(annotated.annotation ?? 'null') : null,
    ).toEqual(expect.objectContaining({ blocked: true }));
  });

  it('hard-blocks on an item-correspondence mismatch even with equal counts', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(MV_BODY),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      patchBodySection: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-content-correspondence';
    await stageContentMatchGroup(agent, 'proj-cm-corr', 't-cm-corr', groupId, {
      items: [
        { text: 'Click the button and confirm a toast appears' },
        { text: 'Something totally unrelated' },
      ],
    });

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.error).toContain('content mismatch');
  });

  it('does not run the content-match check for the existing none/n-a accretion path', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(MV_BODY),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      patchBodySection: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-content-none';
    await stageContentMatchGroup(agent, 'proj-cm-none', 't-cm-none', groupId, {
      items: [],
      classification: 'n/a',
      reason: 'Assessed the change; nothing runtime-observable resulted.',
    });

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
  });
});

describe('seed_contribution strip⇔accrete content-match (declared candidates vs staged seeds)', () => {
  async function stageSeedContentMatchGroup(
    agent: ReturnType<typeof supertest>,
    projectId: string,
    taskId: string,
    groupId: string,
    seedStageOverrides: Record<string, unknown>,
    seedContributionCandidates?: { spec: string }[],
  ) {
    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId,
      groupId,
      payload: { taskId, dependsOn: [] },
    });
    const seedStage = await agent.post('/api/staged-intents').send({
      kind: 'seed.stage',
      projectId,
      groupId,
      payload: {
        sourceTask: {
          id: taskId,
          title: 'A task',
          project: projectId,
          milestone: 'M1',
        },
        seeds: [],
        decision: 'seeds',
        ...seedStageOverrides,
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
          ...(seedContributionCandidates ? { seedContributionCandidates } : {}),
        },
      },
    });
    for (const intent of [dependsOn, seedStage, setStatus]) {
      await agent
        .post(`/api/staged-intents/${intent.body.id}/approve`)
        .send({});
    }
    return { dependsOn, seedStage, setStatus };
  }

  it('commits cleanly when declared seed candidates match staged seeds', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-seed-match';
    await stageSeedContentMatchGroup(
      agent,
      'proj-cm-seed',
      't-cm-seed',
      groupId,
      { seeds: [{ spec: 'Set default retry count to 3' }] },
      [{ spec: 'Set default retry count to 3' }],
    );

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
  });

  it('hard-blocks when fewer seeds were staged than declared', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-seed-fewer';
    const { setStatus } = await stageSeedContentMatchGroup(
      agent,
      'proj-cm-seed-fewer',
      't-cm-seed-fewer',
      groupId,
      { seeds: [{ spec: 'Set default retry count to 3' }] },
      [
        { spec: 'Set default retry count to 3' },
        { spec: 'Enable the new feature flag' },
      ],
    );

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.error).toContain('content mismatch');
    expect(commit.body.reasons[0]).toContain('Enable the new feature flag');

    const annotated = await getStagedIntent(setStatus.body.id);
    expect(
      annotated ? JSON.parse(annotated.annotation ?? 'null') : null,
    ).toEqual(expect.objectContaining({ blocked: true }));
  });

  it('hard-blocks on an item-correspondence mismatch even with equal counts', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-seed-correspondence';
    await stageSeedContentMatchGroup(
      agent,
      'proj-cm-seed-corr',
      't-cm-seed-corr',
      groupId,
      {
        seeds: [
          { spec: 'Set default retry count to 3' },
          { spec: 'Something totally unrelated' },
        ],
      },
      [
        { spec: 'Set default retry count to 3' },
        { spec: 'Enable the new feature flag' },
      ],
    );

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.error).toContain('content mismatch');
  });

  it('does not run the content-match check when no seedContributionCandidates were declared', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-seed-undeclared';
    await stageSeedContentMatchGroup(
      agent,
      'proj-cm-seed-undeclared',
      't-cm-seed-undeclared',
      groupId,
      { seeds: [{ spec: 'Set default retry count to 3' }] },
      undefined,
    );

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(200);
  });

  it('does not run the content-match check for the existing none/n-a decision path', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-seed-none';
    await stageSeedContentMatchGroup(
      agent,
      'proj-cm-seed-none',
      't-cm-seed-none',
      groupId,
      { seeds: [], decision: 'n/a' },
      [{ spec: 'Set default retry count to 3' }],
    );

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
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
    const list = await agent.get('/api/staged-intents').query({ projectId });
    const liveIds = list.body.intents.map((i: { id: string }) => i.id);
    expect(liveIds).not.toContain(create.body.id);
    expect(liveIds).toContain(dependsOn.body.id);
    const dependsOnRow = list.body.intents.find(
      (i: { id: string }) => i.id === dependsOn.body.id,
    );
    expect(dependsOnRow.state).toBe('approved');
  });
});

/**
 * A session.requestCapability must never carry a groupId (enforced at stage
 * time — see stagedIntents.capabilityRequest.test.ts), but a group already
 * carrying one from before that guard existed must still be handled without
 * crashing, and must be recoverable. These tests insert rows directly
 * (bypassing stageIntent) to simulate that pre-existing/legacy data.
 */
function insertCapabilityRequestRow(opts: {
  id: string;
  groupId: string | null;
  state: 'staged' | 'approved' | 'needs_revision' | 'pending_verification';
}) {
  insertStagedIntent({
    id: opts.id,
    kind: 'session.requestCapability',
    payload: JSON.stringify({
      capability: 'mcp__notion__API-update-page-markdown',
      plan: 'retire the arch pages',
      evidence: 'legacy-wedge simulation',
    }),
    payload_hash: `hash-${opts.id}`,
    task_id: null,
    project_id: 'proj-wedge',
    session_id: 'sess-wedge',
    group_id: opts.groupId,
    milestone: null,
    state: opts.state,
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason:
      opts.state === 'needs_revision'
        ? '[stagedIntents] unknown intent kind "session.requestCapability"'
        : null,
    answer: null,
    created_at: 1000,
    updated_at: 1000,
  });
}

describe('a session.requestCapability caught in a group (legacy data)', () => {
  it('committing the group never throws "unknown intent kind" — it is refused before reaching applyIntent', async () => {
    const app = makeApp();
    const agent = supertest(app);
    insertCapabilityRequestRow({
      id: 'cap-1',
      groupId: 'g-legacy-live',
      state: 'approved',
    });

    const commit = await agent
      .post('/api/staged-intents/group/g-legacy-live/commit')
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.error).not.toMatch(/unknown intent kind/);
    expect(commit.body.error).toMatch(/session\.requestCapability/);
    expect(getStagedIntent('cap-1')!.state).toBe('approved');
  });

  it('approving a capability request still grants + respawns with no apply step, unchanged by the group guard', async () => {
    const sessionManager = {
      grantCapability: vi.fn().mockReturnValue([]),
      enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    };
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createStagedIntentsRouter(
        undefined,
        sessionManager as unknown as Parameters<
          typeof createStagedIntentsRouter
        >[1],
      ),
    );
    const agent = supertest(app);
    insertCapabilityRequestRow({
      id: 'cap-2',
      groupId: null,
      state: 'staged',
    });

    const res = await agent.post('/api/staged-intents/cap-2/approve');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      'sess-wedge',
      'mcp__notion__API-update-page-markdown',
    );
  });

  it('is diagnosable and recoverable once wedged in needs_revision', async () => {
    const app = makeApp();
    const agent = supertest(app);
    insertCapabilityRequestRow({
      id: 'cap-3',
      groupId: 'retire-arch-pages-proposal-2026-07-28',
      state: 'needs_revision',
    });

    const diagnosis = await agent.get(
      '/api/staged-intents/group/retire-arch-pages-proposal-2026-07-28',
    );
    expect(diagnosis.status).toBe(200);
    expect(diagnosis.body.wedged).toBe(true);
    expect(diagnosis.body.intents).toHaveLength(1);
    expect(diagnosis.body.intents[0].state).toBe('needs_revision');

    // Unreachable by commit before recovery — the blocked member holds the
    // group rather than being silently dropped from it.
    const commitBefore = await agent
      .post(
        '/api/staged-intents/group/retire-arch-pages-proposal-2026-07-28/commit',
      )
      .send({});
    expect(commitBefore.status).toBe(409);
    expect(commitBefore.body.blockingId).toBe('cap-3');

    const recover = await agent.post(
      '/api/staged-intents/group/retire-arch-pages-proposal-2026-07-28/recover',
    );
    expect(recover.status).toBe(200);
    expect(recover.body.recovered).toHaveLength(1);
    expect(recover.body.recovered[0].state).toBe('staged');
    expect(recover.body.recovered[0].groupId).toBeNull();

    const row = getStagedIntent('cap-3')!;
    expect(row.state).toBe('staged');
    expect(row.group_id).toBeNull();

    // Now actionable via the ordinary per-item disposition surface.
    const reject = await agent
      .post('/api/staged-intents/cap-3/reject')
      .send({ outcome: 'decline', reason: 'no longer needed' });
    expect(reject.status).toBe(200);
    expect(getStagedIntent('cap-3')!.state).toBe('rejected');
  });

  it('is diagnosable and recoverable once wedged in pending_verification', async () => {
    const app = makeApp();
    const agent = supertest(app);
    insertCapabilityRequestRow({
      id: 'cap-4',
      groupId: 'retire-arch-pages-proposal-2026-07-29',
      state: 'pending_verification',
    });

    const diagnosis = await agent.get(
      '/api/staged-intents/group/retire-arch-pages-proposal-2026-07-29',
    );
    expect(diagnosis.status).toBe(200);
    expect(diagnosis.body.wedged).toBe(true);
    expect(diagnosis.body.intents).toHaveLength(1);
    expect(diagnosis.body.intents[0].state).toBe('pending_verification');

    const recover = await agent.post(
      '/api/staged-intents/group/retire-arch-pages-proposal-2026-07-29/recover',
    );
    expect(recover.status).toBe(200);
    expect(recover.body.recovered).toHaveLength(1);
    expect(recover.body.recovered[0].state).toBe('staged');
    expect(recover.body.recovered[0].groupId).toBeNull();

    const row = getStagedIntent('cap-4')!;
    expect(row.state).toBe('staged');
    expect(row.group_id).toBeNull();
  });

  it('recovering a non-wedged (empty or live) group 404s', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const recover = await agent.post(
      '/api/staged-intents/group/no-such-group/recover',
    );
    expect(recover.status).toBe(404);
  });

  it('the default unknown-kind throw still fires for a genuinely unrecognised kind', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    insertStagedIntent({
      id: 'unknown-1',
      kind: 'totally.unrecognised',
      payload: JSON.stringify({}),
      payload_hash: 'hash-unknown-1',
      task_id: null,
      project_id: 'proj-wedge',
      session_id: null,
      group_id: 'g-unknown',
      milestone: null,
      state: 'approved',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: 1000,
      updated_at: 1000,
    });

    const commit = await agent
      .post('/api/staged-intents/group/g-unknown/commit')
      .send({});

    expect(commit.status).toBe(500);
    expect(commit.body.error).toMatch(/unknown intent kind/);
  });
});

/**
 * A blocked member (needs_revision/pending_verification) must hold its whole
 * group at commit time rather than being silently excluded — the confirmed
 * bug where a group committed over its remaining members and stranded the
 * blocked one behind.
 */
function insertUpdateBodyRow(opts: {
  id: string;
  groupId: string;
  taskId: string;
  state: 'staged' | 'approved' | 'needs_revision' | 'pending_verification';
}) {
  insertStagedIntent({
    id: opts.id,
    kind: 'task.updateBody',
    payload: JSON.stringify({ taskId: opts.taskId, sections: sections() }),
    payload_hash: `hash-${opts.id}`,
    task_id: opts.taskId,
    project_id: 'proj-blocked',
    session_id: 'sess-blocked',
    group_id: opts.groupId,
    state: opts.state,
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: 1000,
    updated_at: 1000,
  });
}

describe('group commit — a blocked member holds the whole group', () => {
  it('refuses to commit while a member is needs_revision, naming the blocking member — no member transitions to committed', async () => {
    const setDependsOn = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn,
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-blocked-nr';
    const taskId = 't-blocked-nr';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-blocked',
      groupId,
      payload: { taskId, dependsOn: [] },
    });
    await agent
      .post(`/api/staged-intents/${dependsOn.body.id}/approve`)
      .send({});
    insertUpdateBodyRow({
      id: 'ub-nr',
      groupId,
      taskId,
      state: 'needs_revision',
    });

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.blockingId).toBe('ub-nr');
    expect(setDependsOn).not.toHaveBeenCalled();
    expect(getStagedIntent(dependsOn.body.id)!.state).toBe('approved');
    expect(getStagedIntent('ub-nr')!.state).toBe('needs_revision');
  });

  it('applies the same refusal to a pending_verification member', async () => {
    const setDependsOn = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn,
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-blocked-pv';
    const taskId = 't-blocked-pv';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-blocked',
      groupId,
      payload: { taskId, dependsOn: [] },
    });
    await agent
      .post(`/api/staged-intents/${dependsOn.body.id}/approve`)
      .send({});
    insertUpdateBodyRow({
      id: 'ub-pv',
      groupId,
      taskId,
      state: 'pending_verification',
    });

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(409);
    expect(commit.body.blockingId).toBe('ub-pv');
    expect(setDependsOn).not.toHaveBeenCalled();
    expect(getStagedIntent(dependsOn.body.id)!.state).toBe('approved');
  });

  it('a group whose members are all active still commits atomically, unchanged', async () => {
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
      'proj-blocked-clean',
      't-blocked-clean',
      'g-blocked-clean',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-blocked-clean/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed).toEqual([dependsOn.id, setStatus.id]);
  });
});

describe('task.create staged while the session has an open decision group for its task', () => {
  function seedSession(sessionId: string, taskId: string) {
    insertSession({
      session_id: sessionId,
      task_id: taskId,
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'groom',
      note: null,
      tags: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      compaction_count: 0,
      context_occupancy_tokens: 0,
      task_name: null,
      metadata: null,
      review_result: null,
      pause_reason: null,
      last_error_detail: null,
      events_pruned_at: null,
      granted_capabilities: '[]',
    });
  }

  it('rejects an ungrouped task.create when the session already has an open group for its own task', () => {
    seedSession('groom-split-1', 't-split-original');
    stageIntent(
      'task.setDependsOn',
      { taskId: 't-split-original', dependsOn: [] },
      'proj-split',
      'g-split',
      'groom-split-1',
    );

    expect(() =>
      stageIntent(
        'task.create',
        { title: 'Sibling split off the original', type: '💻 Code' },
        'proj-split',
        null,
        'groom-split-1',
      ),
    ).toThrow(TaskCreateMissingGroupError);
  });

  it('accepts a task.create carrying the decision group and commits it atomically with the rest of the group', async () => {
    seedSession('groom-split-2', 't-split-original-2');
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      createTask: vi.fn().mockResolvedValue('notion:sibling-task-id'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const create = stageIntent(
      'task.create',
      { title: 'Sibling split off the original', type: '💻 Code' },
      'proj-split',
      'g-split-2',
      'groom-split-2',
    );
    expect(create.groupId).toBe('g-split-2');

    const { dependsOn, setStatus } = await stageGroup(
      agent,
      'proj-split',
      't-split-original-2',
      'g-split-2',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});
    await agent.post(`/api/staged-intents/${create.id}/approve`).send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-split-2/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(commit.body.committed).toEqual(
      expect.arrayContaining([dependsOn.id, setStatus.id, create.id]),
    );
  });

  it('still accepts a standalone ungrouped task.create from a session with no open decision group for its task', () => {
    seedSession('groom-standalone', 't-standalone');

    const create = stageIntent(
      'task.create',
      { title: 'Genuinely unrelated follow-on', type: '💻 Code' },
      'proj-standalone',
      null,
      'groom-standalone',
    );
    expect(create.groupId).toBeNull();
  });

  it('a grouped task.create referenced by a sibling task.setDependsOn via a symbolic reference still resolves at commit', async () => {
    seedSession('groom-split-3', 't-split-original-3');
    const setDependsOn = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn,
      createTask: vi.fn().mockResolvedValue('notion:sibling-task-id-3'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const create = stageIntent(
      'task.create',
      { title: 'Sibling split off the original', type: '💻 Code' },
      'proj-split',
      'g-split-3',
      'groom-split-3',
    );

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-split',
      groupId: 'g-split-3',
      payload: {
        taskId: 't-split-original-3',
        dependsOn: [`staged-intent:${create.id}`],
      },
    });
    expect(dependsOn.status).toBe(201);

    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-split',
      groupId: 'g-split-3',
      payload: {
        taskId: 't-split-original-3',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
        },
      },
    });

    await agent.post(`/api/staged-intents/${create.id}/approve`).send({});
    await agent
      .post(`/api/staged-intents/${dependsOn.body.id}/approve`)
      .send({});
    await agent
      .post(`/api/staged-intents/${setStatus.body.id}/approve`)
      .send({});

    const commit = await agent
      .post('/api/staged-intents/group/g-split-3/commit')
      .send({});

    expect(commit.status).toBe(200);
    expect(setDependsOn).toHaveBeenCalledWith('t-split-original-3', [
      'notion:sibling-task-id-3',
    ]);
  });
});
