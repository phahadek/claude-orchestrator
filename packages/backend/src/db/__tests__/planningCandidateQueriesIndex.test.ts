/**
 * Regression coverage for the three sibling call sites in
 * DispatchTriggerEvaluator's planning-candidate predicate chain that carried
 * the same unindexed-JS-scan anti-pattern fixed for hasActiveSessionForTask
 * in hasActiveSessionForTaskIndex.test.ts (commit eef730c6):
 *
 *  - getActivePlanningSessionForTask (queries.ts) — now matches
 *    sessions.task_id_norm instead of a JS `.find()` over an unfiltered
 *    `SELECT *`.
 *  - isPlanningKillSuppressed (queries.ts) — now scopes its most-recent-
 *    session lookup to sessions.task_id_norm + LIMIT 1 instead of a JS
 *    `.find()` over every session ever run for the flow.
 *  - hasTaskEditSinceTimestamp (audit/AuditLog.ts) — now matches
 *    audit_log.task_id_norm instead of a JS `.some()` over every
 *    body/deps-edit audit row account-wide since a timestamp.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db';
import {
  getActivePlanningSessionForTask,
  isPlanningKillSuppressed,
} from '../queries';
import { hasTaskEditSinceTimestamp, recordEvent } from '../../audit/AuditLog';

let sessionCounter = 0;

function insertSession(
  taskId: string,
  sessionType: string,
  status: string,
  startedAt: number,
): string {
  sessionCounter += 1;
  const sessionId = `sess-${sessionCounter}`;
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type, archived)
     VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, ?, 0)`,
  ).run(sessionId, taskId, status, startedAt, sessionType);
  return sessionId;
}

describe('planning-candidate predicate chain — indexable task_id_norm matches', () => {
  beforeEach(() => {
    sessionCounter = 0;
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM audit_log').run();
  });

  describe('getActivePlanningSessionForTask', () => {
    it('matches ignoring hyphen formatting', () => {
      insertSession('ab-cd-1234', 'groom', 'running', 1000);
      expect(getActivePlanningSessionForTask('abcd1234', 'groom')?.task_id).toBe(
        'ab-cd-1234',
      );
      expect(
        getActivePlanningSessionForTask('ab-cd-1234', 'groom'),
      ).toBeDefined();
      expect(getActivePlanningSessionForTask('zz-zz-9999', 'groom')).toBeUndefined();
    });

    it('resolves via an index seek on task_id_norm, not a table scan', () => {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM sessions
           WHERE task_id_norm = @task_id_norm
             AND status NOT IN ('done')
             AND session_type = @flow
             AND archived = 0
           LIMIT 1`,
        )
        .all({ task_id_norm: 'abcd1234', flow: 'groom' }) as {
        detail: string;
      }[];
      const detail = plan.map((row) => row.detail).join(' | ');
      expect(detail).toContain('idx_sessions_task_id_norm');
      expect(detail).not.toMatch(/SCAN sessions\b(?!.*USING INDEX)/);
    });

    it('lookup cost does not grow with unrelated session row count', () => {
      for (let i = 0; i < 2000; i++) {
        insertSession(`unrelated-task-${i}`, 'groom', 'done', 1000 + i);
      }
      insertSession('needle-task-id', 'groom', 'running', 999999);

      const start = process.hrtime.bigint();
      for (let i = 0; i < 500; i++) {
        getActivePlanningSessionForTask('needle-task-id', 'groom');
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(elapsedMs).toBeLessThan(200);
    });
  });

  describe('isPlanningKillSuppressed', () => {
    it('true only for a most-recent session killed via user_kill with no edit since', () => {
      const sessionId = insertSession('ab-cd-1234', 'groom', 'killed', 1000);
      db.prepare('UPDATE sessions SET ended_at = ? WHERE session_id = ?').run(
        2000,
        sessionId,
      );
      recordEvent({
        event_type: 'session_errored',
        actor_type: 'session',
        actor_id: sessionId,
        task_id: null,
        payload: { reason: 'user_kill' },
      });
      expect(isPlanningKillSuppressed('ab-cd-1234', 'groom')).toBe(true);
      expect(isPlanningKillSuppressed('zz-zz-9999', 'groom')).toBe(false);
    });

    it('resolves the most-recent-session lookup via an index seek, not a table scan', () => {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM sessions
           WHERE task_id_norm = @task_id_norm AND session_type = @flow
           ORDER BY started_at DESC
           LIMIT 1`,
        )
        .all({ task_id_norm: 'abcd1234', flow: 'groom' }) as {
        detail: string;
      }[];
      const detail = plan.map((row) => row.detail).join(' | ');
      expect(detail).toContain('idx_sessions_task_id_norm');
      expect(detail).not.toMatch(/SCAN sessions\b(?!.*USING INDEX)/);
    });

    it('lookup cost does not grow with unrelated per-flow session history', () => {
      for (let i = 0; i < 2000; i++) {
        insertSession(`unrelated-task-${i}`, 'groom', 'done', 1000 + i);
      }
      insertSession('needle-task-id', 'groom', 'done', 999999);

      const start = process.hrtime.bigint();
      for (let i = 0; i < 500; i++) {
        isPlanningKillSuppressed('needle-task-id', 'groom');
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(elapsedMs).toBeLessThan(200);
    });
  });

  describe('hasTaskEditSinceTimestamp', () => {
    it('matches a source-prefixed, hyphenated audit_log.task_id ignoring case/hyphens/prefix', () => {
      recordEvent({
        event_type: 'task_body_updated',
        actor_type: 'session',
        actor_id: null,
        task_id: 'notion:AB-CD-1234',
        payload: {},
      });
      expect(hasTaskEditSinceTimestamp('abcd1234', 0)).toBe(true);
      expect(hasTaskEditSinceTimestamp('ab-cd-1234', 0)).toBe(true);
      expect(hasTaskEditSinceTimestamp('zz-zz-9999', 0)).toBe(false);
    });

    it('resolves via an index seek on task_id_norm, not a table scan', () => {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT task_id FROM audit_log
           WHERE task_id_norm = ?
             AND event_type IN ('task_body_updated', 'task_deps_updated')
             AND ts > ?
           LIMIT 1`,
        )
        .all('abcd1234', 0) as { detail: string }[];
      const detail = plan.map((row) => row.detail).join(' | ');
      expect(detail).toContain('idx_audit_log_task_id_norm_event_type');
      expect(detail).not.toMatch(/SCAN audit_log\b(?!.*USING INDEX)/);
    });

    it('lookup cost does not grow with unrelated account-wide audit row count', () => {
      for (let i = 0; i < 2000; i++) {
        recordEvent({
          event_type: 'task_body_updated',
          actor_type: 'session',
          actor_id: null,
          task_id: `notion:unrelated-task-${i}`,
          payload: {},
        });
      }
      recordEvent({
        event_type: 'task_body_updated',
        actor_type: 'session',
        actor_id: null,
        task_id: 'notion:needle-task-id',
        payload: {},
      });

      const start = process.hrtime.bigint();
      for (let i = 0; i < 500; i++) {
        hasTaskEditSinceTimestamp('needle-task-id', 0);
      }
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(elapsedMs).toBeLessThan(200);
    });
  });
});
