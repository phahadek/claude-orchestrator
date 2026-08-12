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
import type { SessionManager } from '../../session/SessionManager';

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
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';

function makeApp(sessionManager?: SessionManager) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
  return app;
}

function makeSessionManager() {
  return {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  } as unknown as SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
  };
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
      // 📐 Design is exempt from the Open Questions readiness tier — use
      // grooming residue instead so the readiness gate still fires, forcing
      // the triage-clean override path this test exists to cover.
      fetchTaskPage: vi.fn().mockResolvedValue('Confirm scope at grooming.\n'),
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
    // 2 readiness_override + 2 staged_intent_group_committed (one per group commit).
    expect(mockRecordEvent).toHaveBeenCalledTimes(4);
    for (const [taskId] of [['notion:t-1'], ['notion:t-2']]) {
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
    for (const groupId of ['g-1', 'g-2']) {
      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'staged_intent_group_committed',
          payload: expect.objectContaining({
            group_id: groupId,
            outcome: 'committed',
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

  it('commits a group with no task.create by standard in a single operator action via both /approve and /batch/commit', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    await stageCleanTriageGroup(agent, 'proj-no-create', 't-8', 'g-8');
    const approveRes = await agent
      .post('/api/staged-intents/group/g-8/approve')
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.committed.length).toBeGreaterThan(0);

    await stageCleanTriageGroup(agent, 'proj-no-create', 't-9', 'g-9');
    const batchRes = await agent
      .post('/api/staged-intents/batch/commit')
      .send({ groupIds: ['g-9'], milestoneLabel: 'M12' });
    expect(batchRes.status).toBe(200);
    expect(batchRes.body.committed).toEqual(['g-9']);
  });

  describe('a task.create riding in the group', () => {
    it('blocks the group when the task.create payload type is 💻 Code, naming the offending member', async () => {
      const updateStatus = vi.fn();
      mockGetTaskBackend.mockReturnValue({
        type: 'notion',
        fetchTaskPage: vi
          .fn()
          .mockResolvedValue('Confirm scope at grooming.\n'),
        updateStatus,
        setDependsOn: vi.fn().mockResolvedValue(undefined),
        createTask: vi.fn().mockResolvedValue('notion:new-code-task'),
      });
      const app = makeApp();
      const agent = supertest(app);

      const created = await agent.post('/api/staged-intents').send({
        kind: 'task.create',
        projectId: 'proj-riders',
        groupId: 'g-riders',
        payload: {
          title: 'Follow-on Code task',
          type: '💻 Code',
          databaseId: 'db-riders',
        },
      });
      await stageCleanTriageGroup(agent, 'proj-riders', 't-riders', 'g-riders');

      const res = await agent.post('/api/staged-intents/batch/commit').send({
        groupIds: ['g-riders'],
        milestoneLabel: 'M12',
      });

      expect(res.status).toBe(200);
      expect(res.body.committed).toEqual([]);
      expect(res.body.exceptions).toHaveLength(1);
      expect(res.body.exceptions[0].groupId).toBe('g-riders');
      expect(res.body.exceptions[0].error).toContain(created.body.id);
      expect(res.body.exceptions[0].error).toContain('💻 Code');
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('blocks the group when the task.create payload type is a triage-eligible type (🔧 Operational) too — approve-by-standard never exempts task.create of any type', async () => {
      const updateStatus = vi.fn();
      mockGetTaskBackend.mockReturnValue({
        type: 'notion',
        fetchTaskPage: vi
          .fn()
          .mockResolvedValue('Confirm scope at grooming.\n'),
        updateStatus,
        setDependsOn: vi.fn().mockResolvedValue(undefined),
        createTask: vi.fn().mockResolvedValue('notion:new-ops-task'),
      });
      const app = makeApp();
      const agent = supertest(app);

      const created = await agent.post('/api/staged-intents').send({
        kind: 'task.create',
        projectId: 'proj-riders-2',
        groupId: 'g-riders-2',
        payload: {
          title: 'Follow-on Operational task',
          type: '🔧 Operational',
          databaseId: 'db-riders',
        },
      });
      await stageCleanTriageGroup(
        agent,
        'proj-riders-2',
        't-riders-2',
        'g-riders-2',
      );

      const res = await agent.post('/api/staged-intents/batch/commit').send({
        groupIds: ['g-riders-2'],
        milestoneLabel: 'M12',
      });

      expect(res.status).toBe(200);
      expect(res.body.committed).toEqual([]);
      expect(res.body.exceptions).toHaveLength(1);
      expect(res.body.exceptions[0].groupId).toBe('g-riders-2');
      expect(res.body.exceptions[0].error).toContain(created.body.id);
      expect(updateStatus).not.toHaveBeenCalled();
    });

    it('succeeds through the single-group /group/:groupId/approve route (autoApprove:true, no triageMilestoneLabel) for the identical 💻 Code task.create group that /batch/commit refuses', async () => {
      const updateStatus = vi.fn();
      mockGetTaskBackend.mockReturnValue({
        type: 'notion',
        fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
        updateStatus,
        setDependsOn: vi.fn().mockResolvedValue(undefined),
        createTask: vi.fn().mockResolvedValue('notion:new-code-task-approve'),
      });
      const app = makeApp();
      const agent = supertest(app);

      const created = await agent.post('/api/staged-intents').send({
        kind: 'task.create',
        projectId: 'proj-riders-approve',
        groupId: 'g-riders-approve',
        payload: {
          title: 'Follow-on Code task',
          type: '💻 Code',
          databaseId: 'db-riders',
        },
      });
      await stageCleanTriageGroup(
        agent,
        'proj-riders-approve',
        't-riders-approve',
        'g-riders-approve',
      );

      const res = await agent
        .post('/api/staged-intents/group/g-riders-approve/approve')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.committed).toEqual(
        expect.arrayContaining([created.body.id]),
      );
    });

    it('is still commitable through the explicit per-task human disposition path (/group/:groupId/commit, each member individually approved)', async () => {
      const updateStatus = vi.fn();
      mockGetTaskBackend.mockReturnValue({
        type: 'notion',
        fetchTaskPage: vi
          .fn()
          .mockResolvedValue('## Open Questions\n- Still open?\n'),
        updateStatus,
        setDependsOn: vi.fn().mockResolvedValue(undefined),
        createTask: vi.fn().mockResolvedValue('notion:new-code-task-2'),
      });
      const app = makeApp();
      const agent = supertest(app);

      const created = await agent.post('/api/staged-intents').send({
        kind: 'task.create',
        projectId: 'proj-riders-3',
        groupId: 'g-riders-3',
        payload: {
          title: 'Follow-on Code task',
          type: '💻 Code',
          databaseId: 'db-riders',
        },
      });
      const { dependsOn, setStatus } = await (async () => {
        const dependsOnRes = await agent.post('/api/staged-intents').send({
          kind: 'task.setDependsOn',
          projectId: 'proj-riders-3',
          groupId: 'g-riders-3',
          payload: { taskId: 't-riders-3', dependsOn: [] },
        });
        const setStatusRes = await agent.post('/api/staged-intents').send({
          kind: 'task.setStatus',
          projectId: 'proj-riders-3',
          groupId: 'g-riders-3',
          payload: {
            taskId: 't-riders-3',
            status: 'Ready',
            groomingGate: {
              type: '📐 Design',
              size_check: { decision: 'n/a' },
              type_check: { decision: 'none' },
              triage: {
                proposedVerdict: 'clean',
                hasOpenQuestionsHeading: true,
              },
            },
          },
        });
        return { dependsOn: dependsOnRes.body, setStatus: setStatusRes.body };
      })();

      await agent
        .post(`/api/staged-intents/${created.body.id}/approve`)
        .send({});
      await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});
      await agent.post(`/api/staged-intents/${setStatus.id}/approve`).send({});

      const res = await agent
        .post('/api/staged-intents/group/g-riders-3/commit')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.committed).toEqual(
        expect.arrayContaining([created.body.id, dependsOn.id, setStatus.id]),
      );
    });
  });
});

