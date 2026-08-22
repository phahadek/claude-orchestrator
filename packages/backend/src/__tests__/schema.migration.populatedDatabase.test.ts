import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/schema.js';
import { insertRows } from '../../test/helpers/seedRows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Every schema.migration.*.test.ts file up to this one runs runMigrations()
// against a freshly created, empty in-memory database (via setupTestDb or an
// ad hoc `new Database(':memory:')`). That is the one case production is
// never in, and it is the exact blind spot behind the 2026-08-21 outage: an
// `ALTER TABLE sessions ADD COLUMN task_id_norm ... GENERATED ALWAYS AS (...)
// STORED` migration passed cleanly against an empty test database, then
// threw against production's ~7,600-row sessions table, was swallowed by a
// bare `catch {}`, and crash-looped the backend on the unguarded dependent
// CREATE INDEX.
//
// This file establishes a populated-database path: build the pre-migration
// table shape by hand, seed realistic rows into it, and only then run the
// migration — so migration behaviour that depends on existing rows (this
// discriminator, backfills, NOT NULL/UNIQUE/CHECK additions, FK repointing)
// is actually exercised. See seedRows.ts for the shared insertRows() helper.

function preMigrationSessionsShape(db: Database.Database): void {
  db.exec(`
    CREATE TABLE sessions (
      session_id                TEXT    PRIMARY KEY,
      task_id                   TEXT,
      task_url                  TEXT,
      project_context_url       TEXT,
      status                    TEXT    NOT NULL,
      started_at                INTEGER NOT NULL,
      ended_at                  INTEGER,
      pr_url                    TEXT,
      worktree_path             TEXT,
      archived                  INTEGER NOT NULL DEFAULT 0,
      project_id                TEXT,
      session_type              TEXT    NOT NULL DEFAULT 'standard',
      favorited                 INTEGER NOT NULL DEFAULT 0,
      note                      TEXT,
      tags                      TEXT,
      metadata                  TEXT,
      total_input_tokens        INTEGER NOT NULL DEFAULT 0,
      total_output_tokens       INTEGER NOT NULL DEFAULT 0,
      context_occupancy_tokens  INTEGER NOT NULL DEFAULT 0,
      model                     TEXT,
      task_name                 TEXT,
      review_result             TEXT,
      compaction_count          INTEGER NOT NULL DEFAULT 0,
      effort                    TEXT,
      model_setting_key         TEXT,
      effort_setting_key        TEXT
    );
  `);
}

function realisticSessionRows(): Array<Record<string, unknown>> {
  return [
    {
      session_id: 'session-a1b2',
      task_id: 'abc-123-XYZ',
      status: 'active',
      started_at: 1_755_000_000,
      archived: 0,
      session_type: 'standard',
      favorited: 0,
      total_input_tokens: 4200,
      total_output_tokens: 900,
      context_occupancy_tokens: 5100,
      compaction_count: 0,
    },
    {
      session_id: 'session-c3d4',
      task_id: null,
      status: 'done',
      started_at: 1_755_000_500,
      ended_at: 1_755_001_200,
      archived: 1,
      session_type: 'standard',
      favorited: 1,
      total_input_tokens: 18000,
      total_output_tokens: 6100,
      context_occupancy_tokens: 24100,
      compaction_count: 2,
    },
  ];
}

const STORED_GENERATED_COLUMN_ALTER = `
  ALTER TABLE sessions ADD COLUMN task_id_norm TEXT
    GENERATED ALWAYS AS (REPLACE(COALESCE(task_id,''),'-','')) STORED
`;

function preMigrationAuditLogShape(db: Database.Database): void {
  db.exec(`
    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      event_type TEXT    NOT NULL,
      actor_type TEXT    NOT NULL,
      actor_id   TEXT,
      project_id TEXT,
      task_id    TEXT,
      payload    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_log_project_task ON audit_log(project_id, task_id);
  `);
}

function tableXinfoColumnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe('populated-database migration fixture', () => {
  it('seeds real rows into the pre-migration sessions shape before runMigrations executes', () => {
    const db = new Database(':memory:');
    preMigrationSessionsShape(db);
    insertRows(db, 'sessions', realisticSessionRows());

    // Guard: assert the fixture actually contains rows at the moment
    // migrations run — a fixture that silently degrades to empty would
    // defeat the entire point of this file.
    const countBeforeMigration = (
      db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;
    expect(countBeforeMigration).toBe(2);

    expect(() => runMigrations(db)).not.toThrow();

    const rows = db
      .prepare(
        'SELECT session_id, task_id, task_id_norm FROM sessions ORDER BY session_id',
      )
      .all() as Array<{
      session_id: string;
      task_id: string | null;
      task_id_norm: string;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.task_id_norm).toBe((row.task_id ?? '').replace(/-/g, ''));
    }
  });

  it('regression (2026-08-21 outage shape): a STORED generated-column ALTER succeeds against an empty sessions table but fails against a populated one', () => {
    const emptyDb = new Database(':memory:');
    preMigrationSessionsShape(emptyDb);
    expect(() => emptyDb.exec(STORED_GENERATED_COLUMN_ALTER)).not.toThrow();

    const populatedDb = new Database(':memory:');
    preMigrationSessionsShape(populatedDb);
    insertRows(populatedDb, 'sessions', realisticSessionRows());
    expect(
      (
        populatedDb.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {
          n: number;
        }
      ).n,
    ).toBeGreaterThan(0);

    expect(() => populatedDb.exec(STORED_GENERATED_COLUMN_ALTER)).toThrow();
  });
});

