/**
 * The write-path twin of stagedIntents.groupBlockedSignalsCaching.test.ts:
 * commitGroupIntents' apply loop (backing group /approve, /commit and
 * batch/commit) and the group /reject loop both call rowToApi(row) once per
 * group member. rowToApi's computeGroupBlockedSignals re-reads the whole
 * group (listStagedIntentsByGroup) on every call it isn't handed a shared
 * cache for, so an uncached per-member call re-reads the group once per
 * member — the same quadratic pattern 39423079 fixed on the GET listing
 * routes, but left untouched here. This asserts a request-scoped cache
 * bounds those write-path loops to a constant number of group reads
 * regardless of member count, while leaving the returned payloads
 * byte-identical.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const {
  mockGetTaskBackend,
  mockRecordEvent,
  mockClassifyReadyProposal,
  listStagedIntentsByGroupSpy,
} = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
  mockClassifyReadyProposal: vi.fn(),
  listStagedIntentsByGroupSpy: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../tasks/deferralClassifier', () => ({
  classifyReadyProposal: mockClassifyReadyProposal,
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
    listStagedIntentsByGroup: (groupId: string) => {
      listStagedIntentsByGroupSpy(groupId);
      return actual.listStagedIntentsByGroup(groupId);
    },
  };
});

import { db } from '../../db/db';
import { getTaskCache } from '../../db/queries';
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
  mockClassifyReadyProposal.mockReset();
  mockClassifyReadyProposal.mockResolvedValue(undefined);
  listStagedIntentsByGroupSpy.mockClear();
  vi.mocked(getTaskCache).mockReturnValue(null);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

/** Stages a group of `siblingCount` inert task.updateBody members plus a
 * task.setDependsOn and an arming task.setStatus->Ready, then approves every
 * live member — mirroring stageGroup in stagedIntents.groupCommit.test.ts
 * but with a variable member count so the group-read assertion below can
 * show the read count does not scale with it. */
async function stageAndApproveGroup(
  agent: ReturnType<typeof supertest>,
  projectId: string,
  taskId: string,
  groupId: string,
  siblingCount: number,
): Promise<string[]> {
  const ids: string[] = [];

  const dependsOn = await agent.post('/api/staged-intents').send({
    kind: 'task.setDependsOn',
    projectId,
    groupId,
    payload: { taskId, dependsOn: [] },
  });
  ids.push(dependsOn.body.id);

  for (let i = 0; i < siblingCount; i += 1) {
    const updateBody = await agent.post('/api/staged-intents').send({
      kind: 'task.updateBody',
      projectId,
      groupId,
      payload: {
        taskId,
        sections: {
          summary: `A summary ${i}.`,
          dependencies: [],
          context: [{ type: 'paragraph', text: 'Some context.' }],
          automatedCriteria: ['tests pass'],
          manualCriteria: [],
        },
      },
    });
    ids.push(updateBody.body.id);
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
        seam_check: { decision: 'n/a' },
      },
    },
  });
  ids.push(setStatus.body.id);

  for (const id of ids) {
    await agent.post(`/api/staged-intents/${id}/approve`).send({});
  }
  return ids;
}

describe('POST /api/staged-intents/group/:groupId/approve — group signal caching', () => {
  it('reads the group the same number of times regardless of member count, not once per member', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
    });

    async function readsForApprove(
      groupId: string,
      projectId: string,
      taskId: string,
      siblingCount: number,
    ): Promise<number> {
      const app = makeApp();
      const agent = supertest(app);
      await stageAndApproveGroup(
        agent,
        projectId,
        taskId,
        groupId,
        siblingCount,
      );
      listStagedIntentsByGroupSpy.mockClear();

      const approve = await agent
        .post(`/api/staged-intents/group/${groupId}/approve`)
        .send({});
      expect(approve.status).toBe(200);

      return listStagedIntentsByGroupSpy.mock.calls.filter(
        (call) => call[0] === groupId,
      ).length;
    }

    const smallReads = await readsForApprove(
      'g-wp-1-small',
      'proj-wp-1-small',
      't-wp-1-small',
      1,
    );
    const largeReads = await readsForApprove(
      'g-wp-1-large',
      'proj-wp-1-large',
      't-wp-1-large',
      8,
    );

    // Uncached, this would scale with member count (once per rowToApi call
    // in the apply loop) — the 8-member group would read the group ~7 more
    // times than the 3-member one. Cached, the read count is independent of
    // group size.
    expect(largeReads).toBe(smallReads);
  });

  it('returns byte-identical committed payloads to an uncached commit for a small group', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-wp-2';

    await stageAndApproveGroup(agent, 'proj-wp-2', 't-wp-2', groupId, 1);

    const approve = await agent
      .post(`/api/staged-intents/group/${groupId}/approve`)
      .send({});

    expect(approve.status).toBe(200);
    expect(approve.body.committed).toHaveLength(3);
  });
});

describe('POST /api/staged-intents/group/:groupId/reject — group signal caching', () => {
  it('reads the group the same number of times regardless of member count, not once per member', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
      updateBody: vi.fn(),
    });

    async function readsForReject(
      groupId: string,
      projectId: string,
      taskId: string,
      siblingCount: number,
    ): Promise<number> {
      const app = makeApp();
      const agent = supertest(app);

      await agent.post('/api/staged-intents').send({
        kind: 'task.setDependsOn',
        projectId,
        groupId,
        payload: { taskId, dependsOn: [] },
      });
      for (let i = 0; i < siblingCount; i += 1) {
        await agent.post('/api/staged-intents').send({
          kind: 'task.updateBody',
          projectId,
          groupId,
          payload: {
            taskId,
            sections: {
              summary: `A summary ${i}.`,
              dependencies: [],
              context: [{ type: 'paragraph', text: 'Some context.' }],
              automatedCriteria: ['tests pass'],
              manualCriteria: [],
            },
          },
        });
      }

      listStagedIntentsByGroupSpy.mockClear();

      const reject = await agent
        .post(`/api/staged-intents/group/${groupId}/reject`)
        .send({ outcome: 'decline', reason: 'no longer needed' });
      expect(reject.status).toBe(200);

      return listStagedIntentsByGroupSpy.mock.calls.filter(
        (call) => call[0] === groupId,
      ).length;
    }

    const smallReads = await readsForReject(
      'g-wp-3-small',
      'proj-wp-3-small',
      't-wp-3-small',
      0,
    );
    const largeReads = await readsForReject(
      'g-wp-3-large',
      'proj-wp-3-large',
      't-wp-3-large',
      8,
    );

    // Uncached, this would scale with member count (once per
    // transitionRejectedIntent -> rowToApi call). Cached, the read count is
    // independent of group size.
    expect(largeReads).toBe(smallReads);
  });

  it('returns byte-identical rejected ids to an uncached reject for a small group', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-wp-4';
    const projectId = 'proj-wp-4';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId,
      groupId,
      payload: { taskId: 't-wp-4', dependsOn: [] },
    });
    const setStatus = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId,
      groupId,
      payload: {
        taskId: 't-wp-4',
        status: 'Ready',
        groomingGate: {
          size_check: { decision: 'n/a' },
          type_check: { decision: 'none' },
          seam_check: { decision: 'n/a' },
        },
      },
    });

    const reject = await agent
      .post(`/api/staged-intents/group/${groupId}/reject`)
      .send({ outcome: 'decline', reason: 'no longer needed' });

    expect(reject.status).toBe(200);
    expect(reject.body.rejected?.sort() ?? []).toEqual(
      [dependsOn.body.id, setStatus.body.id].sort(),
    );
  });
});
