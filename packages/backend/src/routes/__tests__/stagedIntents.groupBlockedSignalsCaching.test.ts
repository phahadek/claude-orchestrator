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
import { insertStagedIntent, insertSession } from '../../db/queries';
import type { StagedIntentRow } from '../../db/types';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
} from '../stagedIntents';

function seedSession(
  sessionId: string,
  status: string = 'running',
  archived = 0,
): void {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    status,
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
  if (archived) {
    db.prepare('UPDATE sessions SET archived = 1 WHERE session_id = ?').run(
      sessionId,
    );
  }
}

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
  db.prepare('DELETE FROM sessions').run();
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

  it('does not mark this group blocked when the owning session blocks via a different (sibling) group', async () => {
    const groupId = 'group-sibling-a';
    const blockingGroupId = 'group-sibling-b';
    const sessionId = 'session-cross-group';
    seedSession(sessionId, 'running');
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
    expect(own.groupBlocked).toBe(false);
    expect(own.groupBlockedMemberCount).toBe(0);
    expect(own.groupSessionIncomplete).toBe(false);
    expect(own.blockingGroupId).toBeNull();
    expect(own.blockingGroupBlockedMemberCount).toBeNull();
  });

  it('does not mark this group blocked when the session-blocking row has no group of its own', async () => {
    const groupId = 'group-ungrouped-blocker';
    const sessionId = 'session-ungrouped-blocker';
    seedSession(sessionId, 'running');
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
    expect(own.groupBlocked).toBe(false);
    expect(own.groupSessionIncomplete).toBe(false);
    expect(own.blockingGroupId).toBeNull();
    expect(own.blockingGroupBlockedMemberCount).toBeNull();
  });

  it('still marks this group blocked when the blocked member belongs to this group itself', async () => {
    const groupId = 'group-own-blocked-live-session';
    const sessionId = 'session-own-group-blocked';
    seedSession(sessionId, 'running');
    const ownMember = makeRow({
      id: 'own-member-3',
      group_id: groupId,
      milestone: 'M13',
      session_id: sessionId,
      state: 'staged',
    });
    const blockedMember = makeRow({
      id: 'blocked-member-3',
      group_id: groupId,
      milestone: 'M13',
      session_id: sessionId,
      state: 'needs_revision',
    });
    [ownMember, blockedMember].forEach(insertStagedIntent);

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    expect(res.status).toBe(200);
    const own = res.body.intents.find(
      (i: { id: string }) => i.id === 'own-member-3',
    );
    expect(own.groupBlocked).toBe(true);
    expect(own.groupBlockedMemberCount).toBe(1);
    expect(own.groupSessionIncomplete).toBe(true);
  });

  it('reports committable for a terminal session with a stale blocked intent in a sibling group (regression fixture)', async () => {
    // Reproduces the reported shape: a terminal (done) session left a
    // needs_revision intent behind in group A, and still has an active
    // member in unrelated group B. Group B must be committable.
    const sessionId = 'session-terminal-cross-group';
    seedSession(sessionId, 'done');
    const groupA = 'groom-latency-jitter-3d022f91';
    const groupB = 'groom-3d022f91-latency-jitter';
    const staleBlocked = makeRow({
      id: 'stale-blocked-a',
      group_id: groupA,
      milestone: 'M13',
      session_id: sessionId,
      state: 'needs_revision',
    });
    const activeInB = makeRow({
      id: 'active-member-b',
      group_id: groupB,
      milestone: 'M13',
      session_id: sessionId,
      state: 'staged',
    });
    [staleBlocked, activeInB].forEach(insertStagedIntent);

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-1', milestone: 'M13' });

    expect(res.status).toBe(200);
    const groupBIntent = res.body.intents.find(
      (i: { id: string }) => i.id === 'active-member-b',
    );
    expect(groupBIntent.groupBlocked).toBe(false);
    expect(groupBIntent.groupBlockedMemberCount).toBe(0);
    expect(groupBIntent.groupSessionIncomplete).toBe(false);
  });
});
