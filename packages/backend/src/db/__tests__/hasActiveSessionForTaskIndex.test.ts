/**
 * Regression coverage for the sessions.task_id_norm generated column
 * (schema.ts) that hasActiveSessionForTask (queries.ts) now queries against
 * instead of applying REPLACE(COALESCE(task_id,''),'-','') to every row
 * inside WHERE. The REPLACE()-in-WHERE form defeated
 * idx_sessions_notion_task_id_session_type (indexed on raw task_id) and
 * forced a full scan of the sessions table per call — an N+1 loop from
 * DispatchTriggerEvaluator's planning-candidate predicates. See the "Fix
 * multi-second to 71-second GET / stalls" task.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db';
import {
  hasActiveSessionForTask,
  TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED,
} from '../queries';

let sessionCounter = 0;

function insertSession(taskId: string, status = 'running'): void {
  sessionCounter += 1;
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type, archived)
     VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, 'standard', 0)`,
  ).run(`sess-${sessionCounter}`, taskId, status, Date.now());
}

describe('sessions.task_id_norm — indexable normalized task_id match', () => {
  beforeEach(() => {
    sessionCounter = 0;
    db.prepare('DELETE FROM sessions').run();
  });

  it('is a STORED generated column mirroring REPLACE(task_id, "-", "")', () => {
    insertSession('ab-cd-1234');
    const row = db
      .prepare(`SELECT task_id_norm FROM sessions WHERE task_id = 'ab-cd-1234'`)
      .get() as { task_id_norm: string };
    expect(row.task_id_norm).toBe('abcd1234');
  });

  it('hasActiveSessionForTask still matches ignoring hyphen formatting', () => {
    insertSession('ab-cd-1234');
    expect(hasActiveSessionForTask('abcd1234')).toBe(true);
    expect(hasActiveSessionForTask('ab-cd-1234')).toBe(true);
    expect(hasActiveSessionForTask('zz-zz-9999')).toBe(false);
  });

  it('resolves the task_id_norm match via an index seek, not a full table scan', () => {
    const terminalList = [...TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED]
      .map((s) => `'${s}'`)
      .join(', ');
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT 1 FROM sessions INDEXED BY idx_sessions_task_id_norm
         WHERE task_id_norm = @task_id_norm
           AND status NOT IN (${terminalList})
           AND (session_type = 'standard' OR session_type IS NULL)
           AND archived = 0
         LIMIT 1`,
      )
      .all({ task_id_norm: 'abcd1234' }) as { detail: string }[];
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toContain('idx_sessions_task_id_norm');
    expect(detail).not.toMatch(/SCAN sessions\b(?!.*USING INDEX)/);
  });

  it('lookup cost does not grow with the number of unrelated session rows', () => {
    for (let i = 0; i < 2000; i++) {
      insertSession(`unrelated-task-${i}`, 'done');
    }
    insertSession('needle-task-id', 'running');

    const start = process.hrtime.bigint();
    for (let i = 0; i < 500; i++) {
      hasActiveSessionForTask('needle-task-id');
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // 500 indexed point lookups against a 2001-row table should be on the
    // order of a few ms, not the tens/hundreds of ms a full scan per call
    // would cost at this row count. Generous bound to avoid flakiness.
    expect(elapsedMs).toBeLessThan(200);
  });
});
