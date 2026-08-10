/**
 * Stage-time enforcement that a design session's follow-on task.create always
 * carries a Priority: every design-filed follow-on sampled off the M14 board
 * landed with a blank Priority property (6 of 6) because nothing upstream of
 * the board rejected a payload with no priority key at all. Mirrors
 * assertCompletenessRequiresDecision's test shape; also satisfies the
 * pre-existing completeness-approval gate on task.create (task …3012260f)
 * the same way stagedIntents.completenessGate.test.ts does, so these tests
 * exercise only the new priority guard.
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
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';
import { insertSession } from '../../db/queries';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

const PROJECT_ID = 'proj-design-task-create-priority';
const TASK_ID = 'notion:design-task-priority-1';
const SESSION_ID = 'design-session-priority-1';

function insertDispositionRow(runAt: string): number {
  const result = db
    .prepare(
      `INSERT INTO completeness_disposition (source_task_id, project, milestone, questions, run_at)
       VALUES (@source_task_id, @project, @milestone, @questions, @run_at)`,
    )
    .run({
      source_task_id: TASK_ID,
      project: 'demo',
      milestone: 'M13',
      questions: JSON.stringify({ probed: ['unstated-premises'], questions: [] }),
      run_at: runAt,
    });
  return Number(result.lastInsertRowid);
}

/** Clears the pre-existing completeness-approval gate on task.create (task …3012260f) so only the priority guard is under test. */
async function approveCompletenessDisposition(): Promise<void> {
  stageIntent(
    'decision.pickOne',
    {
      taskId: TASK_ID,
      prompt: 'Which approach?',
      options: [{ label: 'A', description: 'Option A' }],
      allowFreeForm: false,
    },
    PROJECT_ID,
    null,
    SESSION_ID,
    'Recommend option A.',
  );
  const disposition = stageIntent(
    'completeness.disposition',
    {
      taskId: TASK_ID,
      rowId: insertDispositionRow('2026-08-01T00:00:00.000Z'),
      project: 'demo',
      milestone: 'M13',
      probed: ['unstated-premises'],
      questions: [],
      runAt: '2026-08-01T00:00:00.000Z',
    },
    PROJECT_ID,
    null,
    SESSION_ID,
  );
  const app = makeApp();
  const agent = supertest(app);
  await agent.post(`/api/staged-intents/${disposition.id}/approve`).send({});
}

function stageTaskCreate(
  payload: Record<string, unknown>,
  sessionId: string | null = SESSION_ID,
) {
  return stageIntent(
    'task.create',
    {
      databaseId: 'db-1',
      title: 'Follow-on Code task',
      type: '💻 Code',
      ...payload,
    },
    PROJECT_ID,
    null,
    sessionId,
    null,
  );
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

describe('task.create staged by a design session requires a priority', () => {
  it('rejects a payload with no priority key at all', async () => {
    await approveCompletenessDisposition();
    expect(() => stageTaskCreate({})).toThrow(
      /must carry a "priority" in its payload/,
    );
  });

  it('rejects a payload with an empty-string priority', async () => {
    await approveCompletenessDisposition();
    expect(() => stageTaskCreate({ priority: '' })).toThrow(
      /must carry a "priority" in its payload/,
    );
  });

  it('succeeds once a priority is set', async () => {
    await approveCompletenessDisposition();
    expect(() => stageTaskCreate({ priority: '🔴 High' })).not.toThrow();
  });

  it('does not gate a human-staged intent with no originating session', () => {
    expect(() => stageTaskCreate({}, null)).not.toThrow();
  });

  it('does not gate a non-design (e.g. groom) session', () => {
    db.prepare('DELETE FROM sessions').run();
    insertSession({
      session_id: 'groom-session-priority-1',
      task_id: TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: PROJECT_ID,
      status: 'running',
      started_at: 1,
      session_type: 'groom',
    });

    expect(() => stageTaskCreate({}, 'groom-session-priority-1')).not.toThrow();
  });
});
