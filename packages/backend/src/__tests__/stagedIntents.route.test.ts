/**
 * Route-level tests for the staged-intents apply chokepoint's Ready-transition
 * readiness-gate wiring: a blocked apply surfaces the structured report on the
 * staged intent instead of discarding it, and override + reason applies the
 * intent and records an audit event.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { EventEmitter } from 'events';

const { mockGetTaskBackend, mockRecordEvent } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockRecordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

// Isolated in-memory db (test/helpers/setupTestDb.ts) instead of the real
// file-backed singleton — otherwise staged_intent rows persist across test
// cases (and test files, and CI runs) and produce spurious dedup/lock
// collisions.
vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries')>();
  return {
    ...actual,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

import { db } from '../db/db';
import { insertStagedIntent, insertSession, getTaskCache } from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
  stageIntent,
  broadcastIntentById,
  READY_PATH_KINDS,
  OPS_TERMINAL_KINDS,
} from '../routes/stagedIntents';
import type { SessionManager } from '../session/SessionManager';
import type { ServerMessage } from '../ws/types';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

/**
 * gate.accrete / seed.stage resolve their sourceTask's milestone against a
 * real project (resolveMilestoneForProject -> ProjectService.getById) —
 * seed a project + milestone row so that lookup succeeds.
 */
