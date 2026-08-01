/**
 * Tests for the audit_log.project_id historical backfill in schema.ts: rows
 * written before recordEvent (audit/AuditLog.ts) derived project_id from
 * actor_id/task_id are otherwise permanently invisible to any project-scoped
 * auditLog.query. This backfills them from the same rule, using the
 * sessions and task_repo_assignments tables as they stand at migration time.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  projectId: string | null,
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, status, started_at, project_id)
     VALUES (?, 'done', ?, ?)`,
  ).run(sessionId, Date.now(), projectId);
}

function insertTaskRepoAssignment(
  db: Database.Database,
  taskId: string,
  projectId: string,
): void {
  db.prepare(
    `INSERT INTO task_repo_assignments (task_id, project_id, repo, assigned_by, assigned_at)
     VALUES (?, ?, 'org/repo', 'system', ?)`,
  ).run(taskId, projectId, Date.now());
}

function insertAuditRow(
  db: Database.Database,
  overrides: {
    eventType: string;
    actorId?: string | null;
    taskId?: string | null;
    projectId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (ts, event_type, actor_type, actor_id, project_id, task_id, payload)
     VALUES (?, ?, 'system', ?, ?, ?, '{}')`,
  ).run(
    Date.now(),
    overrides.eventType,
    overrides.actorId ?? null,
    overrides.projectId ?? null,
    overrides.taskId ?? null,
  );
}

function getProjectId(
  db: Database.Database,
  eventType: string,
): string | null {
  const row = db
    .prepare('SELECT project_id FROM audit_log WHERE event_type = ?')
    .get(eventType) as { project_id: string | null };
  return row.project_id;
}

describe('audit_log.project_id historical backfill', () => {
  it('backfills from actor_id when the actor is a known session', () => {
    const db = freshDb();
    insertSession(db, 'sess-old', 'proj-backfill-actor');
    insertAuditRow(db, {
      eventType: 'session_marked_done_while_running',
      actorId: 'sess-old',
    });

    runMigrations(db);

    expect(getProjectId(db, 'session_marked_done_while_running')).toBe(
      'proj-backfill-actor',
    );
  });

  it('backfills from task_id via task_repo_assignments when the actor does not resolve', () => {
    const db = freshDb();
    insertTaskRepoAssignment(db, 'task-old', 'proj-backfill-task');
    insertAuditRow(db, {
      eventType: 'pipeline_stage_entered',
      taskId: 'task-old',
    });

    runMigrations(db);

    expect(getProjectId(db, 'pipeline_stage_entered')).toBe(
      'proj-backfill-task',
    );
  });

  it('leaves a row null when neither actor nor task resolves', () => {
    const db = freshDb();
    insertAuditRow(db, { eventType: 'process_boot' });

    runMigrations(db);

    expect(getProjectId(db, 'process_boot')).toBeNull();
  });

  it('never overwrites a project_id the row already carried', () => {
    const db = freshDb();
    insertSession(db, 'sess-other', 'proj-wrong');
    insertAuditRow(db, {
      eventType: 'session_errored',
      actorId: 'sess-other',
      projectId: 'proj-original',
    });

    runMigrations(db);

    expect(getProjectId(db, 'session_errored')).toBe('proj-original');
  });

  it('is idempotent on repeated runs', () => {
    const db = freshDb();
    insertSession(db, 'sess-idem', 'proj-idem');
    insertAuditRow(db, {
      eventType: 'session_marked_done_while_running',
      actorId: 'sess-idem',
    });

    runMigrations(db);
    runMigrations(db);
    runMigrations(db);

    expect(getProjectId(db, 'session_marked_done_while_running')).toBe(
      'proj-idem',
    );
  });
});
