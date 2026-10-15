import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { getPriorOpsSessionsForTask } from '../db/queries';

const TASK = '3fa22f91-52f3-8137-918a-fc1f4d5591d4';
let counter = 0;

function insertSession(
  id: string,
  taskId: string,
  startedAt: number,
  reason: string | null = 'resolved',
  sessionType = 'ops',
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type, terminal_completion_reason)
     VALUES (?, ?, 'u', 'c', 'done', ?, ?, ?)`,
  ).run(id, taskId, startedAt, sessionType, reason);
}

function insertIntent(
  sessionId: string,
  kind: string,
  payload: unknown,
  state = 'committed',
  appliedTaskId: string | null = null,
): void {
  counter += 1;
  db.prepare(
    `INSERT INTO staged_intent (id, kind, payload, payload_hash, task_id, project_id,
       session_id, state, applied_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'p1', ?, ?, ?, ?, ?)`,
  ).run(
    `si-${counter}`,
    kind,
    JSON.stringify(payload),
    `h${counter}`,
    TASK,
    sessionId,
    state,
    appliedTaskId,
    counter,
    counter,
  );
}

describe('getPriorOpsSessionsForTask', () => {
  beforeEach(() => {
    counter = 0;
    db.prepare('DELETE FROM staged_intent').run();
    db.prepare('DELETE FROM sessions').run();
  });

  it('returns the finding and created task of a committed prior session', () => {
    insertSession('s1', TASK, 1);
    insertIntent('s1', 'journal.setState', {
      taskId: TASK,
      state: 'resolved',
      fields: { findingOrProposal: 'the finding' },
    });
    insertIntent('s1', 'task.create', { title: 'Fix it' }, 'committed', 'new-1');
    const res = getPriorOpsSessionsForTask(TASK);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      sessionId: 's1',
      terminalCompletionReason: 'resolved',
      finalState: 'resolved',
      findingOrProposal: 'the finding',
      createdTasks: [{ title: 'Fix it', taskId: 'new-1' }],
    });
  });

  it('finds sessions stored under prefixed, hyphenated and bare task ids', () => {
    insertSession('a', `notion:${TASK}`, 3);
    insertSession('b', TASK, 2);
    insertSession('c', TASK.replace(/-/g, ''), 1);
    expect(getPriorOpsSessionsForTask(TASK).map((s) => s.sessionId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(
      getPriorOpsSessionsForTask(`notion:${TASK}`).map((s) => s.sessionId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('renders only committed intents', () => {
    insertSession('s1', TASK, 1);
    for (const state of ['withdrawn', 'rejected', 'superseded']) {
      insertIntent('s1', 'task.create', { title: `T-${state}` }, state);
    }
    insertIntent('s1', 'task.create', { title: 'kept' });
    expect(getPriorOpsSessionsForTask(TASK)[0].createdTasks).toEqual([
      { title: 'kept', taskId: null },
    ]);
  });

  it('excludes gate-verify and non-ops sessions, and caps at 3', () => {
    insertSession('g', `gate-item:${TASK}`, 10);
    insertSession('x', TASK, 9, 'done', 'standard');
    for (let i = 1; i <= 4; i++) insertSession(`o${i}`, TASK, i);
    const ids = getPriorOpsSessionsForTask(TASK).map((s) => s.sessionId);
    expect(ids).toEqual(['o4', 'o3', 'o2']);
  });

  it('returns nothing when there are no earlier ops sessions', () => {
    expect(getPriorOpsSessionsForTask(TASK)).toEqual([]);
  });
});
