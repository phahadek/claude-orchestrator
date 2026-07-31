import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  hasActivePlanningSessionForTask,
  hasActiveSessionForTask,
} from '../db/queries';

let sessionCounter = 0;
const TASK_ID = '3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7';

function insertSession(opts: {
  taskId: string;
  status: string;
  sessionType: string;
  archived?: boolean;
}): void {
  sessionCounter += 1;
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type, archived)
     VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, ?, ?)`,
  ).run(
    `sess-${sessionCounter}`,
    opts.taskId,
    opts.status,
    Date.now() - 10 * 60 * 1000,
    opts.sessionType,
    opts.archived ? 1 : 0,
  );
}

describe('hasActivePlanningSessionForTask — archived filtering', () => {
  beforeEach(() => {
    sessionCounter = 0;
    db.prepare('DELETE FROM sessions').run();
  });

  it('does not report the task as active when the only planning session is archived and idle', () => {
    insertSession({
      taskId: TASK_ID,
      status: 'idle',
      sessionType: 'groom',
      archived: true,
    });
    expect(hasActivePlanningSessionForTask(TASK_ID, 'groom')).toBe(false);
  });

  it('still reports the task as active for a non-archived idle planning session', () => {
    insertSession({
      taskId: TASK_ID,
      status: 'idle',
      sessionType: 'groom',
      archived: false,
    });
    expect(hasActivePlanningSessionForTask(TASK_ID, 'groom')).toBe(true);
  });

  it('still reports the task as active for a live running planning session, alongside an archived idle one for the same task', () => {
    // A row can never be both archived and running — archiveAndEndSession
    // reaps any live subprocess as part of the same call. This models the
    // realistic scenario instead: an archived idle predecessor coexists
    // with a genuinely live running session for the same task, and the
    // live one must still block.
    insertSession({
      taskId: TASK_ID,
      status: 'idle',
      sessionType: 'groom',
      archived: true,
    });
    insertSession({
      taskId: TASK_ID,
      status: 'running',
      sessionType: 'groom',
      archived: false,
    });
    expect(hasActivePlanningSessionForTask(TASK_ID, 'groom')).toBe(true);
  });
});

describe('hasActiveSessionForTask — archived filtering', () => {
  beforeEach(() => {
    sessionCounter = 0;
    db.prepare('DELETE FROM sessions').run();
  });

  it('does not report the task as active when the only standard session is archived and idle', () => {
    insertSession({
      taskId: TASK_ID,
      status: 'idle',
      sessionType: 'standard',
      archived: true,
    });
    expect(hasActiveSessionForTask(TASK_ID)).toBe(false);
  });

  it('still reports the task as active for a non-archived idle standard session', () => {
    insertSession({
      taskId: TASK_ID,
      status: 'idle',
      sessionType: 'standard',
      archived: false,
    });
    expect(hasActiveSessionForTask(TASK_ID)).toBe(true);
  });

  it('still reports the task as active for a live running standard session, alongside an archived idle one for the same task', () => {
    insertSession({
      taskId: TASK_ID,
      status: 'idle',
      sessionType: 'standard',
      archived: true,
    });
    insertSession({
      taskId: TASK_ID,
      status: 'running',
      sessionType: 'standard',
      archived: false,
    });
    expect(hasActiveSessionForTask(TASK_ID)).toBe(true);
  });
});
