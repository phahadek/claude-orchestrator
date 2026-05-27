import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Tests the DELETE-then-UPDATE migration pattern for task_cache prefix backfill.
// This SQL runs inside runMigrations() at the source-prefix backfill block.

const MIGRATION_SQL = `
  DELETE FROM task_cache
  WHERE task_id NOT LIKE '%:%'
    AND EXISTS (SELECT 1 FROM task_cache t2 WHERE t2.task_id = 'notion:' || task_cache.task_id);

  DELETE FROM task_cache
  WHERE task_id NOT LIKE '%:%'
    AND EXISTS (SELECT 1 FROM task_cache t2 WHERE t2.task_id = 'yaml:' || task_cache.task_id);

  UPDATE task_cache
  SET task_id = 'notion:' || task_id
  WHERE task_id NOT LIKE '%:%';
`;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE task_cache (
      task_id    TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT NOT NULL
    )
  `);
  return db;
}

function runMigration(db: InstanceType<typeof Database>) {
  db.exec(MIGRATION_SQL);
}

function getIds(db: InstanceType<typeof Database>): string[] {
  return (
    db.prepare('SELECT task_id FROM task_cache ORDER BY task_id').all() as {
      task_id: string;
    }[]
  ).map((r) => r.task_id);
}

describe('task_cache migration — DELETE-then-UPDATE prefix backfill', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('fresh DB (no rows) — no-op, migration completes without error', () => {
    expect(() => runMigration(db)).not.toThrow();
    expect(getIds(db)).toHaveLength(0);
  });

  it('only raw rows — all get notion: prefix', () => {
    db.prepare("INSERT INTO task_cache VALUES ('abc123', 1, '{}')").run();
    db.prepare("INSERT INTO task_cache VALUES ('def456', 2, '{}')").run();
    runMigration(db);
    expect(getIds(db)).toEqual(['notion:abc123', 'notion:def456']);
  });

  it('only prefixed rows — no-op, rows unchanged', () => {
    db.prepare(
      "INSERT INTO task_cache VALUES ('notion:abc123', 1, '{}')",
    ).run();
    runMigration(db);
    expect(getIds(db)).toEqual(['notion:abc123']);
  });

  it('mixed raw + prefixed twin — raw row dropped, prefixed kept, no constraint violation', () => {
    db.prepare(
      "INSERT INTO task_cache VALUES ('abc123', 1, '{\"old\":true}')",
    ).run();
    db.prepare(
      "INSERT INTO task_cache VALUES ('notion:abc123', 2, '{\"new\":true}')",
    ).run();
    expect(() => runMigration(db)).not.toThrow();
    expect(getIds(db)).toEqual(['notion:abc123']);
    // Prefixed row survives unchanged
    const row = db
      .prepare(
        "SELECT raw_json FROM task_cache WHERE task_id = 'notion:abc123'",
      )
      .get() as { raw_json: string };
    expect(JSON.parse(row.raw_json)).toEqual({ new: true });
  });

  it('mixed: some have twins, some do not — twins dropped, orphan raws prefixed', () => {
    db.prepare(
      "INSERT INTO task_cache VALUES ('has-twin', 1, '{\"old\":true}')",
    ).run();
    db.prepare(
      "INSERT INTO task_cache VALUES ('notion:has-twin', 2, '{}')",
    ).run();
    db.prepare("INSERT INTO task_cache VALUES ('no-twin', 3, '{}')").run();
    runMigration(db);
    expect(getIds(db)).toEqual(['notion:has-twin', 'notion:no-twin']);
  });

  it('idempotent — running twice produces same result', () => {
    db.prepare("INSERT INTO task_cache VALUES ('abc123', 1, '{}')").run();
    runMigration(db);
    const afterFirst = getIds(db);
    runMigration(db);
    const afterSecond = getIds(db);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond).toEqual(['notion:abc123']);
  });

  it('yaml:-prefixed twin — raw row dropped, yaml: prefixed row kept, no constraint violation', () => {
    db.prepare(
      "INSERT INTO task_cache VALUES ('abc123', 1, '{\"old\":true}')",
    ).run();
    db.prepare(
      "INSERT INTO task_cache VALUES ('yaml:abc123', 2, '{\"new\":true}')",
    ).run();
    expect(() => runMigration(db)).not.toThrow();
    expect(getIds(db)).toEqual(['yaml:abc123']);
  });

  it('idempotent — running twice on mixed DB produces same result', () => {
    db.prepare("INSERT INTO task_cache VALUES ('raw-id', 1, '{}')").run();
    db.prepare(
      "INSERT INTO task_cache VALUES ('notion:raw-id', 2, '{}')",
    ).run();
    runMigration(db);
    const afterFirst = getIds(db);
    runMigration(db);
    expect(getIds(db)).toEqual(afterFirst);
  });
});
