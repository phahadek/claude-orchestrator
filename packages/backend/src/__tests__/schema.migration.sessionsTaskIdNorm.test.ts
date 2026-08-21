import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';

// Tests the sessions.task_id_norm generated-column migration (schema.ts).
// SQLite rejects ALTER TABLE ADD COLUMN for STORED generated columns — only
// VIRTUAL may be added to an existing table — so the column must be VIRTUAL,
// and the dependent CREATE INDEX must never run against a column that a
// failed ALTER never created.

function getColumnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function countTaskIdNormColumns(db: Database.Database): number {
  const rows = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
    name: string;
  }>;
  return rows.filter((r) => r.name === 'task_id_norm').length;
}

function countTaskIdNormIndexes(db: Database.Database): number {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all() as Array<{ name: string }>;
  return rows.filter((r) => r.name === 'idx_sessions_task_id_norm').length;
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  taskId: string | null,
) {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at) VALUES (?, ?, 'active', 1)`,
  ).run(sessionId, taskId);
}

describe('runMigrations() — sessions.task_id_norm', () => {
  it('completes successfully against a fresh database whose sessions table lacks task_id_norm', () => {
    const mem = new Database(':memory:');
    expect(() => runMigrations(mem)).not.toThrow();
    const columns = getColumnNames(mem, 'sessions');
    expect(columns).toContain('task_id_norm');
  });

  it('is idempotent — running twice leaves exactly one column and one index', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();
    expect(countTaskIdNormColumns(mem)).toBe(1);
    expect(countTaskIdNormIndexes(mem)).toBe(1);
  });

  it('matches hasActiveSessionForTask normalization, including a NULL task_id', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);

    const cases: Array<[string, string | null]> = [
      ['s1', 'abc-123-XYZ'],
      ['s2', 'no-dashes-here'],
      ['s3', '---'],
      ['s4', ''],
      ['s5', null],
    ];
    for (const [sessionId, taskId] of cases) {
      insertSession(mem, sessionId, taskId);
    }

    const rows = mem
      .prepare(`SELECT session_id, task_id, task_id_norm FROM sessions`)
      .all() as Array<{
      session_id: string;
      task_id: string | null;
      task_id_norm: string;
    }>;

    for (const row of rows) {
      const expected = (row.task_id ?? '').replace(/-/g, '');
      expect(row.task_id_norm).toBe(expected);
    }
  });

  it("hasActiveSessionForTask's query uses the index rather than scanning sessions", () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    insertSession(mem, 's1', 'abc-123');

    const plan = mem
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT 1 FROM sessions
         WHERE task_id_norm = @task_id_norm
           AND status NOT IN ('done', 'archived')
           AND (session_type = 'standard' OR session_type IS NULL)
           AND archived = 0
         LIMIT 1`,
      )
      .all({ task_id_norm: 'abc123' }) as Array<{ detail: string }>;

    const details = plan.map((r) => r.detail).join('\n');
    expect(details).not.toMatch(/SCAN sessions\b/);
  });

  it('propagates a non-duplicate-column ALTER failure and never runs the dependent CREATE INDEX', () => {
    const mem = new Database(':memory:');
    let indexAttempted = false;
    const failing: Database.Database = new Proxy(mem, {
      get(target, prop, receiver) {
        if (prop === 'exec') {
          return (sql: string) => {
            if (
              typeof sql === 'string' &&
              sql.includes('ADD COLUMN task_id_norm')
            ) {
              throw new Error('near "GENERATED": syntax error');
            }
            if (
              typeof sql === 'string' &&
              sql.includes('idx_sessions_task_id_norm')
            ) {
              indexAttempted = true;
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    expect(() => runMigrations(failing)).toThrow(/GENERATED/);
    expect(indexAttempted).toBe(false);
    expect(countTaskIdNormIndexes(mem)).toBe(0);
  });
});
