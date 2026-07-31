/**
 * Operator-usable recovery for a decision group with a blocked member:
 * before this, commit refused any group holding a needs_revision/
 * pending_verification member (correctly), but nothing could move a blocked
 * member off that state — approve 409s, decline 404s on a fully-blocked
 * group, and pushback amplified one blocked member into an all-blocked,
 * permanently uncommittable group. These tests cover the operator-usable
 * exit this task adds: per-member decline, group-level decline on a fully
 * blocked group, and a refusal against the pushback amplifier.
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

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: { getById: () => undefined },
}));

import { db } from '../../db/db';
import {
  insertStagedIntent,
  getStagedIntent,
  insertSession,
} from '../../db/queries';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function seedPlanningSession(sessionId: string, taskId: string) {
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

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

let seq = 0;
function insertRow(opts: {
  id: string;
  groupId: string | null;
  taskId: string;
  kind?: string;
  state: 'staged' | 'approved' | 'needs_revision' | 'pending_verification';
  dispositionReason?: string | null;
  sessionId?: string | null;
}) {
  seq += 1;
  insertStagedIntent({
    id: opts.id,
    kind: opts.kind ?? 'task.updateBody',
    payload: JSON.stringify({
      taskId: opts.taskId,
      sections: { summary: 'x' },
    }),
    payload_hash: `hash-${opts.id}-${seq}`,
    task_id: opts.taskId,
    project_id: 'proj-blocked-recovery',
    session_id: opts.sessionId ?? 'sess-blocked-recovery',
    group_id: opts.groupId,
    milestone: null,
    state: opts.state,
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: opts.dispositionReason ?? null,
    answer: null,
    created_at: 1000,
    updated_at: 1000,
  });
}

describe('per-member decline of a blocked staged intent', () => {
  it('declines a needs_revision member straight to rejected via POST /:id/reject', async () => {
    const app = makeApp();
    const agent = supertest(app);
    insertRow({ id: 'nr-1', groupId: 'g-decline-1', taskId: 't-1', state: 'needs_revision' });

    const reject = await agent
      .post('/api/staged-intents/nr-1/reject')
      .send({ outcome: 'decline', reason: 'stale, task already re-groomed' });

    expect(reject.status).toBe(200);
    expect(getStagedIntent('nr-1')!.state).toBe('rejected');
  });

  it('declines a pending_verification member by hopping through needs_revision', async () => {
    const app = makeApp();
    const agent = supertest(app);
    insertRow({ id: 'pv-1', groupId: 'g-decline-2', taskId: 't-2', state: 'pending_verification' });

    const reject = await agent
      .post('/api/staged-intents/pv-1/reject')
      .send({ outcome: 'decline', reason: 'superseded by a later groom pass' });

    expect(reject.status).toBe(200);
    expect(getStagedIntent('pv-1')!.state).toBe('rejected');
  });

  it('refuses a pushback on a blocked member — needs_revision -> needs_revision is not a legal transition', async () => {
    const app = makeApp();
    const agent = supertest(app);
    insertRow({ id: 'nr-2', groupId: 'g-decline-3', taskId: 't-3', state: 'needs_revision' });

    const reject = await agent
      .post('/api/staged-intents/nr-2/reject')
      .send({ outcome: 'pushback', reason: 'revise this' });

    expect(reject.status).toBe(400);
    expect(getStagedIntent('nr-2')!.state).toBe('needs_revision');
  });

  it('unblocks the commit guard for its group once the blocked member is declined', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-unblock-commit';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-blocked-recovery',
      groupId,
      payload: { taskId: 't-unblock', dependsOn: [] },
    });
    await agent.post(`/api/staged-intents/${dependsOn.body.id}/approve`).send({});
    insertRow({
      id: 'nr-unblock',
      groupId,
      taskId: 't-unblock',
      state: 'needs_revision',
    });

    const commitBlocked = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});
    expect(commitBlocked.status).toBe(409);
    expect(commitBlocked.body.blockingId).toBe('nr-unblock');

    const decline = await agent
      .post('/api/staged-intents/nr-unblock/reject')
      .send({ outcome: 'decline', reason: 'no longer relevant' });
    expect(decline.status).toBe(200);

    const commitAfter = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});
    expect(commitAfter.status).toBe(200);
    expect(commitAfter.body.committed).toEqual([dependsOn.body.id]);
  });
});

describe('POST /group/:groupId/reject on a group with a blocked member', () => {
  it('declines a group whose members are ALL blocked (no live member at all) instead of 404ing', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-all-blocked';
    insertRow({ id: 'ab-1', groupId, taskId: 't-ab-1', state: 'needs_revision' });
    insertRow({ id: 'ab-2', groupId, taskId: 't-ab-2', state: 'pending_verification' });

    const reject = await agent
      .post(`/api/staged-intents/group/${groupId}/reject`)
      .send({ outcome: 'decline', reason: 'grooming task abandoned' });

    expect(reject.status).toBe(200);
    expect(reject.body.rejected.sort()).toEqual(['ab-1', 'ab-2']);
    expect(getStagedIntent('ab-1')!.state).toBe('rejected');
    expect(getStagedIntent('ab-2')!.state).toBe('rejected');
  });

  it('still 404s a group with no live and no blocked members', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const reject = await agent
      .post('/api/staged-intents/group/no-such-group/reject')
      .send({ outcome: 'decline', reason: 'anything' });

    expect(reject.status).toBe(404);
  });

  it('refuses a pushback that would leave every member of the group blocked', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-pushback-amplifier';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-blocked-recovery',
      groupId,
      payload: { taskId: 't-amp', dependsOn: [] },
    });
    insertRow({
      id: 'amp-blocked',
      groupId,
      taskId: 't-amp-2',
      state: 'needs_revision',
    });

    const reject = await agent
      .post(`/api/staged-intents/group/${groupId}/reject`)
      .send({ outcome: 'pushback', reason: 'revise the classification' });

    expect(reject.status).toBe(409);
    expect(reject.body.blockedIds).toEqual(['amp-blocked']);
    // The live member is untouched — still approvable/live, not swept into
    // needs_revision alongside the pre-existing blocked member.
    expect(getStagedIntent(dependsOn.body.id)!.state).toBe('staged');
    expect(getStagedIntent('amp-blocked')!.state).toBe('needs_revision');
  });

  it('a pushback with no pre-existing blocked member still works as before', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-pushback-clean';

    const dependsOn = await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-blocked-recovery',
      groupId,
      payload: { taskId: 't-clean', dependsOn: [] },
    });

    const reject = await agent
      .post(`/api/staged-intents/group/${groupId}/reject`)
      .send({ outcome: 'pushback', reason: 'revise the classification' });

    expect(reject.status).toBe(200);
    expect(getStagedIntent(dependsOn.body.id)!.state).toBe('needs_revision');
  });
});

describe('a commit refusal is never persisted as a disposition reason', () => {
  it('refuses a per-item decline whose reason is the commit-refusal message copied verbatim', async () => {
    const app = makeApp();
    const agent = supertest(app);
    insertRow({ id: 'copy-1', groupId: 'g-copy-1', taskId: 't-copy-1', state: 'needs_revision' });

    const reject = await agent.post('/api/staged-intents/copy-1/reject').send({
      outcome: 'decline',
      reason:
        'group "g-copy-1" has a blocked member ("copy-1", state "needs_revision") ' +
        '— it must be recovered or resolved before this group can commit',
    });

    expect(reject.status).toBe(400);
    expect(getStagedIntent('copy-1')!.disposition_reason).toBeNull();
    expect(getStagedIntent('copy-1')!.state).toBe('needs_revision');
  });

  it('refuses a group-level pushback whose reason is a copied refusal message', async () => {
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-copy-2';
    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-blocked-recovery',
      groupId,
      payload: { taskId: 't-copy-2', dependsOn: [] },
    });

    const reject = await agent
      .post(`/api/staged-intents/group/${groupId}/reject`)
      .send({
        outcome: 'pushback',
        reason: `no live staged intents found for group "${groupId}"`,
      });

    expect(reject.status).toBe(400);
  });
});

describe('apply-time failure still records the underlying failure as the reason', () => {
  it('records the thrown error message, not a commit-refusal message, when a member fails mid-commit', async () => {
    const setDependsOn = vi
      .fn()
      .mockRejectedValue(new Error('invalid status transition for t-fail: Done -> Ready'));
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nClean.'),
      updateStatus: vi.fn(),
      setDependsOn,
    });
    const app = makeApp();
    const agent = supertest(app);
    const groupId = 'g-apply-fail';

    seedPlanningSession('sess-apply-fail', 't-fail');
    const dependsOn = stageIntent(
      'task.setDependsOn',
      { taskId: 't-fail', dependsOn: [] },
      'proj-blocked-recovery',
      groupId,
      'sess-apply-fail',
    );
    await agent.post(`/api/staged-intents/${dependsOn.id}/approve`).send({});

    const commit = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});

    expect(commit.status).toBe(500);
    const row = getStagedIntent(dependsOn.id)!;
    expect(row.state).toBe('needs_revision');
    expect(row.disposition_reason).toContain(
      'invalid status transition for t-fail: Done -> Ready',
    );
    expect(row.disposition_reason).not.toContain(
      'it must be recovered or resolved before this group can commit',
    );
  });
});
