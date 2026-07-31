import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { hasNonTerminalPlanningSessionForTask } from '../db/queries';

let sessionCounter = 0;

function insertSession(opts: {
  taskId: string | null;
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

describe('hasNonTerminalPlanningSessionForTask', () => {
  beforeEach(() => {
    sessionCounter = 0;
    db.prepare('DELETE FROM sessions').run();
  });

  it('returns true for a live ops session when the stored id is bare and the query id is notion:-prefixed', () => {
    insertSession({
      taskId: '3aa22f9152f381d08a7dc5cfe6b21df7',
      status: 'active',
      sessionType: 'ops',
    });
    expect(
      hasNonTerminalPlanningSessionForTask(
        'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      ),
    ).toBe(true);
  });

  it.each([
    ['bare, hyphenless', '3aa22f9152f381d08a7dc5cfe6b21df7'],
    ['bare, hyphenated', '3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7'],
    ['prefixed, hyphenless', 'notion:3aa22f9152f381d08a7dc5cfe6b21df7'],
    ['prefixed, hyphenated', 'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7'],
  ])(
    'matches every stored-form/query-form combination (query id form: %s)',
    (_label, queryId) => {
      const storedForms = [
        '3aa22f9152f381d08a7dc5cfe6b21df7',
        '3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
        'notion:3aa22f9152f381d08a7dc5cfe6b21df7',
        'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      ];
      for (const storedId of storedForms) {
        sessionCounter = 0;
        db.prepare('DELETE FROM sessions').run();
        insertSession({
          taskId: storedId,
          status: 'active',
          sessionType: 'groom',
        });
        expect(hasNonTerminalPlanningSessionForTask(queryId)).toBe(true);
      }
    },
  );

  it('returns false when there is genuinely no non-terminal planning session for the task', () => {
    insertSession({
      taskId: 'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      status: 'done',
      sessionType: 'ops',
    });
    insertSession({
      taskId: 'notion:other-task-id',
      status: 'active',
      sessionType: 'design',
    });
    expect(
      hasNonTerminalPlanningSessionForTask(
        'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      ),
    ).toBe(false);
  });

  it('returns false for an archived, idle (non-terminal) planning session — the operator archive signal', () => {
    insertSession({
      taskId: 'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      status: 'idle',
      sessionType: 'groom',
      archived: true,
    });
    expect(
      hasNonTerminalPlanningSessionForTask(
        'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      ),
    ).toBe(false);
  });

  it('returns true for a non-archived idle planning session — still blocks a second launch', () => {
    insertSession({
      taskId: 'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      status: 'idle',
      sessionType: 'groom',
      archived: false,
    });
    expect(
      hasNonTerminalPlanningSessionForTask(
        'notion:3aa22f91-52f3-81d0-8a7d-c5cfe6b21df7',
      ),
    ).toBe(true);
  });
});
