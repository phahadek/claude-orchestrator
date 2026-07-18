import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Tests the gate_item_source.source_task_id prefix backfill. This SQL runs
// inside runMigrations() and fixes the raw-vs-prefixed id mismatch that left
// every min_deployed_commit null (accretion/backfill wrote raw Notion ids;
// merge_completed's notion_task_id is always the prefixed canonical form).

const MIGRATION_SQL = `
  UPDATE gate_item_source
  SET source_task_id = 'notion:' || source_task_id
  WHERE source_task_id NOT LIKE '%:%';
`;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE gate_item_source (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_item_id      TEXT    NOT NULL,
      source_task_id    TEXT    NOT NULL,
      source_task_title TEXT    NOT NULL,
      merge_commit      TEXT,
      added_at          TEXT    NOT NULL
    )
  `);
  return db;
}

function runMigration(db: InstanceType<typeof Database>) {
  db.exec(MIGRATION_SQL);
}

function getSourceTaskIds(db: InstanceType<typeof Database>): string[] {
  return (
    db
      .prepare('SELECT source_task_id FROM gate_item_source ORDER BY id')
      .all() as { source_task_id: string }[]
  ).map((r) => r.source_task_id);
}

describe('gate_item_source migration — source_task_id prefix backfill', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('fresh DB (no rows) — no-op, migration completes without error', () => {
    expect(() => runMigration(db)).not.toThrow();
    expect(getSourceTaskIds(db)).toHaveLength(0);
  });

  it('raw rows get the notion: prefix', () => {
    db.prepare(
      `INSERT INTO gate_item_source (gate_item_id, source_task_id, source_task_title, added_at)
       VALUES ('gi-1', 'abc123', 'Task A', '2026-01-01')`,
    ).run();
    runMigration(db);
    expect(getSourceTaskIds(db)).toEqual(['notion:abc123']);
  });

  it('already-prefixed rows are left unchanged', () => {
    db.prepare(
      `INSERT INTO gate_item_source (gate_item_id, source_task_id, source_task_title, added_at)
       VALUES ('gi-1', 'notion:abc123', 'Task A', '2026-01-01')`,
    ).run();
    runMigration(db);
    expect(getSourceTaskIds(db)).toEqual(['notion:abc123']);
  });

  it('mixed raw + prefixed rows for distinct sources — each fixed independently', () => {
    db.prepare(
      `INSERT INTO gate_item_source (gate_item_id, source_task_id, source_task_title, added_at)
       VALUES ('gi-1', 'raw-1', 'Task A', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO gate_item_source (gate_item_id, source_task_id, source_task_title, added_at)
       VALUES ('gi-2', 'notion:raw-2', 'Task B', '2026-01-01')`,
    ).run();
    runMigration(db);
    expect(getSourceTaskIds(db)).toEqual(['notion:raw-1', 'notion:raw-2']);
  });

  it('idempotent — running twice produces the same result', () => {
    db.prepare(
      `INSERT INTO gate_item_source (gate_item_id, source_task_id, source_task_title, added_at)
       VALUES ('gi-1', 'raw-1', 'Task A', '2026-01-01')`,
    ).run();
    runMigration(db);
    const afterFirst = getSourceTaskIds(db);
    runMigration(db);
    expect(getSourceTaskIds(db)).toEqual(afterFirst);
  });
});
