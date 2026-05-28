import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Tests for the one-shot double-prefix cleanup migration.
// Uses an isolated in-memory SQLite so the migration SQL can be verified
// independently of the full runMigrations() chain.

type TaskCacheRow = { task_id: string; raw_json: string };

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );
  `);
  return db;
}

function runCleanupMigration(db: Database.Database): void {
  db.exec(`
    DELETE FROM task_cache WHERE task_id LIKE 'notion:notion:%';

    UPDATE task_cache
    SET raw_json = REPLACE(raw_json, '"id":"notion:notion:', '"id":"notion:')
    WHERE task_id LIKE 'board:%' AND raw_json LIKE '%notion:notion:%';
  `);
}

const DOUBLE = 'notion:notion:36d22f91-0001-0001-0001-000000000001';
const SINGLE = 'notion:36d22f91-0001-0001-0001-000000000001';
const CLEAN = 'notion:36d22f91-0002-0002-0002-000000000002';

describe('task_cache double-prefix cleanup migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('deletes double-prefixed per-task rows', () => {
    db.prepare('INSERT INTO task_cache VALUES (?, ?, ?)').run(
      DOUBLE,
      Date.now(),
      `{"id":"${DOUBLE}"}`,
    );
    db.prepare('INSERT INTO task_cache VALUES (?, ?, ?)').run(
      CLEAN,
      Date.now(),
      `{"id":"${CLEAN}"}`,
    );

    runCleanupMigration(db);

    const rows = db
      .prepare('SELECT task_id FROM task_cache')
      .all() as TaskCacheRow[];
    const ids = rows.map((r) => r.task_id);
    expect(ids).not.toContain(DOUBLE);
    expect(ids).toContain(CLEAN);
  });

  it('repairs board-cache JSON with embedded double-prefixed IDs', () => {
    const raw = JSON.stringify([
      { id: DOUBLE, title: 'Task A' },
      { id: CLEAN, title: 'Task B' },
    ]);
    db.prepare('INSERT INTO task_cache VALUES (?, ?, ?)').run(
      'board:some-board',
      Date.now(),
      raw,
    );

    runCleanupMigration(db);

    const row = db
      .prepare('SELECT raw_json FROM task_cache WHERE task_id = ?')
      .get('board:some-board') as { raw_json: string };
    const tasks = JSON.parse(row.raw_json) as { id: string }[];
    const repaired = tasks.map((t) => t.id);
    expect(repaired).not.toContain(DOUBLE);
    expect(repaired).toContain(SINGLE);
    expect(repaired).toContain(CLEAN);
  });

  it('is idempotent — running migration twice has no additional effect', () => {
    db.prepare('INSERT INTO task_cache VALUES (?, ?, ?)').run(
      DOUBLE,
      Date.now(),
      `{"id":"${DOUBLE}"}`,
    );
    const boardRaw = JSON.stringify([{ id: DOUBLE, title: 'Task A' }]);
    db.prepare('INSERT INTO task_cache VALUES (?, ?, ?)').run(
      'board:some-board',
      Date.now(),
      boardRaw,
    );

    runCleanupMigration(db);
    const afterFirst = db
      .prepare('SELECT task_id, raw_json FROM task_cache ORDER BY task_id')
      .all();

    runCleanupMigration(db);
    const afterSecond = db
      .prepare('SELECT task_id, raw_json FROM task_cache ORDER BY task_id')
      .all();

    expect(afterSecond).toEqual(afterFirst);
  });

  it('does not touch clean single-prefixed rows', () => {
    db.prepare('INSERT INTO task_cache VALUES (?, ?, ?)').run(
      CLEAN,
      Date.now(),
      `{"id":"${CLEAN}"}`,
    );

    runCleanupMigration(db);

    const rows = db
      .prepare('SELECT task_id FROM task_cache')
      .all() as TaskCacheRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(CLEAN);
  });

  it('board-cache row without double-prefix is untouched', () => {
    const raw = JSON.stringify([{ id: CLEAN, title: 'Task B' }]);
    db.prepare('INSERT INTO task_cache VALUES (?, ?, ?)').run(
      'board:clean-board',
      Date.now(),
      raw,
    );

    runCleanupMigration(db);

    const row = db
      .prepare('SELECT raw_json FROM task_cache WHERE task_id = ?')
      .get('board:clean-board') as { raw_json: string };
    expect(row.raw_json).toBe(raw);
  });
});
