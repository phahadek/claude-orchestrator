import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';

// Tests the task_cache.cached_status generated-column migration (schema.ts),
// which getTasksByStatusFromCache (queries.ts) now queries against instead
// of applying JSON_EXTRACT(raw_json, '$.status') to every row inside WHERE.
// Follows the shape of schema.migration.sessionsTaskIdNorm.test.ts.

function getTableSql(db: Database.Database, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? '';
}

function tableHasColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  return new RegExp(`\\b${column}\\b`).test(getTableSql(db, table));
}

function countCachedStatusColumns(db: Database.Database): number {
  const matches = getTableSql(db, 'task_cache').match(/\bcached_status\b/g);
  return matches ? matches.length : 0;
}

function countCachedStatusIndexes(db: Database.Database): number {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all() as Array<{ name: string }>;
  return rows.filter((r) => r.name === 'idx_task_cache_status').length;
}

function insertTaskCache(
  db: Database.Database,
  taskId: string,
  rawJson: string,
) {
  db.prepare(
    `INSERT INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
  ).run(taskId, Date.now(), rawJson);
}

describe('runMigrations() — task_cache.cached_status', () => {
  it('completes successfully against a fresh database whose task_cache table lacks cached_status', () => {
    const mem = new Database(':memory:');
    expect(() => runMigrations(mem)).not.toThrow();
    expect(tableHasColumn(mem, 'task_cache', 'cached_status')).toBe(true);
  });

  it('is idempotent — running twice leaves exactly one column and one index', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();
    expect(countCachedStatusColumns(mem)).toBe(1);
    expect(countCachedStatusIndexes(mem)).toBe(1);
  });

  it('mirrors JSON_EXTRACT(raw_json, "$.status")', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    insertTaskCache(
      mem,
      'notion:abc',
      JSON.stringify({ status: 'In Progress' }),
    );
    const row = mem
      .prepare(`SELECT cached_status FROM task_cache WHERE task_id = ?`)
      .get('notion:abc') as { cached_status: string };
    expect(row.cached_status).toBe('In Progress');
  });

  it('accepts a malformed-JSON raw_json write, resolving cached_status to NULL rather than raising "malformed JSON"', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    expect(() =>
      insertTaskCache(mem, 'notion:bad', '{not valid json'),
    ).not.toThrow();
    const row = mem
      .prepare(`SELECT cached_status FROM task_cache WHERE task_id = ?`)
      .get('notion:bad') as { cached_status: string | null };
    expect(row.cached_status).toBeNull();
  });

  it('propagates a non-duplicate-column ALTER failure and never runs the dependent CREATE INDEX', () => {
    const mem = new Database(':memory:');
    let indexAttempted = false;
    const failing: Database.Database = new Proxy(mem, {
      get(target, prop) {
        if (prop === 'exec') {
          return (sql: string) => {
            if (
              typeof sql === 'string' &&
              sql.includes('ADD COLUMN cached_status')
            ) {
              throw new Error('near "GENERATED": syntax error');
            }
            if (
              typeof sql === 'string' &&
              sql.includes('idx_task_cache_status')
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
    expect(countCachedStatusIndexes(mem)).toBe(0);
  });
});
