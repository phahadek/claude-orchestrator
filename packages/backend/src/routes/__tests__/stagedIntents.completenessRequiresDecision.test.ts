/**
 * Tests for the other half of the …3012260f ordering invariant: a dispatched
 * design session cannot stage completeness.disposition for its own bound
 * task until at least one decision.pickOne has been staged for that task —
 * closing the hole where a session jumped straight from investigation to the
 * completeness critic with zero decisions ever surfaced to the operator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { stageIntent } from '../stagedIntents';
import { insertSession } from '../../db/queries';

const PROJECT_ID = 'proj-completeness-decision';
const TASK_ID = 'notion:design-task-decision-1';
const SESSION_ID = 'design-session-decision-1';

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
      questions: JSON.stringify({
        probed: ['unstated-premises'],
        questions: [],
      }),
      run_at: runAt,
    });
  return Number(result.lastInsertRowid);
}

function stageDisposition(sessionId = SESSION_ID) {
  return stageIntent(
    'completeness.disposition',
    {
      taskId: TASK_ID,
      rowId: insertRow('2026-08-01T00:00:00.000Z'),
      project: 'demo',
      milestone: 'M13',
      probed: ['unstated-premises'],
      questions: [],
      runAt: '2026-08-01T00:00:00.000Z',
    },
    PROJECT_ID,
    null,
    sessionId,
  );
}

function stageDecision(sessionId: string, prompt = 'Which approach?') {
  return stageIntent(
    'decision.pickOne',
    {
      taskId: TASK_ID,
      prompt,
      options: [{ label: 'A', description: 'Option A' }],
      allowFreeForm: false,
    },
    PROJECT_ID,
    null,
    sessionId,
    'Recommend option A.',
  );
}

beforeEach(() => {
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

describe('completeness.disposition requires a prior decision.pickOne on its bound task', () => {
  it('refuses staging with zero decisions ever staged for the task, naming the missing precondition', () => {
    expect(() => stageDisposition()).toThrow(
      /no decision\.pickOne has been staged for this task yet/,
    );
    expect(() => stageDisposition()).toThrow(
      /surface the open questions to the operator as decision\.pickOne intents first/,
    );
  });

  it('succeeds once a decision.pickOne exists for the bound task, staged by this same session', () => {
    stageDecision(SESSION_ID);
    expect(() => stageDisposition()).not.toThrow();
  });

  it('succeeds when the decision.pickOne was staged by a different, earlier session on the same task', () => {
    insertSession({
      session_id: 'design-session-decision-predecessor',
      task_id: TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: PROJECT_ID,
      status: 'done',
      started_at: 0,
      session_type: 'design',
    });
    stageDecision('design-session-decision-predecessor');

    expect(() => stageDisposition()).not.toThrow();
  });

  it('does not count a withdrawn decision.pickOne', () => {
    const decision = stageDecision(SESSION_ID);
    db.prepare(
      `UPDATE staged_intent SET state = 'withdrawn' WHERE id = @id`,
    ).run({ id: decision.id });

    expect(() => stageDisposition()).toThrow(
      /no decision\.pickOne has been staged for this task yet/,
    );
  });

  it('does not count a superseded decision.pickOne', () => {
    const decision = stageDecision(SESSION_ID);
    db.prepare(
      `UPDATE staged_intent SET state = 'superseded' WHERE id = @id`,
    ).run({ id: decision.id });

    expect(() => stageDisposition()).toThrow(
      /no decision\.pickOne has been staged for this task yet/,
    );
  });

  it('does not gate a human-staged intent with no originating session', () => {
    expect(() =>
      stageIntent(
        'completeness.disposition',
        {
          taskId: TASK_ID,
          rowId: insertRow('2026-08-01T00:00:00.000Z'),
          project: 'demo',
          milestone: 'M13',
          probed: ['unstated-premises'],
          questions: [],
          runAt: '2026-08-01T00:00:00.000Z',
        },
        PROJECT_ID,
        null,
        null,
      ),
    ).not.toThrow();
  });

  it('does not gate a non-design (e.g. groom) session', () => {
    db.prepare('DELETE FROM sessions').run();
    insertSession({
      session_id: 'groom-session-decision-1',
      task_id: TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: PROJECT_ID,
      status: 'running',
      started_at: 1,
      session_type: 'groom',
    });

    expect(() => stageDisposition('groom-session-decision-1')).not.toThrow();
  });
});
