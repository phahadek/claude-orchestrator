/**
 * Stage-time validation of journal.setState transitions.
 *
 * AC: staging a journal.setState whose transition is illegal from the
 * journal's current state is rejected at stage time (before it ever reaches
 * the operator), naming the current state and the legal targets; a legal
 * transition still stages and applies unchanged; the stage-time check and
 * isValidOpsTransition cannot disagree (same underlying check); and a
 * transition that was legal at stage time but whose journal state changed
 * before apply still fails safely at apply (the apply-time check retained).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: () => ({
      id: 'proj-1',
      milestones: [{ id: 'ms-1', name: 'M1', canonicalShortId: 'M1' }],
    }),
  },
}));

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';
import { upsertOpsJournalEntry } from '../../db/queries';
import { isValidOpsTransition, type OpsState } from '../../ops/opsJournal';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function seedEntry(taskId: string, state: OpsState) {
  upsertOpsJournalEntry({
    task_id: taskId,
    project: 'proj-1',
    milestone: 'M1',
    state,
    disposition: null,
    worked_in: null,
    evidence: null,
    finding_or_proposal: null,
    falsification: null,
    filed_followons: null,
    needs_from_operator: null,
    resolution: null,
    updated_at: new Date(0).toISOString(),
  } as any);
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM ops_journal').run();
});

describe('POST /api/staged-intents — journal.setState stage-time transition gate', () => {
  it('rejects pending -> staged-proposal at stage time, naming the current state and legal targets', async () => {
    const app = buildApp();
    seedEntry('task-1', 'pending');

    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: { taskId: 'task-1', state: 'staged-proposal' },
        projectId: 'proj-1',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"pending" -> "staged-proposal"');
    expect(res.body.error).toContain('Current state is "pending"');
    expect(res.body.error).toContain('"candidate"');

    // Never staged — the intent never enters the decision surface.
    const rows = db.prepare('SELECT * FROM staged_intent').all();
    expect(rows).toHaveLength(0);
  });

  it('stages and applies pending -> candidate unchanged', async () => {
    const app = buildApp();
    seedEntry('task-2', 'pending');

    const stageRes = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: { taskId: 'task-2', state: 'candidate' },
        projectId: 'proj-1',
      });
    expect(stageRes.status).toBe(201);

    const applyRes = await supertest(app)
      .post(`/api/staged-intents/${stageRes.body.id}/apply`)
      .send({});
    expect(applyRes.status).toBe(200);

    const row = db
      .prepare('SELECT * FROM ops_journal WHERE task_id = ?')
      .get('task-2') as { state: string };
    expect(row.state).toBe('candidate');
  });

  it('shares one implementation with isValidOpsTransition — stage-time acceptance never disagrees with it', async () => {
    const app = buildApp();
    const pairs: Array<[OpsState, OpsState]> = [
      ['pending', 'candidate'],
      ['pending', 'staged-proposal'],
      ['candidate', 'staged-proposal'],
      ['candidate', 'resolved'],
      ['staged-proposal', 'applied-pending-confirm'],
      ['applied-pending-confirm', 'candidate'],
    ];

    for (const [from, to] of pairs) {
      const taskId = `task-pair-${from}-${to}`;
      seedEntry(taskId, from);

      // A transition to `resolved` closes the investigation and is an
      // ops-terminal member (see OPS_TERMINAL_KINDS in stagedIntents.ts) —
      // it now requires a groupId, orthogonal to the transition-legality
      // check this test exercises.
      const res = await supertest(app)
        .post('/api/staged-intents')
        .send({
          kind: 'journal.setState',
          payload: { taskId, state: to },
          projectId: 'proj-1',
          ...(to === 'resolved' ? { groupId: `group-${taskId}` } : {}),
        });

      const expectedLegal = isValidOpsTransition(from, to);
      expect(res.status === 201).toBe(expectedLegal);
    }
  });

  function activeJournalMirrors(taskId: string) {
    return db
      .prepare(
        `SELECT * FROM staged_intent WHERE task_id = ? AND kind = 'journal.setState' AND state IN ('staged', 'approved')`,
      )
      .all(taskId) as Array<{ id: string; payload: string }>;
  }

  it('mirrors onto the decision surface when an applied journal.setState intent lands on staged-proposal', async () => {
    const app = buildApp();
    seedEntry('task-mirror-1', 'candidate');

    const stageRes = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: {
          taskId: 'task-mirror-1',
          state: 'staged-proposal',
          fields: { findingOrProposal: { summary: 'root cause is X' } },
        },
        projectId: 'proj-1',
      });
    expect(stageRes.status).toBe(201);

    const applyRes = await supertest(app)
      .post(`/api/staged-intents/${stageRes.body.id}/apply`)
      .send({});
    expect(applyRes.status).toBe(200);

    const mirrors = activeJournalMirrors('task-mirror-1');
    expect(mirrors).toHaveLength(1);
    // The applied intent is now committed (excluded by the state filter
    // above) — this is a distinct, freshly-staged mirror.
    expect(mirrors[0].id).not.toBe(stageRes.body.id);
    expect(JSON.parse(mirrors[0].payload).fields.findingOrProposal).toEqual({
      summary: 'root cause is X',
    });
  });

  it('mirrors nothing when the applied transition lands on a non-staged-proposal state', async () => {
    const app = buildApp();
    seedEntry('task-mirror-2', 'pending');

    const stageRes = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: { taskId: 'task-mirror-2', state: 'candidate' },
        projectId: 'proj-1',
      });
    expect(stageRes.status).toBe(201);

    await supertest(app)
      .post(`/api/staged-intents/${stageRes.body.id}/apply`)
      .send({});

    expect(activeJournalMirrors('task-mirror-2')).toHaveLength(0);
  });

  it('does not produce a second decision when both the HTTP route and the intent path mirror the same entry', async () => {
    const { createOpsJournalRouter } = await import('../opsJournal');
    const app = buildApp();
    app.use('/api', createOpsJournalRouter());
    seedEntry('task-mirror-3', 'candidate');

    const stageRes = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: { taskId: 'task-mirror-3', state: 'staged-proposal' },
        projectId: 'proj-1',
      });
    await supertest(app)
      .post(`/api/staged-intents/${stageRes.body.id}/apply`)
      .send({});

    // The same session also stages+applies its own journal.setState, and a
    // dispatched session's ops write can also drive the HTTP route.
    const res = await supertest(app)
      .post('/api/ops-journal/task-mirror-3/state')
      .send({ state: 'staged-proposal' });
    expect(res.status).toBe(200);

    expect(activeJournalMirrors('task-mirror-3')).toHaveLength(1);
  });

  it('fails safely at apply when the journal state changed after a legal stage — apply-time check retained', async () => {
    const app = buildApp();
    seedEntry('task-3', 'pending');

    const stageRes = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: { taskId: 'task-3', state: 'candidate' },
        projectId: 'proj-1',
      });
    expect(stageRes.status).toBe(201);

    // The journal moves on (e.g. a sibling intent resolves it first) before
    // this one is applied — the stage-time check cannot have seen this, and
    // `resolved` is terminal, so candidate is no longer a legal target.
    db.prepare('UPDATE ops_journal SET state = ? WHERE task_id = ?').run(
      'resolved',
      'task-3',
    );

    const applyRes = await supertest(app)
      .post(`/api/staged-intents/${stageRes.body.id}/apply`)
      .send({});
    expect(applyRes.status).not.toBe(200);

    const row = db
      .prepare('SELECT * FROM ops_journal WHERE task_id = ?')
      .get('task-3') as { state: string };
    expect(row.state).toBe('resolved');
  });
});
