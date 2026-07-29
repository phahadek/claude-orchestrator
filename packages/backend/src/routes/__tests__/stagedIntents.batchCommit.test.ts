/**
 * The approve-by-standard decision surface: POST
 * /staged-intents/batch/commit commits a default-approved clean set spanning
 * multiple task groups (one groupId per task) from a triaged interactive-type
 * batch. Each group's Ready-flip applies individually — its own per-task
 * readiness_override + audit event, its own re-derived server-side gate — and
 * a group whose apply fails surfaces as an exception without aborting the
 * rest of the batch. Live intents need no prior /approve call: approve-by-
 * standard removes that per-item human decision for interactive types.
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
    getTaskCache: vi.fn().mockReturnValue({
      raw_json: JSON.stringify({ type: '📐 Design', status: 'Backlog' }),
    }),
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

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

async function stageCleanTriageGroup(
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
  const setStatus = await agent.post('/api/staged-intents').send({
    kind: 'task.setStatus',
    projectId,
    groupId,
    payload: {
      taskId,
      status: 'Ready',
      groomingGate: {
        type: '📐 Design',
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
    },
  });
  return setStatus.body;
}

describe('POST /api/staged-intents/batch/commit', () => {
  it('rejects an empty groupIds array', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const res = await agent.post('/api/staged-intents/batch/commit').send({
      groupIds: [],
    });
    expect(res.status).toBe(400);
  });

  it('commits each clean group individually with no prior approve, recording a per-task readiness_override + audit event each', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still open?\n'),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    await stageCleanTriageGroup(agent, 'proj-a', 't-1', 'g-1');
    await stageCleanTriageGroup(agent, 'proj-a', 't-2', 'g-2');

    const res = await agent.post('/api/staged-intents/batch/commit').send({
      groupIds: ['g-1', 'g-2'],
      milestoneLabel: 'M12',
    });

    expect(res.status).toBe(200);
    expect(res.body.committed).toEqual(['g-1', 'g-2']);
    expect(res.body.exceptions).toEqual([]);

    expect(updateStatus).toHaveBeenCalledTimes(2);
    expect(mockRecordEvent).toHaveBeenCalledTimes(2);
    for (const [taskId] of [['t-1'], ['t-2']]) {
      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'readiness_override',
          task_id: taskId,
          payload: expect.objectContaining({
            reason: expect.stringContaining('triaged clean in the M12'),
          }),
        }),
      );
    }
  });

  it('surfaces a failing group as an exception without aborting the rest of the batch', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockImplementation((projectId: string) => ({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still open?\n'),
      updateStatus,
      setDependsOn:
        projectId === 'proj-fail'
          ? vi.fn().mockRejectedValue(new Error('backend write failed'))
          : vi.fn().mockResolvedValue(undefined),
    }));
    const app = makeApp();
    const agent = supertest(app);

    await stageCleanTriageGroup(agent, 'proj-ok', 't-3', 'g-3');
    await stageCleanTriageGroup(agent, 'proj-fail', 't-4', 'g-4');
    await stageCleanTriageGroup(agent, 'proj-ok', 't-5', 'g-5');

    const res = await agent.post('/api/staged-intents/batch/commit').send({
      groupIds: ['g-3', 'g-4', 'g-5'],
      milestoneLabel: 'M12',
    });

    expect(res.status).toBe(200);
    expect(res.body.committed).toEqual(['g-3', 'g-5']);
    expect(res.body.exceptions).toHaveLength(1);
    expect(res.body.exceptions[0]).toEqual(
      expect.objectContaining({ groupId: 'g-4' }),
    );
  });

  it('never touches a group that was vetoed by simply omitting it from groupIds', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still open?\n'),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    await stageCleanTriageGroup(agent, 'proj-b', 't-6', 'g-6');
    const vetoed = await stageCleanTriageGroup(agent, 'proj-b', 't-7', 'g-7');

    const res = await agent.post('/api/staged-intents/batch/commit').send({
      groupIds: ['g-6'],
      milestoneLabel: 'M12',
    });

    expect(res.status).toBe(200);
    expect(res.body.committed).toEqual(['g-6']);
    expect(updateStatus).toHaveBeenCalledTimes(1);

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-b' });
    const vetoedIntent = list.body.intents.find(
      (i: { id: string }) => i.id === vetoed.id,
    );
    expect(vetoedIntent.state).toBe('staged');
  });
});