function insertProjectWithMilestone(
  projectId: string,
  milestone: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, projectId, `/tmp/${projectId}`, 'notion', now, now);
  db.prepare(
    `INSERT INTO milestones (id, project_id, name, source_id, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`${projectId}-ms`, projectId, milestone, null, 0, now, now);
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
});

/**
 * A Ready-transition apply also runs through the DependsOnCompleteness
 * invariant (stagedIntents.ts) and the grooming promotion gate
 * (TaskWriteCommands.setStatus) before it ever reaches the readiness gate
 * under test here — stage a satisfying task.setDependsOn sibling in the
 * same group plus a fully-dispositioned groomingGate so those two clear and
 * only the readiness gate is exercised.
 */
async function stageReadyStatus(
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
  return agent.post('/api/staged-intents').send({
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
}

/**
 * Grouped intents are only ever written through the group's atomic commit
 * route (Approve->Commit unification) — POST /:id/apply is standalone-only
 * and 409s for any intent carrying a group_id. Approves every live intent
 * in the group, then commits it, mirroring the panel's Approve -> Commit flow.
 */
async function approveAndCommitGroup(
  agent: ReturnType<typeof supertest>,
  groupId: string,
  body: Record<string, unknown> = {},
) {
  const list = await agent.get('/api/staged-intents').query({});
  for (const intent of list.body.intents.filter(
    (i: { groupId: string | null; state: string }) =>
      i.groupId === groupId && i.state === 'staged',
  )) {
    await agent.post(`/api/staged-intents/${intent.id}/approve`).send({});
  }
  return agent.post(`/api/staged-intents/group/${groupId}/commit`).send(body);
}

describe('POST /api/staged-intents/group/:groupId/commit — readiness gate', () => {
  it('blocks a Ready transition with an unresolved Open Questions section, and keeps the intent staged with an annotation', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Open Questions\n- Still unresolved?\n'),
      updateStatus: vi.fn(),
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await stageReadyStatus(
      agent,
      'proj-blocked',
      'notion:abc',
      'group-blocked',
    );
    expect(staged.status).toBe(201);

    const committed = await approveAndCommitGroup(agent, 'group-blocked');
    expect(committed.status).toBe(409);
    expect(committed.body.violations).toEqual([
      expect.objectContaining({ tier: 'structural' }),
    ]);

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-blocked' });
    const statusIntent = list.body.intents.find(
      (i: { kind: string }) => i.kind === 'task.setStatus',
    );
    expect(statusIntent.annotation).toEqual({
      blocked: true,
      violations: expect.arrayContaining([
        expect.objectContaining({ tier: 'structural' }),
      ]),
    });
  });

  it('applies with override + reason and records an audit event with actor, reason, and tier', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
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

    const staged = await stageReadyStatus(
      agent,
      'proj-2',
      'notion:abc',
      'group-2',
    );
    expect(staged.status).toBe(201);

    const committed = await approveAndCommitGroup(agent, 'group-2', {
      override: true,
      reason: 'reviewed manually, safe to proceed',
    });

    expect(committed.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
    expect(mockRecordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'readiness_override',
        actor_type: 'human',
        payload: expect.objectContaining({
          reason: 'reviewed manually, safe to proceed',
          tiers: ['structural'],
        }),
      }),
    );

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-2' });
    expect(
      list.body.intents.some(
        (i: { kind: string }) => i.kind === 'task.setStatus',
      ),
    ).toBe(false);
  });

  it('requires a reason when override is true', async () => {
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue(''),
      updateStatus: vi.fn(),
    });
    const app = makeApp();
    const agent = supertest(app);

    // Backlog, not Ready — a Ready-targeting task.setStatus is a Ready-path
    // member and must carry a groupId (see ReadyPathMissingGroupError),
    // which would force it through the group commit route instead of this
    // standalone /apply override+reason check.
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-no-reason',
      payload: { taskId: 'notion:abc', status: 'Backlog' },
    });

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({ override: true });
    expect(applied.status).toBe(400);
  });

  it('applies a clean Ready transition without override', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll clear.'),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await stageReadyStatus(
      agent,
      'proj-clean',
      'notion:abc',
      'group-clean',
    );
    expect(staged.status).toBe(201);

    const committed = await approveAndCommitGroup(agent, 'group-clean');
    expect(committed.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
  });
});

describe('POST /api/staged-intents/group/:groupId/commit — grooming promotion gate', () => {
  it('blocks a Ready transition whose staged groomingGate entry is undispositioned, and keeps the intent staged with an annotation', async () => {
    const updateStatus = vi.fn();
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll clear.'),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-groom-blocked',
      groupId: 'group-groom-blocked',
      payload: { taskId: 'notion:abc', dependsOn: [] },
    });
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-groom-blocked',
      groupId: 'group-groom-blocked',
      payload: {
        taskId: 'notion:abc',
        status: 'Ready',
        groomingGate: { size_check: null, type_check: null },
      },
    });
    expect(staged.status).toBe(201);

    const committed = await approveAndCommitGroup(agent, 'group-groom-blocked');
    expect(committed.status).toBe(409);
    expect(committed.body.reasons.join(' ')).toMatch(/size_check/);
    expect(updateStatus).not.toHaveBeenCalled();

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-groom-blocked' });
    const statusIntent = list.body.intents.find(
      (i: { kind: string }) => i.kind === 'task.setStatus',
    );
    expect(statusIntent.annotation).toEqual({
      blocked: true,
      reasons: expect.arrayContaining([expect.stringMatching(/size_check/)]),
    });
  });

  it('applies a Ready transition whose staged groomingGate entry is fully dispositioned', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nAll clear.'),
      updateStatus,
      setDependsOn: vi.fn().mockResolvedValue(undefined),
    });
    const app = makeApp();
    const agent = supertest(app);

    await agent.post('/api/staged-intents').send({
      kind: 'task.setDependsOn',
      projectId: 'proj-groom-clean',
      groupId: 'group-groom-clean',
      payload: { taskId: 'notion:abc', dependsOn: [] },
    });
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-groom-clean',
      groupId: 'group-groom-clean',
      payload: {
        taskId: 'notion:abc',
        status: 'Ready',
        groomingGate: {
          size_check: {
            decision: 'no_split',
            files: 1,
            loc: 40,
            loc_method: 'estimated',
          },
          type_check: { decision: 'none' },
        },
      },
    });
    expect(staged.status).toBe(201);

    const committed = await approveAndCommitGroup(agent, 'group-groom-clean');
    expect(committed.status).toBe(200);
    expect(updateStatus).toHaveBeenCalledWith(
      'notion:abc',
      '🗂️ Ready',
      expect.objectContaining({ source: 'human' }),
    );
  });
});

describe('POST /api/staged-intents — kind validation', () => {
  it('accepts task.updateBody, task.setProperties, and task.archive', async () => {
    // task.updateBody / task.setProperties resolve their subject taskId at
    // stage time (assertTaskIdResolves) — the task cache is mocked to miss
    // in this file, so it falls back to a live backend fetch.
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    for (const kind of [
      'task.updateBody',
      'task.setProperties',
      'task.setType',
      'task.archive',
      'task.move',
      'gate.accrete',
      'seed.stage',
      'journal.setState',
    ]) {
      const res = await agent.post('/api/staged-intents').send({
        kind,
        projectId: 'proj-kinds',
        payload: { taskId: 'notion:abc' },
        groupId: 'group-kinds',
      });
      expect(res.status).toBe(201);
    }
  });

  it('rejects an unknown intent kind', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const res = await agent
      .post('/api/staged-intents')
      .send({ kind: 'task.doSomethingUnknown', projectId: 'proj-kinds' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/staged-intents/:id/apply — new kinds', () => {
  it('applies task.updateBody, task.setProperties, and task.archive', async () => {
    const updateBody = vi.fn().mockResolvedValue(undefined);
    const setProperties = vi.fn().mockResolvedValue(undefined);
    const archive = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      updateBody,
      setProperties,
      archive,
      // task.updateBody / task.setProperties resolve their subject taskId at
      // stage time via a live backend fetch (assertTaskIdResolves) since the
      // task cache is mocked to miss in this file.
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const bodyIntent = await agent.post('/api/staged-intents').send({
      kind: 'task.updateBody',
      projectId: 'proj-new-kinds',
      payload: { taskId: 'notion:abc', sections: { summary: 'hi' } },
    });
    const bodyApplied = await agent
      .post(`/api/staged-intents/${bodyIntent.body.id}/apply`)
      .send({});
    expect(bodyApplied.status).toBe(200);
    expect(updateBody).toHaveBeenCalledWith(
      'notion:abc',
      { summary: 'hi' },
      expect.objectContaining({ source: 'human' }),
    );

    const propsIntent = await agent.post('/api/staged-intents').send({
      kind: 'task.setProperties',
      projectId: 'proj-new-kinds',
      payload: { taskId: 'notion:abc', patch: { priority: '🔴 High' } },
    });
    const propsApplied = await agent
      .post(`/api/staged-intents/${propsIntent.body.id}/apply`)
      .send({});
    expect(propsApplied.status).toBe(200);
    expect(setProperties).toHaveBeenCalledWith(
      'notion:abc',
      { priority: '🔴 High' },
      expect.objectContaining({ source: 'human' }),
    );

    const archiveIntent = await agent.post('/api/staged-intents').send({
      kind: 'task.archive',
      projectId: 'proj-new-kinds',
      payload: { taskId: 'notion:abc' },
    });
    const archiveApplied = await agent
      .post(`/api/staged-intents/${archiveIntent.body.id}/apply`)
      .send({});
    expect(archiveApplied.status).toBe(200);
    expect(archive).toHaveBeenCalledWith(
      'notion:abc',
      expect.objectContaining({ source: 'human' }),
    );
  });

  it('rejects applying archive / structural intents with a session credential (human-apply-only)', async () => {
    const archive = vi.fn().mockResolvedValue(undefined);
    const updateBody = vi.fn().mockResolvedValue(undefined);
    const setProperties = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      archive,
      updateBody,
      setProperties,
      // task.updateBody / task.setProperties / task.move resolve their
      // subject taskId at stage time via a live backend fetch
      // (assertTaskIdResolves) since the task cache is mocked to miss.
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    for (const [kind, payload] of [
      ['task.archive', { taskId: 'notion:abc' }],
      ['task.updateBody', { taskId: 'notion:abc', sections: {} }],
      ['task.setProperties', { taskId: 'notion:abc', patch: {} }],
      [
        'task.move',
        {
          taskId: 'notion:abc',
          content: { title: 't', sections: {}, status: 'Backlog' },
          sourceMilestone: { id: 'm1', displayOrder: 0 },
          targetMilestone: { id: 'm2', displayOrder: 1, databaseId: 'db2' },
          originalDisposition: 'archive',
        },
      ],
    ] as const) {
      const staged = await agent.post('/api/staged-intents').send({
        kind,
        projectId: 'proj-session',
        payload,
      });
      const applied = await agent
        .post(`/api/staged-intents/${staged.body.id}/apply`)
        .send({ actorType: 'session' });
      expect(applied.status).toBe(403);
    }
    expect(archive).not.toHaveBeenCalled();
    expect(updateBody).not.toHaveBeenCalled();
    expect(setProperties).not.toHaveBeenCalled();
  });
});

describe('POST /api/staged-intents/:id/apply — task.setType', () => {
  it('applies a valid Type transition', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi
        .fn()
        .mockResolvedValue('## Summary\nSome design doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId: 'proj-set-type',
      payload: { taskId: 'notion:abc', type: '📐 Design' },
    });
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(setType).toHaveBeenCalledWith(
      'notion:abc',
      '📐 Design',
      expect.objectContaining({ source: 'human' }),
    );
  });

  it('rejects an invalid Type transition (unknown type) without calling the backend', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId: 'proj-set-type-invalid',
      payload: { taskId: 'notion:abc', type: '🚫 NotAType' },
    });
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(500);
    expect(setType).not.toHaveBeenCalled();
  });

  it('rejects applying task.setType with a session credential (human-apply-only)', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setType',
      projectId: 'proj-set-type-session',
      payload: { taskId: 'notion:abc', type: '📐 Design' },
    });

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({ actorType: 'session' });
    expect(applied.status).toBe(403);
    expect(setType).not.toHaveBeenCalled();
  });
});

describe('POST /api/staged-intents/:id/apply — gate.accrete / seed.stage / journal.setState', () => {
  it('applies gate.accrete by dispatching through accreteGateContribution', async () => {
    // accreteGateContribution validates the source task exists on the board
    // (assertTaskExists -> fetchTaskPage) before minting gate items, and
    // resolves sourceTask.milestone against a real project/milestone row
    // (resolveMilestoneForProject).
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    insertProjectWithMilestone('proj-gate', 'M1');
    const app = makeApp();
    const agent = supertest(app);

    // gate.accrete is a Ready-path member and must carry a groupId (see
    // ReadyPathMissingGroupError), so it applies via the group commit route
    // rather than standalone /apply.
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'gate.accrete',
      projectId: 'proj-gate',
      groupId: 'group-gate',
      payload: {
        sourceTask: {
          id: 'notion:abc',
          title: 'Some Task',
          project: 'proj-gate',
          milestone: 'M1',
        },
        items: [{ text: 'Launch-and-observe the new endpoint' }],
        classification: 'Read-Only',
      },
    });
    expect(staged.status).toBe(201);

    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    const committed = await agent
      .post('/api/staged-intents/group/group-gate/commit')
      .send({});
    expect(committed.status).toBe(200);
    expect(committed.body.committed).toEqual([staged.body.id]);
  });

  it('applies seed.stage by dispatching through stageSeedContribution', async () => {
    // stageSeedContribution likewise validates the source task exists
    // (assertTaskExists -> fetchTaskPage) before staging seeds, and resolves
    // sourceTask.milestone against a real project/milestone row.
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    insertProjectWithMilestone('proj-seed', 'M1');
    const app = makeApp();
    const agent = supertest(app);

    // seed.stage is a Ready-path member and must carry a groupId (see
    // ReadyPathMissingGroupError), so it applies via the group commit route
    // rather than standalone /apply.
    const staged = await agent.post('/api/staged-intents').send({
      kind: 'seed.stage',
      projectId: 'proj-seed',
      groupId: 'group-seed',
      payload: {
        sourceTask: {
          id: 'notion:def',
          title: 'Some Config Task',
          project: 'proj-seed',
          milestone: 'M1',
        },
        seeds: [{ spec: 'Add feature flag FOO' }],
        decision: 'seeds',
      },
    });
    expect(staged.status).toBe(201);

    await agent.post(`/api/staged-intents/${staged.body.id}/approve`).send({});
    const committed = await agent
      .post('/api/staged-intents/group/group-seed/commit')
      .send({});
    expect(committed.status).toBe(200);
    expect(committed.body.committed).toEqual([staged.body.id]);
  });

  it('applies journal.setState by dispatching through the validated setEntryState', async () => {
    const { upsertOpsJournalEntry } = await import('../db/queries');
    upsertOpsJournalEntry({
      // ops_journal.task_id is stored bare in production (see reconcileJournal);
      // seed it that way here so the notion:-prefixed lookups below exercise
      // getOpsJournalEntry's cross-id-form normalization instead of trivially
      // matching on an identical literal.
      task_id: 'ghi',
      project: 'proj-journal',
      milestone: 'M1',
      state: 'pending',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });

    mockGetTaskBackend.mockReturnValue({ type: 'notion' });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      projectId: 'proj-journal',
      payload: { taskId: 'notion:ghi', state: 'candidate' },
    });
    expect(staged.status).toBe(201);

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);

    const { getOpsJournalEntry } = await import('../db/queries');
    expect(getOpsJournalEntry('notion:ghi')?.state).toBe('candidate');
  });

  it('rejects applying gate.accrete, seed.stage, and journal.setState with a session credential (human-apply-only)', async () => {
    mockGetTaskBackend.mockReturnValue({ type: 'notion' });
    const app = makeApp();
    const agent = supertest(app);

    // gate.accrete and seed.stage are Ready-path members and must carry a
    // groupId (see ReadyPathMissingGroupError), so the human-apply-only
    // check for them is exercised via the group commit route instead of
    // standalone /apply; journal.setState is unaffected and keeps using
    // standalone /apply directly.
    for (const [kind, payload, groupId] of [
      [
        'gate.accrete',
        {
          sourceTask: {
            id: 'notion:jkl',
            title: 'T',
            project: 'proj-session-2',
            milestone: 'M1',
          },
          items: [],
          classification: 'n/a',
        },
        'group-session-gate',
      ],
      [
        'seed.stage',
        {
          sourceTask: {
            id: 'notion:mno',
            title: 'T',
            project: 'proj-session-2',
            milestone: 'M1',
          },
          seeds: [],
          decision: 'n/a',
        },
        'group-session-seed',
      ],
      ['journal.setState', { taskId: 'notion:pqr', state: 'candidate' }, null],
    ] as const) {
      const staged = await agent.post('/api/staged-intents').send({
        kind,
        projectId: 'proj-session-2',
        payload,
        ...(groupId ? { groupId } : {}),
      });
      if (groupId) {
        await agent
          .post(`/api/staged-intents/${staged.body.id}/approve`)
          .send({});
        const committed = await agent
          .post(`/api/staged-intents/group/${groupId}/commit`)
          .send({ actorType: 'session' });
        expect(committed.status).toBe(403);
      } else {
        const applied = await agent
          .post(`/api/staged-intents/${staged.body.id}/apply`)
          .send({ actorType: 'session' });
        expect(applied.status).toBe(403);
      }
    }
  });
});

describe('the ops-terminal closing set is mandated under one shared groupId', () => {
  function seedOpsSession(sessionId: string, taskId: string) {
    insertSession({
      session_id: sessionId,
      task_id: taskId,
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'ops',
    });
  }

  it('rejects an ops-terminal journal.setState targeting resolved when staged with no groupId', async () => {
    const { upsertOpsJournalEntry } = await import('../db/queries');
    upsertOpsJournalEntry({
      task_id: 'notion:ops-1',
      project: 'proj-ops',
      milestone: 'M1',
      state: 'candidate',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });

    expect(() =>
      stageIntent(
        'journal.setState',
        { taskId: 'notion:ops-1', state: 'resolved' },
        'proj-ops',
      ),
    ).toThrow(/ops-terminal member/);
  });

  it('accepts the no-change terminal — journal.setState staged-proposal -> resolved staged with a shared groupId — and rejects it without one', async () => {
    const { upsertOpsJournalEntry } = await import('../db/queries');
    upsertOpsJournalEntry({
      task_id: 'notion:ops-no-change',
      project: 'proj-ops',
      milestone: 'M1',
      state: 'staged-proposal',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });

    expect(() =>
      stageIntent(
        'journal.setState',
        { taskId: 'notion:ops-no-change', state: 'resolved' },
        'proj-ops',
      ),
    ).toThrow(/ops-terminal member/);

    const intent = stageIntent(
      'journal.setState',
      { taskId: 'notion:ops-no-change', state: 'resolved' },
      'proj-ops',
      'group-no-change-1',
    );
    expect(intent.groupId).toBe('group-no-change-1');
  });

  it('an incidental mid-run journal.setState (not targeting resolved) may still be staged standalone', async () => {
    const { upsertOpsJournalEntry } = await import('../db/queries');
    upsertOpsJournalEntry({
      task_id: 'notion:ops-2',
      project: 'proj-ops',
      milestone: 'M1',
      state: 'pending',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });

    const intent = stageIntent(
      'journal.setState',
      { taskId: 'notion:ops-2', state: 'candidate' },
      'proj-ops',
    );
    expect(intent.groupId).toBeNull();
  });

  it('rejects a follow-on task.create staged by an ops session with no groupId', () => {
    seedOpsSession('ops-session-1', 'notion:ops-3');
    expect(() =>
      stageIntent(
        'task.create',
        { title: 'Follow-on from investigation', body: 'x' },
        'proj-ops',
        null,
        'ops-session-1',
      ),
    ).toThrow(/ops-terminal member/);
  });

  it('rejects a task-body write recording the finding (task.updateBody / task.patchBodySection) staged by an ops session with no groupId', () => {
    seedOpsSession('ops-session-2', 'notion:ops-4');
    expect(() =>
      stageIntent(
        'task.updateBody',
        { taskId: 'notion:ops-4', sections: {} },
        'proj-ops',
        null,
        'ops-session-2',
      ),
    ).toThrow(/ops-terminal member/);

    expect(() =>
      stageIntent(
        'task.patchBodySection',
        {
          taskId: 'notion:ops-4',
          section: '### Finding',
          operation: 'append',
          content: 'x',
        },
        'proj-ops',
        null,
        'ops-session-2',
      ),
    ).toThrow(/ops-terminal member/);
  });

  it('a task.updateBody staged by a non-ops session is unaffected — the mandate is ops-scoped', () => {
    insertSession({
      session_id: 'groom-session-1',
      task_id: 'notion:ops-5',
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'groom',
    });
    const intent = stageIntent(
      'task.updateBody',
      { taskId: 'notion:ops-5', sections: {} },
      'proj-ops',
      null,
      'groom-session-1',
    );
    expect(intent.groupId).toBeNull();
  });

  it('planning.noOp and decision.pickOne remain legitimately ungrouped for an ops session', () => {
    seedOpsSession('ops-session-3', 'notion:ops-6');
    const noOp = stageIntent(
      'planning.noOp',
      { taskId: 'notion:ops-6', reason: 'nothing to add' },
      'proj-ops',
      null,
      'ops-session-3',
    );
    expect(noOp.groupId).toBeNull();

    const pickOne = stageIntent(
      'decision.pickOne',
      {
        prompt: 'Which mitigation?',
        options: [
          { label: 'a', description: 'Option A' },
          { label: 'b', description: 'Option B' },
        ],
        allowFreeForm: false,
      },
      'proj-ops',
      null,
      'ops-session-3',
      'A decision the operator must make.',
    );
    expect(pickOne.groupId).toBeNull();
  });

  it('single-sources the ops-terminal member set, and it cannot drift from the Ready-path set — they are disjoint kinds carried in the same module', () => {
    expect(OPS_TERMINAL_KINDS).toEqual(
      expect.arrayContaining([
        'journal.setState',
        'task.updateBody',
        'task.patchBodySection',
        'task.create',
      ]),
    );
    expect(OPS_TERMINAL_KINDS).toHaveLength(4);
    for (const kind of OPS_TERMINAL_KINDS) {
      expect(READY_PATH_KINDS).not.toContain(kind);
    }
  });

  it('accepts the same closing set once staged under one shared groupId', async () => {
    const { upsertOpsJournalEntry } = await import('../db/queries');
    upsertOpsJournalEntry({
      task_id: 'notion:ops-7',
      project: 'proj-ops',
      milestone: 'M1',
      state: 'candidate',
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });
    seedOpsSession('ops-session-4', 'notion:ops-7');

    const groupId = 'group-ops-close';
    const journal = stageIntent(
      'journal.setState',
      { taskId: 'notion:ops-7', state: 'resolved' },
      'proj-ops',
      groupId,
    );
    const body = stageIntent(
      'task.updateBody',
      { taskId: 'notion:ops-7', sections: {} },
      'proj-ops',
      groupId,
      'ops-session-4',
    );
    const followOn = stageIntent(
      'task.create',
      { title: 'Follow-on Code task', body: 'x' },
      'proj-ops',
      groupId,
      'ops-session-4',
    );

    expect([journal.groupId, body.groupId, followOn.groupId]).toEqual([
      groupId,
      groupId,
      groupId,
    ]);
  });
});

describe('an ops-terminal closing group is refused at commit unless it actually carries the resolved transition', () => {
  function seedOpsSession(sessionId: string, taskId: string) {
    insertSession({
      session_id: sessionId,
      task_id: taskId,
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'ops',
    });
  }

  async function seedJournal(taskId: string, state: string) {
    const { upsertOpsJournalEntry } = await import('../db/queries');
    upsertOpsJournalEntry({
      task_id: taskId,
      project: 'proj-ops-commit',
      milestone: 'M1',
      state: state as any,
      disposition: null,
      worked_in: null,
      evidence: null,
      finding_or_proposal: null,
      falsification: null,
      filed_followons: null,
      needs_from_operator: null,
      resolution: null,
      updated_at: new Date().toISOString(),
    });
  }

  it('refuses to commit a group carrying only a follow-on task.create — the worked-instance bug — naming the missing journal.setState -> resolved member', async () => {
    seedOpsSession('ops-commit-1', 'notion:ops-commit-1');
    mockGetTaskBackend.mockReturnValue({ type: 'notion' });
    const app = makeApp();
    const agent = supertest(app);

    const groupId = 'group-ops-commit-1';
    stageIntent(
      'task.create',
      { title: 'Follow-on from investigation', body: 'x', databaseId: 'db-1' },
      'proj-ops-commit',
      groupId,
      'ops-commit-1',
    );

    const result = await approveAndCommitGroup(agent, groupId);
    expect(result.status).toBe(409);
    expect(result.body.error).toContain('journal.setState');
    expect(result.body.error).toContain('resolved');
    expect(result.body.committed ?? []).toEqual([]);
  });

  it('commits an ops-terminal group that does carry the journal.setState -> resolved member', async () => {
    seedOpsSession('ops-commit-2', 'notion:ops-commit-2');
    await seedJournal('notion:ops-commit-2', 'candidate');
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask: vi.fn().mockResolvedValue('notion:new-followon'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const groupId = 'group-ops-commit-2';
    stageIntent(
      'journal.setState',
      { taskId: 'notion:ops-commit-2', state: 'resolved' },
      'proj-ops-commit',
      groupId,
    );
    stageIntent(
      'task.create',
      { title: 'Follow-on from investigation', body: 'x', databaseId: 'db-1' },
      'proj-ops-commit',
      groupId,
      'ops-commit-2',
    );

    const result = await approveAndCommitGroup(agent, groupId);
    expect(result.status).toBe(200);
    expect(result.body.committed).toHaveLength(2);
  });

  it('succeeds when the resolved transition was committed in an earlier apply of the same group', async () => {
    seedOpsSession('ops-commit-3', 'notion:ops-commit-3');
    await seedJournal('notion:ops-commit-3', 'candidate');
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask: vi.fn().mockResolvedValue('notion:new-followon-2'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const groupId = 'group-ops-commit-3';
    stageIntent(
      'journal.setState',
      { taskId: 'notion:ops-commit-3', state: 'resolved' },
      'proj-ops-commit',
      groupId,
    );
    const firstCommit = await approveAndCommitGroup(agent, groupId);
    expect(firstCommit.status).toBe(200);

    // A later turn stages a further member into the same group — the
    // journal.setState -> resolved sibling is already `committed`, not
    // `staged`/`approved`, so this exercises the durable-store (not
    // in-memory) tolerance.
    stageIntent(
      'task.create',
      { title: 'Follow-on from investigation', body: 'x', databaseId: 'db-1' },
      'proj-ops-commit',
      groupId,
      'ops-commit-3',
    );

    const secondCommit = await approveAndCommitGroup(agent, groupId);
    expect(secondCommit.status).toBe(200);
    expect(secondCommit.body.committed).toHaveLength(1);
  });
});

describe('POST /api/staged-intents — decision-proposal annotation', () => {
  it('round-trips the decisionProposal field through staging and listing', async () => {
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      projectId: 'proj-proposal',
      payload: { taskId: 'notion:stu', state: 'candidate' },
      decisionProposal:
        'Config drift observed; promote to candidate for review.',
    });
    expect(staged.status).toBe(201);
    expect(staged.body.decisionProposal).toBe(
      'Config drift observed; promote to candidate for review.',
    );

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-proposal' });
    const found = list.body.intents.find(
      (i: { id: string }) => i.id === staged.body.id,
    );
    expect(found.decisionProposal).toBe(
      'Config drift observed; promote to candidate for review.',
    );
  });

  it('stages a task.setStatus -> Deferred discard/defer proposal with its rationale, and it round-trips to the decision surface', async () => {
    // task.setStatus resolves its subject taskId at stage time
    // (assertTaskIdResolves) — the task cache is mocked to miss in this
    // file, so it falls back to a live backend fetch.
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome doc.\n'),
    });
    const app = makeApp();
    const agent = supertest(app);

    const staged = await agent.post('/api/staged-intents').send({
      kind: 'task.setStatus',
      projectId: 'proj-proposal',
      payload: { taskId: 'notion:xyz', status: 'Deferred' },
      decisionProposal:
        'Superseded by task notion:abc — defer instead of grooming to Ready.',
    });
    expect(staged.status).toBe(201);
    expect(staged.body.kind).toBe('task.setStatus');
    expect(staged.body.payload.status).toBe('Deferred');
    expect(staged.body.decisionProposal).toBe(
      'Superseded by task notion:abc — defer instead of grooming to Ready.',
    );

    const list = await agent
      .get('/api/staged-intents')
      .query({ projectId: 'proj-proposal' });
    const found = list.body.intents.find(
      (i: { id: string }) => i.id === staged.body.id,
    );
    expect(found.payload.status).toBe('Deferred');
    expect(found.decisionProposal).toBe(
      'Superseded by task notion:abc — defer instead of grooming to Ready.',
    );
  });
});

describe('milestone-inbox turn-boundary reveal', () => {
  const SESSION_ID = 'session-turn-boundary';
  let turnInFlight: boolean;
  let sessionManager: SessionManager & EventEmitter;

  function makeSessionManager() {
    turnInFlight = true;
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      getLiveSession: vi.fn().mockReturnValue({
        hasActiveTurn: () => turnInFlight,
      }),
    }) as unknown as SessionManager & EventEmitter;
  }

  let counter = 0;
  function stageIntent(
    overrides: Partial<StagedIntentRow> = {},
  ): StagedIntentRow {
    counter += 1;
    const now = Date.now();
    const row: StagedIntentRow = {
      id: `intent-${counter}`,
      kind: 'task.updateBody',
      payload: JSON.stringify({ taskId: 'task-1' }),
      payload_hash: `hash-${counter}`,
      task_id: 'task-1',
      project_id: 'proj-turn-boundary',
      session_id: SESSION_ID,
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
    insertStagedIntent(row);
    return row;
  }

  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    counter = 0;
    sessionManager = makeSessionManager();
    setStagedIntentBroadcast(() => {});
  });

  it('an intent staged mid-turn reads sessionComplete: false', async () => {
    const staged = stageIntent();
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
    const agent = supertest(app);

    const res = await agent
      .get('/api/staged-intents')
      .query({ sessionId: SESSION_ID });
    const found = res.body.intents.find(
      (i: { id: string }) => i.id === staged.id,
    );
    expect(found.sessionComplete).toBe(false);
  });

  it("re-broadcasts staged_intent_changed for each of a session's still-active intents when its turn ends, recomputed through isSessionComplete/rowToApi", async () => {
    const staged = stageIntent();
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));

    const broadcasts: ServerMessage[] = [];
    setStagedIntentBroadcast((msg) => broadcasts.push(msg));

    // Turn ends: hasActiveTurn flips false, then the existing
    // session_event/'result' signal lands on the SessionManager 'message'
    // stream — the same channel server.ts forwards to WS clients.
    turnInFlight = false;
    sessionManager.emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'result',
      content: '{}',
    } satisfies ServerMessage);

    const changed = broadcasts.filter(
      (m): m is Extract<ServerMessage, { type: 'staged_intent_changed' }> =>
        m.type === 'staged_intent_changed',
    );
    expect(changed).toHaveLength(1);
    expect(changed[0].intent.id).toBe(staged.id);
    expect(changed[0].intent.sessionComplete).toBe(true);
  });

  it('does not re-broadcast for an unrelated session_event, or for a different session', async () => {
    stageIntent();
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));

    const broadcasts: ServerMessage[] = [];
    setStagedIntentBroadcast((msg) => broadcasts.push(msg));

    sessionManager.emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'text',
      content: 'not a turn boundary',
    } satisfies ServerMessage);
    sessionManager.emit('message', {
      type: 'session_event',
      sessionId: 'some-other-session',
      eventType: 'result',
      content: '{}',
    } satisfies ServerMessage);

    expect(
      broadcasts.filter((m) => m.type === 'staged_intent_changed'),
    ).toHaveLength(0);
  });
});

describe('group-blockedness on the milestone list response', () => {
  const PROJECT_ID = 'proj-group-blocked';

  function makeSessionManager() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      getLiveSession: vi.fn().mockReturnValue({
        hasActiveTurn: () => false,
      }),
    }) as unknown as SessionManager & EventEmitter;
  }

  let counter = 0;
  function makeGroupMember(
    overrides: Partial<StagedIntentRow> = {},
  ): StagedIntentRow {
    counter += 1;
    const now = Date.now();
    const row: StagedIntentRow = {
      id: `gmember-${counter}`,
      kind: 'task.updateBody',
      payload: JSON.stringify({ taskId: `task-${counter}` }),
      payload_hash: `hash-${counter}`,
      task_id: `task-${counter}`,
      project_id: PROJECT_ID,
      session_id: null,
      group_id: 'group-under-test',
      milestone: 'M1',
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
    insertStagedIntent(row);
    return row;
  }

  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    db.prepare('DELETE FROM staged_intent_group').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    counter = 0;
    insertProjectWithMilestone(PROJECT_ID, 'M1');
    setStagedIntentBroadcast(() => {});
  });

  async function listMilestone(sessionManager?: SessionManager) {
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));
    const agent = supertest(app);
    return agent
      .get('/api/staged-intents')
      .query({ projectId: PROJECT_ID, milestone: 'M1' });
  }

  it('marks a visible sibling groupBlocked when the group has an auto-rejected needs_revision member hidden behind a still-live session', async () => {
    const sessionManager = makeSessionManager();
    insertSession({
      session_id: 'sess-live',
      task_id: 'task:sess-live',
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: 0,
      session_type: 'groom',
      task_name: null,
      metadata: null,
      review_result: null,
      pause_reason: null,
      last_error_detail: null,
      events_pruned_at: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      compaction_count: 0,
      context_occupancy_tokens: 0,
    } as never);
    const visible = makeGroupMember({
      session_id: 'sess-live',
      state: 'staged',
    });
    makeGroupMember({
      session_id: 'sess-live',
      state: 'needs_revision',
      annotation: JSON.stringify({ autoRejected: true }),
    });

    const res = await listMilestone(sessionManager);
    const ids = res.body.intents.map((i: { id: string }) => i.id);
    expect(ids).toContain(visible.id);
    // The auto-rejected member stays hidden while its session is live.
    expect(ids).toHaveLength(1);

    const found = res.body.intents.find(
      (i: { id: string }) => i.id === visible.id,
    );
    expect(found.groupBlocked).toBe(true);
    expect(found.groupBlockedMemberCount).toBe(1);
  });

  it('produces the same blocked presentation for an operator-pushback needs_revision member (no autoRejected annotation)', async () => {
    const blocked = makeGroupMember({ state: 'needs_revision' });
    const sibling = makeGroupMember({ state: 'staged' });

    const res = await listMilestone();
    const ids = res.body.intents.map((i: { id: string }) => i.id);
    // Not auto-rejected — stays visible (isVisibleOnDecisionSurface never
    // hides operator-pushback rows).
    expect(ids).toContain(blocked.id);
    expect(ids).toContain(sibling.id);

    for (const id of [blocked.id, sibling.id]) {
      const found = res.body.intents.find((i: { id: string }) => i.id === id);
      expect(found.groupBlocked).toBe(true);
      expect(found.groupBlockedMemberCount).toBe(1);
    }
  });

  it('produces the same blocked presentation for a pending_verification member', async () => {
    const blocked = makeGroupMember({ state: 'pending_verification' });
    const sibling = makeGroupMember({ state: 'staged' });

    const res = await listMilestone();
    const found = res.body.intents.find(
      (i: { id: string }) => i.id === sibling.id,
    );
    expect(found.groupBlocked).toBe(true);
    expect(found.groupBlockedMemberCount).toBe(1);
    expect(res.body.intents.map((i: { id: string }) => i.id)).toContain(
      blocked.id,
    );
  });

  it('marks the group groupBlocked (via groupSessionIncomplete) when a live member is staged but its owning session has not signaled turn-complete, with no blocked-state member present', async () => {
    const emitter = new EventEmitter();
    const sessionManager = Object.assign(emitter, {
      getLiveSession: vi.fn().mockReturnValue({
        hasActiveTurn: () => true,
      }),
    }) as unknown as SessionManager & EventEmitter;
    insertSession({
      session_id: 'sess-turning',
      task_id: 'task:sess-turning',
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: 0,
      session_type: 'groom',
      task_name: null,
      metadata: null,
      review_result: null,
      pause_reason: null,
      last_error_detail: null,
      events_pruned_at: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      compaction_count: 0,
      context_occupancy_tokens: 0,
    } as never);
    const member = makeGroupMember({
      session_id: 'sess-turning',
      state: 'staged',
    });

    const res = await listMilestone(sessionManager);
    const found = res.body.intents.find(
      (i: { id: string }) => i.id === member.id,
    );
    expect(found.groupBlocked).toBe(true);
    expect(found.groupBlockedMemberCount).toBe(0);
    expect(found.groupSessionIncomplete).toBe(true);
  });

  it('reports groupBlocked: false for a group whose members are all live and complete', async () => {
    const member = makeGroupMember({ state: 'staged' });

    const res = await listMilestone();
    const found = res.body.intents.find(
      (i: { id: string }) => i.id === member.id,
    );
    expect(found.groupBlocked).toBe(false);
    expect(found.groupBlockedMemberCount).toBe(0);
  });
});

describe('live broadcast gated on the same decision-surface visibility rule REST applies', () => {
  const PROJECT_ID = 'proj-live-gate';

  let counter = 0;
  function makeRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
    counter += 1;
    const now = Date.now();
    const row: StagedIntentRow = {
      id: `live-gate-${counter}`,
      kind: 'task.updateBody',
      payload: JSON.stringify({ taskId: `task-${counter}` }),
      payload_hash: `hash-${counter}`,
      task_id: `task-${counter}`,
      project_id: PROJECT_ID,
      session_id: null,
      group_id: null,
      milestone: 'M1',
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
    insertStagedIntent(row);
    return row;
  }

  function makeSessionManager(hasActiveTurn: boolean) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      getLiveSession: vi
        .fn()
        .mockReturnValue({ hasActiveTurn: () => hasActiveTurn }),
    }) as unknown as SessionManager & EventEmitter;
  }

  function insertSessionWithStatus(sessionId: string, status: string): void {
    insertSession({
      session_id: sessionId,
      task_id: `task:${sessionId}`,
      task_url: null,
      project_context_url: null,
      status,
      started_at: 0,
      session_type: 'groom',
      task_name: null,
      metadata: null,
      review_result: null,
      pause_reason: null,
      last_error_detail: null,
      events_pruned_at: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      compaction_count: 0,
      context_occupancy_tokens: 0,
    } as never);
  }

  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    db.prepare('DELETE FROM milestones').run();
    db.prepare('DELETE FROM projects').run();
    counter = 0;
    insertProjectWithMilestone(PROJECT_ID, 'M1');
  });

  it('does not broadcast an auto-rejected needs_revision intent while its owning session is still live', () => {
    const sessionManager = makeSessionManager(false);
    createStagedIntentsRouter(undefined, sessionManager);
    insertSessionWithStatus('sess-livegate-1', 'running');
    const row = makeRow({
      session_id: 'sess-livegate-1',
      state: 'needs_revision',
      annotation: JSON.stringify({ autoRejected: true }),
    });

    const broadcasts: ServerMessage[] = [];
    setStagedIntentBroadcast((msg) => broadcasts.push(msg));
    broadcastIntentById(row.id);

    expect(broadcasts).toHaveLength(0);
  });

  it('broadcasts the same auto-rejected needs_revision intent once its owning session reaches a terminal status', () => {
    const sessionManager = makeSessionManager(false);
    createStagedIntentsRouter(undefined, sessionManager);
    insertSessionWithStatus('sess-livegate-done', 'done');
    const row = makeRow({
      session_id: 'sess-livegate-done',
      state: 'needs_revision',
      annotation: JSON.stringify({ autoRejected: true }),
    });

    const broadcasts: ServerMessage[] = [];
    setStagedIntentBroadcast((msg) => broadcasts.push(msg));
    broadcastIntentById(row.id);

    expect(broadcasts).toHaveLength(1);
    expect(
      (
        broadcasts[0] as Extract<
          ServerMessage,
          { type: 'staged_intent_changed' }
        >
      ).intent.id,
    ).toBe(row.id);
  });

  it('does not broadcast a session.requestCapability intent from a session with an in-flight turn (regression — already correct via sessionComplete)', () => {
    const sessionManager = makeSessionManager(true);
    createStagedIntentsRouter(undefined, sessionManager);
    insertSessionWithStatus('sess-livegate-turning', 'running');
    const row = makeRow({
      kind: 'session.requestCapability',
      session_id: 'sess-livegate-turning',
      payload: JSON.stringify({ capability: 'bash:ls' }),
    });

    const broadcasts: ServerMessage[] = [];
    setStagedIntentBroadcast((msg) => broadcasts.push(msg));
    broadcastIntentById(row.id);

    expect(broadcasts).toHaveLength(0);
  });

  it('after a live broadcast, the panel contents match what the REST route returns for the same scope', async () => {
    const sessionManager = makeSessionManager(false);
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter(undefined, sessionManager));

    insertSessionWithStatus('sess-livegate-2', 'running');
    const visible = makeRow({ state: 'staged' });
    const hidden = makeRow({
      session_id: 'sess-livegate-2',
      state: 'needs_revision',
      annotation: JSON.stringify({ autoRejected: true }),
    });

    const broadcasts: ServerMessage[] = [];
    setStagedIntentBroadcast((msg) => broadcasts.push(msg));
    broadcastIntentById(visible.id);
    broadcastIntentById(hidden.id);

    const broadcastIds = broadcasts
      .filter(
        (m): m is Extract<ServerMessage, { type: 'staged_intent_changed' }> =>
          m.type === 'staged_intent_changed',
      )
      .map((m) => m.intent.id);
    expect(broadcastIds).toEqual([visible.id]);

    const res = await supertest(app)
      .get('/api/staged-intents')
      .query({ projectId: PROJECT_ID, milestone: 'M1' });
    const restIds = res.body.intents.map((i: { id: string }) => i.id);
    expect(restIds).toContain(visible.id);
    expect(restIds).not.toContain(hidden.id);
    expect(broadcastIds).toEqual(restIds);
  });
});

describe('rowToApi groupKind', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    vi.mocked(getTaskCache).mockReturnValue(undefined);
    setStagedIntentBroadcast(() => {});
  });

  function stageForSession(sessionId: string): StagedIntentRow {
    const now = Date.now();
    const row: StagedIntentRow = {
      id: `intent-groupkind-${sessionId}`,
      kind: 'task.updateBody',
      payload: JSON.stringify({ taskId: 'task-1' }),
      payload_hash: `hash-groupkind-${sessionId}`,
      task_id: 'task-1',
      project_id: 'proj-groupkind',
      session_id: sessionId,
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
    };
    insertStagedIntent(row);
    return row;
  }

  async function groupKindFor(sessionId: string): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter());
    const staged = stageForSession(sessionId);
    const res = await supertest(app)
      .get('/api/staged-intents')
      .query({ sessionId });
    const found = res.body.intents.find(
      (i: { id: string }) => i.id === staged.id,
    );
    return found.groupKind;
  }

  it('a groom session yields groupKind "groom"', async () => {
    insertSession({
      session_id: 'session-groupkind-groom',
      task_id: 'task-1',
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'groom',
    });
    expect(await groupKindFor('session-groupkind-groom')).toBe('groom');
  });

  it('an ops session whose task Type is Investigation yields groupKind "investigation"', async () => {
    insertSession({
      session_id: 'session-groupkind-ops-inv',
      task_id: 'task-1',
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'ops',
    });
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 'task-1',
      raw_json: JSON.stringify({ type: '🔎 Investigation' }),
      cached_at: 0,
    } as ReturnType<typeof getTaskCache>);
    expect(await groupKindFor('session-groupkind-ops-inv')).toBe(
      'investigation',
    );
  });

  it('an ops session whose task Type is not Investigation yields groupKind "other"', async () => {
    insertSession({
      session_id: 'session-groupkind-ops-other',
      task_id: 'task-1',
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'ops',
    });
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 'task-1',
      raw_json: JSON.stringify({ type: '🔧 Operational' }),
      cached_at: 0,
    } as ReturnType<typeof getTaskCache>);
    expect(await groupKindFor('session-groupkind-ops-other')).toBe('other');
  });

  it('a design session yields groupKind "other"', async () => {
    insertSession({
      session_id: 'session-groupkind-design',
      task_id: 'task-1',
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: 0,
      session_type: 'design',
    });
    expect(await groupKindFor('session-groupkind-design')).toBe('other');
  });

  it('a human-staged intent (no session) yields groupKind "other"', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createStagedIntentsRouter());
    const now = Date.now();
    const row: StagedIntentRow = {
      id: 'intent-groupkind-human',
      kind: 'task.updateBody',
      payload: JSON.stringify({ taskId: 'task-1' }),
      payload_hash: 'hash-groupkind-human',
      task_id: 'task-1',
      project_id: 'proj-groupkind',
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
    };
    insertStagedIntent(row);
    const res = await supertest(app)
      .get('/api/staged-intents')
      .query({ projectId: 'proj-groupkind' });
    const found = res.body.intents.find((i: { id: string }) => i.id === row.id);
    expect(found.groupKind).toBe('other');
  });
});
