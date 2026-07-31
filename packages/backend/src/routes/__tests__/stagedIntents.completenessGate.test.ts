/**
 * Tests for the completeness-critic approval gate on a Design task's
 * terminal artifacts: arch.createUnit/updateUnit/supersedeUnit and the
 * closing-synthesis task.updateBody must not stage until the session's
 * completeness.disposition intent for its own bound task is approved. AC
 * (task 3ab22f9152f381978922f6c4b52eee7b): the durable write still happens
 * immediately at critic time regardless of approval; a rejected intent can
 * be superseded by a freshly-staged one with no second critic run; approving
 * (or rejecting) the intent advances the underlying store rows off
 * `proposed`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

import { db } from '../../db/db';
import {
  createStagedIntentsRouter,
  stageIntent,
  sessionOwesGatedDesignArtifacts,
} from '../stagedIntents';
import { insertSession, listCompletenessDispositions } from '../../db/queries';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

const PROJECT_ID = 'proj-completeness';
const TASK_ID = 'notion:design-task-1';
const SESSION_ID = 'design-session-completeness-1';

const PROBED = ['unstated-premises'];
const QUESTIONS = [
  {
    question: 'Should X be configurable?',
    disposition: 'out-of-scope',
    reason: 'Out of scope.',
    approvalStatus: 'proposed',
  },
];

function stageDisposition(runAt = '2026-07-28T00:00:00.000Z') {
  return stageIntent(
    'completeness.disposition',
    {
      taskId: TASK_ID,
      rowId: insertRow(runAt),
      project: 'demo',
      milestone: 'M13',
      probed: PROBED,
      questions: QUESTIONS,
      runAt,
    },
    PROJECT_ID,
    null,
    SESSION_ID,
  );
}

function insertRow(runAt: string): number {
  const result = db
    .prepare(
      `INSERT INTO completeness_disposition (source_task_id, project, milestone, questions, run_at)
       VALUES (@source_task_id, @project, @milestone, @questions, @run_at)`,
    )
    .run({
      source_task_id: TASK_ID,
      project: 'demo',
      milestone: 'M13',
      questions: JSON.stringify({ probed: PROBED, questions: QUESTIONS }),
      run_at: runAt,
    });
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({ type: 'notion' });
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM completeness_disposition').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();

  insertSession({
    session_id: SESSION_ID,
    task_id: TASK_ID,
    task_url: null,
    project_context_url: null,
    project_id: PROJECT_ID,
    status: 'running',
    started_at: 1,
    session_type: 'design',
  });
});

describe('completeness-approval gate on design terminal artifacts', () => {
  it('blocks arch.createUnit at stage time, naming the missing approval, until the completeness.disposition intent is approved', () => {
    stageDisposition();

    expect(() =>
      stageIntent(
        'arch.createUnit',
        {
          title: 'A new unit',
          metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
          body: 'body',
        },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).toThrow(/completeness critic's dispositions.*have not been approved/);
  });

  it('blocks the closing-synthesis task.updateBody at stage time until approved', () => {
    stageDisposition();

    expect(() =>
      stageIntent(
        'task.updateBody',
        { taskId: TASK_ID, sections: { summary: 'x' } },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).toThrow(/completeness critic's dispositions.*have not been approved/);
  });

  it('blocks a follow-on task.create at stage time until approved (task …3012260f: task.create is a terminal artifact too)', () => {
    stageDisposition();

    expect(() =>
      stageIntent(
        'task.create',
        { databaseId: 'db-1', title: 'Follow-on task', type: '💻 Code' },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).toThrow(/completeness critic's dispositions.*have not been approved/);
  });

  it('allows a follow-on task.create once the intent is approved', async () => {
    const intent = stageDisposition();
    const app = makeApp();
    const agent = supertest(app);

    await agent.post(`/api/staged-intents/${intent.id}/approve`).send({});

    expect(() =>
      stageIntent(
        'task.create',
        { databaseId: 'db-1', title: 'Follow-on task', type: '💻 Code' },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).not.toThrow();
  });

  it('allows arch.createUnit and the closing-synthesis task.updateBody once the intent is approved, and advances the store rows off proposed', async () => {
    const intent = stageDisposition();
    const app = makeApp();
    const agent = supertest(app);

    const approved = await agent
      .post(`/api/staged-intents/${intent.id}/approve`)
      .send({});
    expect(approved.status).toBe(200);
    expect(approved.body.state).toBe('committed');

    expect(() =>
      stageIntent(
        'arch.createUnit',
        {
          title: 'A new unit',
          metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
          body: 'body',
        },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).not.toThrow();

    expect(() =>
      stageIntent(
        'task.updateBody',
        { taskId: TASK_ID, sections: { summary: 'x' } },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).not.toThrow();

    const rows = listCompletenessDispositions(TASK_ID);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].questions).questions[0].approvalStatus).toBe(
      'approved',
    );
  });

  it('rejecting the intent removes the underlying store row (no orphan), and a freshly-staged intent (no second critic run) still unblocks the gate once approved', async () => {
    const intent = stageDisposition();
    const app = makeApp();
    const agent = supertest(app);

    const rejected = await agent
      .post(`/api/staged-intents/${intent.id}/reject`)
      .send({ outcome: 'decline', reason: 'Needs another look.' });
    expect(rejected.status).toBe(200);

    const rowsAfterReject = listCompletenessDispositions(TASK_ID);
    expect(rowsAfterReject).toHaveLength(0);

    // The session is still able to re-stage a revised disposition — the
    // rejected intent is terminal and does not block a fresh one.
    const revised = stageDisposition('2026-07-29T00:00:00.000Z');
    expect(revised.id).not.toBe(intent.id);

    expect(() =>
      stageIntent(
        'arch.createUnit',
        {
          title: 'A new unit',
          metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
          body: 'body',
        },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).toThrow(/have not been approved/);

    await agent.post(`/api/staged-intents/${revised.id}/approve`).send({});

    expect(() =>
      stageIntent(
        'arch.createUnit',
        {
          title: 'A new unit',
          metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
          body: 'body',
        },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).not.toThrow();
  });

  it('does not gate a human-staged intent with no originating session', () => {
    expect(() =>
      stageIntent(
        'arch.createUnit',
        {
          title: 'A new unit',
          metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
          body: 'body',
        },
        PROJECT_ID,
        null,
        null,
      ),
    ).not.toThrow();
  });

  it('produces a distinct message when the session has a disposition keyed to a different task, vs. none at all', () => {
    // Baseline: no disposition staged at all.
    expect(() =>
      stageIntent(
        'arch.createUnit',
        {
          title: 'A new unit',
          metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
          body: 'body',
        },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).toThrow(/dispositions for this task have not been approved yet/);

    // A committed disposition exists, but it is durably keyed to a
    // different task than the session's own bound task — the shape a
    // mis-keyed completeness.disposition would have left behind before the
    // session/task binding check existed. Insert it directly, bypassing
    // stageIntent, since the binding check now prevents staging one.
    const otherTaskId = 'notion:some-other-task';
    const rowId = insertRow('2026-07-28T00:00:00.000Z');
    db.prepare(
      `INSERT INTO staged_intent (id, kind, payload, project_id, state, session_id, created_at, updated_at, payload_hash)
       VALUES (@id, 'completeness.disposition', @payload, @project_id, 'committed', @session_id, @created_at, @updated_at, @payload_hash)`,
    ).run({
      id: 'mismatched-disposition-1',
      payload: JSON.stringify({
        taskId: otherTaskId,
        rowId,
        project: 'demo',
        milestone: 'M13',
        probed: PROBED,
        questions: QUESTIONS,
        runAt: '2026-07-28T00:00:00.000Z',
      }),
      project_id: PROJECT_ID,
      session_id: SESSION_ID,
      created_at: 1,
      updated_at: 1,
      payload_hash: 'irrelevant-hash-1',
    });

    expect(() =>
      stageIntent(
        'arch.createUnit',
        {
          title: 'A new unit',
          metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
          body: 'body',
        },
        PROJECT_ID,
        null,
        SESSION_ID,
      ),
    ).toThrow(/committed completeness\.disposition, but it is keyed to task/);
  });

  it('does not gate a non-design (e.g. groom) session', () => {
    db.prepare('DELETE FROM sessions').run();
    insertSession({
      session_id: 'groom-session-1',
      task_id: TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: PROJECT_ID,
      status: 'running',
      started_at: 1,
      session_type: 'groom',
    });

    expect(() =>
      stageIntent(
        'task.updateBody',
        { taskId: TASK_ID, sections: { summary: 'x' } },
        PROJECT_ID,
        null,
        'groom-session-1',
      ),
    ).not.toThrow();
  });
});

// ── sessionOwesGatedDesignArtifacts — the "work owed" signal PlanningOrchestrator
// consults so an approval that unblocks arch.*/task.updateBody writes does not
// also terminate the session those writes are owed by ──────────────────────
describe('sessionOwesGatedDesignArtifacts', () => {
  it('is false before any completeness.disposition has been staged', () => {
    expect(sessionOwesGatedDesignArtifacts(SESSION_ID)).toBe(false);
  });

  it('is false while the disposition is only staged, not yet approved', () => {
    stageDisposition();
    expect(sessionOwesGatedDesignArtifacts(SESSION_ID)).toBe(false);
  });

  it('is true once the disposition is approved and no gated artifact has been staged yet — the deadlock this signal exists to prevent', async () => {
    const intent = stageDisposition();
    const app = makeApp();
    const agent = supertest(app);

    await agent.post(`/api/staged-intents/${intent.id}/approve`).send({});

    expect(sessionOwesGatedDesignArtifacts(SESSION_ID)).toBe(true);
  });

  it('flips false once an arch.createUnit has been staged (even before it is disposed), and the full flow — locked disposition, architecture unit, closing synthesis — settles as one sequence', async () => {
    const intent = stageDisposition();
    const app = makeApp();
    const agent = supertest(app);

    await agent.post(`/api/staged-intents/${intent.id}/approve`).send({});
    expect(sessionOwesGatedDesignArtifacts(SESSION_ID)).toBe(true);

    stageIntent(
      'arch.createUnit',
      {
        title: 'A new unit',
        metadata: { kind: 'invariant', topic: 't', regions: ['r'] },
        body: 'body',
      },
      PROJECT_ID,
      null,
      SESSION_ID,
    );
    expect(sessionOwesGatedDesignArtifacts(SESSION_ID)).toBe(false);

    stageIntent(
      'task.updateBody',
      { taskId: TASK_ID, sections: { summary: 'x' } },
      PROJECT_ID,
      null,
      SESSION_ID,
    );
    expect(sessionOwesGatedDesignArtifacts(SESSION_ID)).toBe(false);
  });

  it('is false for a non-design (e.g. groom) session even with an approved disposition', async () => {
    db.prepare('DELETE FROM sessions').run();
    insertSession({
      session_id: 'groom-session-owed-1',
      task_id: TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: PROJECT_ID,
      status: 'running',
      started_at: 1,
      session_type: 'groom',
    });

    const intent = stageIntent(
      'completeness.disposition',
      {
        taskId: TASK_ID,
        rowId: insertRow('2026-07-28T00:00:00.000Z'),
        project: 'demo',
        milestone: 'M13',
        probed: PROBED,
        questions: QUESTIONS,
        runAt: '2026-07-28T00:00:00.000Z',
      },
      PROJECT_ID,
      null,
      'groom-session-owed-1',
    );
    const app = makeApp();
    const agent = supertest(app);
    await agent.post(`/api/staged-intents/${intent.id}/approve`).send({});

    expect(sessionOwesGatedDesignArtifacts('groom-session-owed-1')).toBe(false);
  });

  it('is false when the session has no bound task', () => {
    db.prepare('DELETE FROM sessions').run();
    insertSession({
      session_id: 'design-session-no-task',
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: PROJECT_ID,
      status: 'running',
      started_at: 1,
      session_type: 'design',
    });

    expect(sessionOwesGatedDesignArtifacts('design-session-no-task')).toBe(
      false,
    );
  });
});