/**
 * precheckGroupCommit is the one gate evaluation of the four that never
 * routed its block back to the originating session — the stage-time
 * (routeStageTimeBlock) and turn-park (verifyGroup) evaluations already
 * enqueue feedback, but a block only discovered at commit time (after the
 * group has been reviewed and approved) used to end at the operator's 409
 * with nothing sent to the session that staged it. These tests cover the
 * routing added alongside that 409 — reusing formatStageTimeBlockFeedback's
 * message shape and routeStageTimeBlock's MAX_AUTO_REVISE_ROUNDS budget
 * (keyed by groupId) so a repeatedly-retried commit cannot loop unboundedly.
 */
describe('precheckGroupCommit routes its block to the originating session', () => {
  function stageGroomingGateGroup(
    sessionId: string | null,
    taskId: string,
    groupId: string,
    groomingGateOverrides: Record<string, unknown>,
  ) {
    const dependsOn = stageIntent(
      'task.setDependsOn',
      { taskId, dependsOn: [] },
      'proj-1',
      groupId,
      sessionId,
    );
    const setStatus = stageIntent(
      'task.setStatus',
      {
        taskId,
        status: 'Ready',
        groomingGate: {
          type: '📐 Design',
          type_check: { decision: 'none' },
          ...groomingGateOverrides,
        },
      },
      'proj-1',
      groupId,
      sessionId,
    );
    return { dependsOn, setStatus };
  }

  async function approve(agent: ReturnType<typeof supertest>, id: string) {
    const res = await agent.post(`/api/staged-intents/${id}/approve`).send({});
    expect(res.status).toBe(200);
  }

  it('a group commit blocked by the grooming promotion gate enqueues feedback to the arming intent\'s originating session naming the gate reasons', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.\n'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    // No size_check recorded — checkGroomingPromotionGate blocks on it.
    const { dependsOn, setStatus } = stageGroomingGateGroup(
      'session-gate',
      't-gate',
      'g-gate',
      {},
    );
    await approve(agent, dependsOn.id);
    await approve(agent, setStatus.id);

    const res = await agent
      .post('/api/staged-intents/group/g-gate/commit')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('size_check');
    expect(res.body.precheck).toBe(true);
    expect(res.body.committed).toEqual([]);

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] =
      sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('session-gate');
    expect(source).toBe('verification-error');
    expect(message).toContain('size_check');
    // Reuses formatStageTimeBlockFeedback's remedy shape, not a second dialect.
    expect(message).toContain('supersedes');

    expect(mockGetTaskBackend().updateStatus).not.toHaveBeenCalled();
    expect(mockGetTaskBackend().setDependsOn).not.toHaveBeenCalled();
  });

  it('a group commit blocked by the readiness gate routes its violations the same way', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      // Grooming-instruction residue trips the (type-agnostic) readiness
      // gate even though this task type is exempt from the Open Questions
      // tier — see the comment on the first test in this file.
      fetchTaskPage: vi.fn().mockResolvedValue('Confirm scope at grooming.\n'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    // A well-formed grooming gate (including triage) so
    // checkGroupArmingIntentCompleteness passes and the readiness check
    // itself runs — no triageMilestoneLabel is ever passed to this route, so
    // the triage-clean readiness override never applies here.
    const { dependsOn, setStatus } = stageGroomingGateGroup(
      'session-ready',
      't-ready',
      'g-ready',
      {
        size_check: { decision: 'n/a' },
        triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
      },
    );
    await approve(agent, dependsOn.id);
    await approve(agent, setStatus.id);

    const res = await agent
      .post('/api/staged-intents/group/g-ready/commit')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining('residue') }),
      ]),
    );
    expect(res.body.committed).toEqual([]);

    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] =
      sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('session-ready');
    expect(source).toBe('verification-error');
    expect(message).toContain('residue');

    expect(mockGetTaskBackend().updateStatus).not.toHaveBeenCalled();
    expect(mockGetTaskBackend().setDependsOn).not.toHaveBeenCalled();
  });

  it('repeated blocked commits stop routing once MAX_AUTO_REVISE_ROUNDS is reached for that group', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.\n'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const { dependsOn, setStatus } = stageGroomingGateGroup(
      'session-loop',
      't-loop',
      'g-loop',
      {},
    );
    await approve(agent, dependsOn.id);
    await approve(agent, setStatus.id);

    const first = await agent
      .post('/api/staged-intents/group/g-loop/commit')
      .send({});
    expect(first.status).toBe(409);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);

    // The group is still blocked (nothing was fixed) — an operator clicking
    // commit again must not turn into another feedback enqueue once the
    // budget for this group is exhausted (MAX_AUTO_REVISE_ROUNDS = 2): this
    // 2nd consecutive failure escalates instead of routing again, mirroring
    // routeStageTimeBlock's own escalation semantics.
    const second = await agent
      .post('/api/staged-intents/group/g-loop/commit')
      .send({});
    expect(second.status).toBe(409);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
  });

  it('a blocked group whose member has no session_id returns the same 409 and enqueues nothing', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.\n'),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const sessionManager = makeSessionManager();
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const { dependsOn, setStatus } = stageGroomingGateGroup(
      null,
      't-nosession',
      'g-nosession',
      {},
    );
    await approve(agent, dependsOn.id);
    await approve(agent, setStatus.id);

    const res = await agent
      .post('/api/staged-intents/group/g-nosession/commit')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('size_check');
    expect(res.body.precheck).toBe(true);
    expect(res.body.committed).toEqual([]);
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();
  });
});
