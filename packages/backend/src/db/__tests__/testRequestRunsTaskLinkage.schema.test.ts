import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

describe('test_request_runs task_id / priority_group migration', () => {
  it('adds both columns to a populated table and is idempotent', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.exec(`ALTER TABLE test_request_runs DROP COLUMN task_id`);
    db.exec(`ALTER TABLE test_request_runs DROP COLUMN priority_group`);
    db.prepare(
      `INSERT INTO test_request_runs (id, project_id, content_hash, state, output, started_at)
       VALUES ('r1', 'p', 'h', 'passed', '', 1)`,
    ).run();

    runMigrations(db);
    runMigrations(db);

    const cols = (
      db.prepare(`PRAGMA table_info(test_request_runs)`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain('task_id');
    expect(cols).toContain('priority_group');
    const row = db
      .prepare(`SELECT task_id, priority_group FROM test_request_runs`)
      .get() as { task_id: string | null; priority_group: string | null };
    expect(row).toEqual({ task_id: null, priority_group: null });
    db.close();
  });
});
