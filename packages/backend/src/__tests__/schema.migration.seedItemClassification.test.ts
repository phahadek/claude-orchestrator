import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Tests the seed_item.classification guarded ALTER TABLE — a nullable
// column added after seed_item already existed in the wild, mirroring
// gate_item.classification's NOT NULL vocabulary but fail-open (optional)
// since existing seed_item rows predate the concept.

const MIGRATION_SQL = `ALTER TABLE seed_item ADD COLUMN classification TEXT`;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE seed_item (
      id                  TEXT    PRIMARY KEY,
      project             TEXT    NOT NULL,
      milestone           TEXT    NOT NULL,
      spec                TEXT    NOT NULL,
      min_deployed_commit TEXT,
      state               TEXT    NOT NULL,
      updated_at          TEXT    NOT NULL
    )
  `);
  return db;
}

function runMigration(db: InstanceType<typeof Database>) {
  try {
    db.exec(MIGRATION_SQL);
  } catch {
    /* already exists */
  }
}

describe('seed_item migration — classification column', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('fresh DB (no rows) — migration completes without error', () => {
    expect(() => runMigration(db)).not.toThrow();
  });

  it('existing rows survive with a NULL classification', () => {
    db.prepare(
      `INSERT INTO seed_item (id, project, milestone, spec, state, updated_at)
       VALUES ('s1', 'proj-1', 'M12', 'some spec', 'pending', '2026-01-01')`,
    ).run();

    runMigration(db);

    const row = db.prepare(`SELECT * FROM seed_item WHERE id = 's1'`).get() as {
      classification: string | null;
      spec: string;
      state: string;
    };
    expect(row.classification).toBeNull();
    expect(row.spec).toBe('some spec');
    expect(row.state).toBe('pending');
  });

  it('a fresh row can set classification after the migration', () => {
    runMigration(db);
    db.prepare(
      `INSERT INTO seed_item (id, project, milestone, spec, classification, state, updated_at)
       VALUES ('s2', 'proj-1', 'M12', 'another spec', 'in-pr', 'pending', '2026-01-01')`,
    ).run();

    const row = db
      .prepare(`SELECT classification FROM seed_item WHERE id = 's2'`)
      .get() as { classification: string | null };
    expect(row.classification).toBe('in-pr');
  });

  it('idempotent — running the guarded ALTER twice does not throw', () => {
    runMigration(db);
    expect(() => runMigration(db)).not.toThrow();
  });
});
