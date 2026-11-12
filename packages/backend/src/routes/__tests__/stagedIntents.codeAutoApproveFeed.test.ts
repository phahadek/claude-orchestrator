/**
 * Code auto-approved feed + revert: the feed lists only system/auto-committed
 * groups with evidence and advisory status; revert flips a still-Ready task to
 * Backlog and records the disagreement event, and is refused otherwise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  updateStatus: vi.fn(),
  recordEvent: vi.fn(),
  queryAudit: vi.fn(),
  getStagedIntent: vi.fn(),
  getCachedStatus: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: () => ({ updateStatus: h.updateStatus }),
}));
vi.mock('../../audit/AuditLog', () => ({
  recordEvent: h.recordEvent,
  queryAuditLogByProject: h.queryAudit,
}));
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});
vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getStagedIntent: h.getStagedIntent,
    getTaskCache: () => ({
      task_id: 't1',
      fetched_at: 0,
      raw_json: JSON.stringify({ title: 'Task One' }),
    }),
  };
});
vi.mock('../../tasks/TaskWriteCommands', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../tasks/TaskWriteCommands')>();
  return { ...actual, getCachedStatus: h.getCachedStatus };
});

import {
  listCodeAutoApprovedFeed,
  revertCodeAutoApproval,
} from '../stagedIntents';

const evidence = {
  standardVersion: '1',
  tripwireVersion: '2',
  conditions: [{ id: 'c1', passed: true }],
};

function setAudit(reverts: unknown[] = []) {
  h.queryAudit.mockImplementation((_p: string, f: { eventType: string }) => ({
    entries:
      f.eventType === 'staged_intent_group_committed'
        ? [
            {
              id: 1,
              ts: 100,
              eventType: f.eventType,
              actorType: 'system',
              payload: {
                group_id: 'g1',
                committed: ['i1'],
                provenance: 'auto',
                evidence,
              },
            },
            {
              id: 2,
              ts: 110,
              eventType: f.eventType,
              actorType: 'human',
              payload: { group_id: 'g2', committed: ['i2'] },
            },
          ]
        : reverts,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getStagedIntent.mockReturnValue({
    id: 'i1',
    kind: 'task.setStatus',
    payload: JSON.stringify({ taskId: 't1', status: 'Ready' }),
    advisory: JSON.stringify({ status: 'flagged' }),
  });
  h.getCachedStatus.mockReturnValue('Ready');
  setAudit();
});

describe('listCodeAutoApprovedFeed', () => {
  it('returns only system-committed groups with evidence and advisory', () => {
    const feed = listCodeAutoApprovedFeed('p1');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      groupId: 'g1',
      taskId: 't1',
      taskName: 'Task One',
      standardVersion: '1',
      tripwireVersion: '2',
      advisoryStatus: 'flagged',
      advisoryFlagged: true,
      revertible: true,
    });
    expect(feed[0].evidence).toEqual(evidence);
  });

  it('is not revertible once the task has left Ready', () => {
    h.getCachedStatus.mockReturnValue('In Progress');
    expect(listCodeAutoApprovedFeed('p1')[0].revertible).toBe(false);
  });
});

describe('revertCodeAutoApproval', () => {
  it('sets Backlog and records the disagreement event', async () => {
    const res = await revertCodeAutoApproval('p1', 't1', 'g1');
    expect(res.status).toBe(200);
    expect(h.updateStatus).toHaveBeenCalledWith('t1', 'Backlog', {
      source: 'human',
    });
    expect(h.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'code_auto_approve_reverted',
        actor_type: 'human',
        task_id: 'notion:t1',
        payload: expect.objectContaining({
          group_id: 'g1',
          disposition: 'human_disagreed_with_auto_approval',
        }),
      }),
    );
  });

  it('is refused when the task is no longer Ready', async () => {
    h.getCachedStatus.mockReturnValue('In Progress');
    const res = await revertCodeAutoApproval('p1', 't1', 'g1');
    expect(res.status).toBe(409);
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.recordEvent).not.toHaveBeenCalled();
  });

  it('is refused when the group was already reverted', async () => {
    setAudit([{ id: 9, ts: 150, payload: { group_id: 'g1' } }]);
    const res = await revertCodeAutoApproval('p1', 't1', 'g1');
    expect(res.status).toBe(409);
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it('refuses a concurrent second revert for the same task', async () => {
    const [a, b] = await Promise.all([
      revertCodeAutoApproval('p1', 't1', 'g1'),
      revertCodeAutoApproval('p1', 't1', 'g1'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(h.updateStatus).toHaveBeenCalledTimes(1);
    expect(h.recordEvent).toHaveBeenCalledTimes(1);
  });
});
