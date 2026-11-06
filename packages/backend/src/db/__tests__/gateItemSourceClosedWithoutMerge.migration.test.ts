import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema';

describe('gate_item_source.closed_without_merge_at migration', () => {
  it('adds the column to a pre-populated table and is a no-op when re-run', () => {
    const mem = new Database(':memory:');
    mem.exec(`
      CREATE TABLE gate_item (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, milestone TEXT NOT NULL,
        text TEXT NOT NULL, classification TEXT NOT NULL, min_deployed_commit TEXT,
        state TEXT NOT NULL, current_disposition TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE gate_item_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT, gate_item_id TEXT NOT NULL,
        source_task_id TEXT NOT NULL, source_task_title TEXT NOT NULL,
        merge_commit TEXT, added_at TEXT NOT NULL
      );
      INSERT INTO gate_item VALUES ('gi-1', 'p', 'M1', 't', 'blocking', NULL, 'open', NULL, 'x');
      INSERT INTO gate_item_source (gate_item_id, source_task_id, source_task_title, merge_commit, added_at)
        VALUES ('gi-1', 'notion:t1', 'T1', NULL, 'x'), ('gi-1', 'notion:t2', 'T2', 'abc', 'x');
    `);

    expect(() => runMigrations(mem)).not.toThrow();
    expect(() => runMigrations(mem)).not.toThrow();

    const cols = (
      mem.prepare(`PRAGMA table_info(gate_item_source)`).all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols.filter((c) => c === 'closed_without_merge_at')).toHaveLength(1);
    const rows = mem
      .prepare(
        `SELECT source_task_id, merge_commit, closed_without_merge_at FROM gate_item_source ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      {
        source_task_id: 'notion:t1',
        merge_commit: null,
        closed_without_merge_at: null,
      },
      {
        source_task_id: 'notion:t2',
        merge_commit: 'abc',
        closed_without_merge_at: null,
      },
    ]);
    mem.close();
  });
});
