/**
 * The completing intent for a 🔧 Operational task's ops_journal
 * (journal.setState -> "applied-pending-confirm") now carries a
 * reconciliation assertion the orchestrator evaluates automatically once the
 * intent applies — replacing the manual applied-pending-confirm -> resolved
 * confirmation that has never once been taken in production (task
 * 3b822f91-52f3-8180). AC covered here:
 *  - a passing assertion drives the journal to resolved with no operator
 *    action;
 *  - a failing assertion leaves the journal at applied-pending-confirm and
 *    stages an interrupting intent carrying the mismatch;
 *  - an Operational completing intent staged with no assertion is rejected
 *    at stage time, naming the missing assertion;
 *  - the full staged-proposal -> applied-pending-confirm -> resolved path is
 *    exercised end to end;
 *  - 🔎 Investigation closure (direct to resolved/blocked, no assertion) is
 *    unchanged;
 *  - an illegal transition is still rejected by isValidOpsTransition — the
 *    automatic path does not bypass ALLOWED_TRANSITIONS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockUpdateStatus, mockFetchTaskSummary } =
  vi.hoisted(() => ({
    mockGetTaskBackend: vi.fn(),
    mockUpdateStatus: vi.fn(async () => {}),
    mockFetchTaskSummary: vi.fn(async () => null as { status: string } | null),
  }));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../projects/ProjectService', () => ({
  ProjectService: {
    getById: () => ({
      id: 'proj-1',
      milestones: [{ id: 'ms-1', name: 'M1', canonicalShortId: 'M1' }],
    }),
  },
}));

import { db } from '../db/db';
import { createStagedIntentsRouter } from '../routes/stagedIntents';
import {
  upsertOpsJournalEntry,
  upsertTaskCache,
  insertSession,
  setSessionTerminalCompletionReason,
} from '../db/queries';
import { isValidOpsTransition, type OpsState } from '../ops/opsJournal';
import { DESIGN_DONE_STATUS } from '../orchestration/PlanningOrchestrator';

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

function seedTaskType(taskId: string, type: string) {
  upsertTaskCache(taskId, JSON.stringify({ type }));
}

function seedOpsSession(sessionId: string, taskId: string, reason: string) {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    project_id: 'proj-1',
    status: 'done',
    started_at: 0,
    ended_at: 0,
    session_type: 'ops',
  } as any);
  setSessionTerminalCompletionReason(sessionId, reason);
}

function journalRow(taskId: string): { state: string } {
  return db
    .prepare('SELECT state FROM ops_journal WHERE task_id = ?')
    .get(taskId) as { state: string };
}

function activeIntentsForTask(taskId: string) {
  return db
    .prepare(
      `SELECT * FROM staged_intent WHERE task_id = ? AND state IN ('staged', 'approved')`,
    )
    .all(taskId) as Array<{ id: string; kind: string; payload: string }>;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({
    type: 'notion',
    updateStatus: mockUpdateStatus,
    fetchTaskSummary: mockFetchTaskSummary,
  });
  mockUpdateStatus.mockClear();
  mockFetchTaskSummary.mockReset();
  mockFetchTaskSummary.mockResolvedValue(null);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM ops_journal').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM task_cache').run();
});

describe('journal.setState -> "applied-pending-confirm" requires a reconciliation assertion (🔧 Operational)', () => {
  it('rejects the completing intent at stage time when no assertion is supplied, naming the missing assertion', async () => {
    const app = buildApp();
    seedEntry('task-1', 'staged-proposal');
    seedTaskType('task-1', '🔧 Operational');

    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: { taskId: 'task-1', state: 'applied-pending-confirm' },
        projectId: 'proj-1',
        groupId: 'group-1',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('reconciliation');
    expect(activeIntentsForTask('task-1')).toHaveLength(0);
  });

  it('rejects an assertion missing a `passed` boolean', async () => {
    const app = buildApp();
    seedEntry('task-2', 'staged-proposal');
    seedTaskType('task-2', '🔧 Operational');

    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: {
          taskId: 'task-2',
          state: 'applied-pending-confirm',
          reconciliation: { description: 'config row re-read' },
        },
        projectId: 'proj-1',
        groupId: 'group-2',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('reconciliation');
  });

  it('stages successfully once a reconciliation assertion is supplied', async () => {
    const app = buildApp();
    seedEntry('task-3', 'staged-proposal');
    seedTaskType('task-3', '🔧 Operational');

    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: {
          taskId: 'task-3',
          state: 'applied-pending-confirm',
          reconciliation: { description: 'config row re-read', passed: true },
        },
        projectId: 'proj-1',
        groupId: 'group-3',
      });

    expect(res.status).toBe(201);
  });

  it('an uncached task Type is treated as Operational — reconciliation still required', async () => {
    const app = buildApp();
    seedEntry('task-4', 'staged-proposal');
    // No seedTaskType call — task Type is uncached.

    const res = await supertest(app)
      .post('/api/staged-intents')
      .send({
        kind: 'journal.setState',
        payload: { taskId: 'task-4', state: 'applied-pending-confirm' },
        projectId: 'proj-1',
        groupId: 'group-4',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('reconciliation');
  });
});

describe('automatic reconciliation once the Operational completing intent applies', () => {
  async function stageAndApplyCompletingIntent(
    taskId: string,
    reconciliation: { description: string; passed: boolean; mismatch?: string },
  ) {
    const app = buildApp();
    const agent = supertest(app);
    const groupId = `group-${taskId}`;
    const stageRes = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      payload: { taskId, state: 'applied-pending-confirm', reconciliation },
      projectId: 'proj-1',
      groupId,
    });
    expect(stageRes.status).toBe(201);

    await agent
      .post(`/api/staged-intents/${stageRes.body.id}/approve`)
      .send({});
    const applyRes = await agent
      .post(`/api/staged-intents/group/${groupId}/commit`)
      .send({});
    return { agent, stageRes, applyRes };
  }

  it('drives the journal to resolved automatically on a passing assertion — no operator action required', async () => {
    seedEntry('task-pass', 'staged-proposal');
    seedTaskType('task-pass', '🔧 Operational');
    seedOpsSession(
      'session-pass',
      'task-pass',
      'planning_no_pending_dispositions',
    );

    const { applyRes } = await stageAndApplyCompletingIntent('task-pass', {
      description: 'config row re-read and matches the intended value',
      passed: true,
    });

    expect(applyRes.status).toBe(200);
    expect(journalRow('task-pass').state).toBe('resolved');

    // No interrupting intent, and the deferred close fired — no further
    // operator action is required to reach the task's Done status.
    expect(activeIntentsForTask('task-pass')).toHaveLength(0);
    expect(mockUpdateStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'task-pass',
      DESIGN_DONE_STATUS,
      expect.objectContaining({ sessionId: 'session-pass' }),
    );
  });

  it('a failed assertion leaves the journal at applied-pending-confirm and stages an interrupting intent carrying the mismatch', async () => {
    seedEntry('task-fail', 'staged-proposal');
    seedTaskType('task-fail', '🔧 Operational');
    seedOpsSession(
      'session-fail',
      'task-fail',
      'planning_no_pending_dispositions',
    );

    const { applyRes } = await stageAndApplyCompletingIntent('task-fail', {
      description: 'config row re-read and matches the intended value',
      passed: false,
      mismatch: 'row still shows the pre-change value',
    });

    expect(applyRes.status).toBe(200);
    // The completing intent itself still applies (the journal reaches
    // applied-pending-confirm) — reconciliation is a follow-through step,
    // not a rejection of the completing intent.
    expect(journalRow('task-fail').state).toBe('applied-pending-confirm');

    const interrupting = activeIntentsForTask('task-fail');
    expect(interrupting).toHaveLength(1);
    expect(interrupting[0].kind).toBe('journal.setState');
    const payload = JSON.parse(interrupting[0].payload);
    expect(payload.state).toBe('blocked');
    expect(payload.fields.resolution.mismatch).toBe(
      'row still shows the pre-change value',
    );
    expect(payload.fields.resolution.passed).toBe(false);

    // The task is not closed — a failed reconciliation is exactly the case
    // that must still interrupt the operator.
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});

describe('the staged-proposal -> applied-pending-confirm -> resolved path, exercised end to end (🔧 Operational)', () => {
  it('closes an Operational task automatically once staged-proposal is confirmed and the assertion passes', async () => {
    const app = buildApp();
    const agent = supertest(app);
    seedEntry('task-e2e', 'staged-proposal');
    seedTaskType('task-e2e', '🔧 Operational');
    seedOpsSession(
      'session-e2e',
      'task-e2e',
      'planning_no_pending_dispositions',
    );

    expect(journalRow('task-e2e').state).toBe('staged-proposal');

    const stageRes = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      payload: {
        taskId: 'task-e2e',
        state: 'applied-pending-confirm',
        reconciliation: { description: 'backfill count matches', passed: true },
      },
      projectId: 'proj-1',
      groupId: 'group-e2e',
    });
    expect(stageRes.status).toBe(201);
    expect(journalRow('task-e2e').state).toBe('staged-proposal');

    await agent
      .post(`/api/staged-intents/${stageRes.body.id}/approve`)
      .send({});
    const applyRes = await agent
      .post('/api/staged-intents/group/group-e2e/commit')
      .send({});
    expect(applyRes.status).toBe(200);

    // The hop through applied-pending-confirm happened, and the automatic
    // reconciliation immediately carried it on to resolved — the operator
    // approved exactly one thing (the completing intent).
    expect(journalRow('task-e2e').state).toBe('resolved');
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      'task-e2e',
      DESIGN_DONE_STATUS,
      expect.objectContaining({ sessionId: 'session-e2e' }),
    );
  });
});

describe('🔎 Investigation closure is unchanged — resolved/blocked reachable directly, no assertion required', () => {
  it('stages and applies staged-proposal -> resolved with no reconciliation assertion', async () => {
    const app = buildApp();
    const agent = supertest(app);
    seedEntry('task-inv-1', 'staged-proposal');
    seedTaskType('task-inv-1', '🔎 Investigation');

    const stageRes = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      payload: { taskId: 'task-inv-1', state: 'resolved' },
      projectId: 'proj-1',
      groupId: 'group-inv-1',
    });
    expect(stageRes.status).toBe(201);

    await agent
      .post(`/api/staged-intents/${stageRes.body.id}/approve`)
      .send({});
    const applyRes = await agent
      .post('/api/staged-intents/group/group-inv-1/commit')
      .send({});
    expect(applyRes.status).toBe(200);
    expect(journalRow('task-inv-1').state).toBe('resolved');
  });

  it('stages and applies candidate -> blocked directly, no groupId or assertion required', async () => {
    const app = buildApp();
    const agent = supertest(app);
    seedEntry('task-inv-2', 'candidate');
    seedTaskType('task-inv-2', '🔎 Investigation');

    const stageRes = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      payload: { taskId: 'task-inv-2', state: 'blocked' },
      projectId: 'proj-1',
    });
    expect(stageRes.status).toBe(201);

    const applyRes = await agent
      .post(`/api/staged-intents/${stageRes.body.id}/apply`)
      .send({});
    expect(applyRes.status).toBe(200);
    expect(journalRow('task-inv-2').state).toBe('blocked');
  });
});

describe('an illegal transition is still rejected by isValidOpsTransition — the automatic path does not bypass ALLOWED_TRANSITIONS', () => {
  it('rejects pending -> resolved directly, for both an Operational and an Investigation task', async () => {
    expect(isValidOpsTransition('pending', 'resolved')).toBe(false);

    const app = buildApp();
    const agent = supertest(app);

    seedEntry('task-illegal-1', 'pending');
    seedTaskType('task-illegal-1', '🔧 Operational');
    const opRes = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      payload: { taskId: 'task-illegal-1', state: 'resolved' },
      projectId: 'proj-1',
      groupId: 'group-illegal-1',
    });
    expect(opRes.status).toBe(400);
    expect(opRes.body.error).toContain('"pending" -> "resolved"');
    expect(journalRow('task-illegal-1').state).toBe('pending');

    seedEntry('task-illegal-2', 'pending');
    seedTaskType('task-illegal-2', '🔎 Investigation');
    const invRes = await agent.post('/api/staged-intents').send({
      kind: 'journal.setState',
      payload: { taskId: 'task-illegal-2', state: 'resolved' },
      projectId: 'proj-1',
      groupId: 'group-illegal-2',
    });
    expect(invRes.status).toBe(400);
    expect(invRes.body.error).toContain('"pending" -> "resolved"');
    expect(journalRow('task-illegal-2').state).toBe('pending');
  });
});