// Regression coverage for the 2026-08-21 audit_log outage: an
// `ALTER TABLE audit_log ADD COLUMN task_id_norm ... STORED` migration
// passed against an empty test database, then threw
// `no such column: task_id_norm` against a populated audit_log in
// production, because the dependent CREATE INDEX sat outside the try that
// swallowed the ALTER's failure. See schema.ts's audit_log.task_id_norm
// migration for the fix (VIRTUAL column, CREATE INDEX inside the same try,
// discriminating catch).
describe('populated-database migration fixture — audit_log.task_id_norm', () => {
  it('seeds a populated audit_log with a notion:-prefixed task_id and completes runMigrations without throwing', () => {
    const db = new Database(':memory:');
    preMigrationAuditLogShape(db);
    insertRows(db, 'audit_log', [
      {
        ts: 1_755_000_000,
        event_type: 'task_body_updated',
        actor_type: 'system',
        task_id: 'notion:3a322f91-52f3-81e9-bdfc-d1e8ce8c6d6d',
        payload: '{}',
      },
    ]);

    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as {
          n: number;
        }
      ).n,
    ).toBe(1);

    expect(() => runMigrations(db)).not.toThrow();
  });

  it('normalizes a notion:-prefixed task_id byte-for-byte matching normalizeBoardId', () => {
    const db = new Database(':memory:');
    preMigrationAuditLogShape(db);
    insertRows(db, 'audit_log', [
      {
        ts: 1_755_000_000,
        event_type: 'task_body_updated',
        actor_type: 'system',
        task_id: 'notion:3a322f91-52f3-81e9-bdfc-d1e8ce8c6d6d',
        payload: '{}',
      },
    ]);
    runMigrations(db);

    const row = db
      .prepare('SELECT task_id_norm FROM audit_log LIMIT 1')
      .get() as { task_id_norm: string };
    expect(row.task_id_norm).toBe('3a322f9152f381e9bdfcd1e8ce8c6d6d');
  });

  it('creates idx_audit_log_task_id_norm_event_type and the column is visible via PRAGMA table_xinfo (not table_info)', () => {
    const db = new Database(':memory:');
    preMigrationAuditLogShape(db);
    insertRows(db, 'audit_log', [
      {
        ts: 1_755_000_000,
        event_type: 'task_body_updated',
        actor_type: 'system',
        task_id: 'notion:3a322f91-52f3-81e9-bdfc-d1e8ce8c6d6d',
        payload: '{}',
      },
    ]);
    runMigrations(db);

    const index = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
      )
      .get('idx_audit_log_task_id_norm_event_type');
    expect(index).toBeDefined();

    expect(tableXinfoColumnNames(db, 'audit_log')).toContain('task_id_norm');
  });

  it('is idempotent against a populated audit_log that already has task_id_norm (the recovered-production case)', () => {
    const db = new Database(':memory:');
    preMigrationAuditLogShape(db);
    insertRows(db, 'audit_log', [
      {
        ts: 1_755_000_000,
        event_type: 'task_body_updated',
        actor_type: 'system',
        task_id: 'notion:3a322f91-52f3-81e9-bdfc-d1e8ce8c6d6d',
        payload: '{}',
      },
    ]);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    expect(tableXinfoColumnNames(db, 'audit_log')).toContain('task_id_norm');
  });
});

// Static guard against the third recurrence of this exact defect shape: a
// STORED generated column declared in an ALTER TABLE ADD COLUMN, which
// SQLite refuses on any table that already has rows. VIRTUAL is the only
// generated-column kind SQLite allows to be added to an existing table.
describe('schema.ts static guard — no STORED generated-column ALTER TABLE', () => {
  it('contains no ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS ... STORED declaration', () => {
    const schemaSource = fs.readFileSync(
      path.join(__dirname, '../db/schema.ts'),
      'utf8',
    );

    const alterAddColumnGeneratedStored =
      /ALTER TABLE[^`]*?ADD COLUMN[^`]*?GENERATED ALWAYS AS[^`]*?\)\s*STORED/gis;

    expect(schemaSource.match(alterAddColumnGeneratedStored)).toBeNull();
  });
});
