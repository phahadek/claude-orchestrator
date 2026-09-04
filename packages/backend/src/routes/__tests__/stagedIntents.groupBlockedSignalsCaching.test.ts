/**
 * GET /api/staged-intents?milestone=... must not recompute a shared group's
 * blocked/incomplete signal once per member of that group — rowToApi's
 * computeGroupBlockedSignals call re-reads every member of the group
 * (listStagedIntentsByGroup) on every invocation, so mapping it once per row
 * in a group of size N re-reads the group N times (quadratic in group
 * size). This asserts a request-scoped cache bounds that to one read per
 * group per request, while leaving the returned intents byte-identical.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { listStagedIntentsByGroupSpy } = vi.hoisted(() => ({
  listStagedIntentsByGroupSpy: vi.fn(),
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    listStagedIntentsByGroup: (groupId: string) => {
      listStagedIntentsByGroupSpy(groupId);
      return actual.listStagedIntentsByGroup(groupId);
    },
  };
});

import { db } from '../../db/db';
import { insertStagedIntent } from '../../db/queries';
import type { StagedIntentRow } from '../../db/types';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
} from '../stagedIntents';

const M13 = {
  id: 'ms-uuid-13',
  name: 'M13 — Orchestrator-Owned Planning',
  canonicalShortId: 'M13',
};

function seedProjectWithMilestone(projectId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, projectId, `/tmp/${projectId}`, 'notion', now, now);
  db.prepare(
    `INSERT INTO milestones (id, project_id, name, canonical_short_id, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(M13.id, projectId, M13.name, M13.canonicalShortId, 0, now, now);
}

let counter = 0;
function makeRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  counter += 1;
  const now = Date.now();
  return {
    id: `intent-${counter}`,
    kind: 'task.setStatus',
    payload: JSON.stringify({ taskId: `task-${counter}` }),
    payload_hash: `hash-${counter}`,
    task_id: `task-${counter}`,
    project_id: 'proj-1',
    session_id: null,
    group_id: null,
    milestone: null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  setStagedIntentBroadcast(() => {});
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  counter = 0;
  listStagedIntentsByGroupSpy.mockClear();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  seedProjectWithMilestone('proj-1');
});

describe('GET /api/staged-intents?milestone= — group signal caching', () => {
  it('reads a shared group once per request, not once per member', async () => {
    const groupId = 'group-1';
    const members = Array.from({ length: 10 }, (_, i) =>
      makeRow({
        id: `member-${i}`,
        group_id: groupId,
        milestone: 'M13',
      }),
    );
    members.forEach(insertStagedIntent);

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    expect(res.status).toBe(200);
    expect(res.body.intents).toHaveLength(10);

    const readsForGroup = listStagedIntentsByGroupSpy.mock.calls.filter(
      (call) => call[0] === groupId,
    );
    expect(readsForGroup).toHaveLength(1);
  });

  it('returns the same groupBlocked/groupBlockedMemberCount/groupSessionIncomplete values as an uncached read', async () => {
    const groupId = 'group-2';
    const blockedMember = makeRow({
      id: 'blocked-member',
      group_id: groupId,
      milestone: 'M13',
      state: 'needs_revision',
    });
    const okMembers = Array.from({ length: 4 }, (_, i) =>
      makeRow({
        id: `ok-member-${i}`,
        group_id: groupId,
        milestone: 'M13',
      }),
    );
    [blockedMember, ...okMembers].forEach(insertStagedIntent);

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    expect(res.status).toBe(200);
    for (const intent of res.body.intents) {
      expect(intent.groupBlocked).toBe(true);
      expect(intent.groupBlockedMemberCount).toBe(1);
      expect(intent.groupSessionIncomplete).toBe(false);
      expect(intent.blockingGroupId).toBeNull();
      expect(intent.blockingGroupBlockedMemberCount).toBeNull();
    }
  });

  it('leaves blockingGroupId null when the group is blocked by its own member', async () => {
    const groupId = 'group-own';
    const blockedMember = makeRow({
      id: 'own-blocked-member',
      group_id: groupId,
      milestone: 'M13',
      state: 'needs_revision',
    });
    insertStagedIntent(blockedMember);

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    expect(res.status).toBe(200);
    expect(res.body.intents).toHaveLength(1);
    expect(res.body.intents[0].groupBlocked).toBe(true);
    expect(res.body.intents[0].groupBlockedMemberCount).toBe(1);
    expect(res.body.intents[0].blockingGroupId).toBeNull();
    expect(res.body.intents[0].blockingGroupBlockedMemberCount).toBeNull();
  });

  it('resolves blockingGroupId to a sibling group when the owning session blocks via a different group', async () => {
    const groupId = 'group-sibling-a';
    const blockingGroupId = 'group-sibling-b';
    const sessionId = 'session-cross-group';
    const ownMember = makeRow({
      id: 'own-member',
      group_id: groupId,
      milestone: 'M13',
      session_id: sessionId,
      state: 'staged',
    });
    const blockerMember = makeRow({
      id: 'blocker-member',
      group_id: blockingGroupId,
      milestone: 'M13',
      session_id: sessionId,
      state: 'needs_revision',
    });
    [ownMember, blockerMember].forEach(insertStagedIntent);

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    expect(res.status).toBe(200);
    const own = res.body.intents.find(
      (i: { id: string }) => i.id === 'own-member',
    );
    expect(own.groupBlocked).toBe(true);
    expect(own.groupBlockedMemberCount).toBe(0);
    expect(own.groupSessionIncomplete).toBe(true);
    expect(own.blockingGroupId).toBe(blockingGroupId);
    expect(own.blockingGroupBlockedMemberCount).toBe(1);
  });

  it('leaves blockingGroupId null when the session-blocking row has no group of its own', async () => {
    const groupId = 'group-ungrouped-blocker';
    const sessionId = 'session-ungrouped-blocker';
    const ownMember = makeRow({
      id: 'own-member-2',
      group_id: groupId,
      milestone: 'M13',
      session_id: sessionId,
      state: 'staged',
    });
    const blockerMember = makeRow({
      id: 'blocker-member-2',
      group_id: null,
      milestone: 'M13',
      session_id: sessionId,
      state: 'needs_revision',
    });
    [ownMember, blockerMember].forEach(insertStagedIntent);

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    expect(res.status).toBe(200);
    const own = res.body.intents.find(
      (i: { id: string }) => i.id === 'own-member-2',
    );
    expect(own.groupBlocked).toBe(true);
    expect(own.groupSessionIncomplete).toBe(true);
    expect(own.blockingGroupId).toBeNull();
    expect(own.blockingGroupBlockedMemberCount).toBeNull();
  });
});
