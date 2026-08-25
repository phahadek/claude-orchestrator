import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/schema.js';
import { insertRows } from '../../test/helpers/seedRows.js';

// ESM modules have no built-in __dirname; derive it from import.meta.url for
// the static-guard test's read of schema.ts below.
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

// Regression coverage for the 2026-08-24 outage: the baseline CREATE TABLE
// block's `CREATE UNIQUE INDEX idx_deploy_run_active_per_project_kind ON
// deploy_run(project, kind)` succeeded on a fresh database (where the
// baseline CREATE TABLE already declares `kind`), but threw
// `no such column: kind` on any pre-existing database — `kind` is only
// added there by the guarded `ALTER TABLE deploy_run ADD COLUMN kind`
// migration ~2,740 lines later. CREATE TABLE IF NOT EXISTS is a no-op
// against an existing table, so the early index statement ran before that
// ALTER ever had a chance to add the column, crash-looping the process on
// every boot. See schema.ts's deploy_run.kind migration for the fix.

function preMigrationDeployRunShape(db: Database.Database): void {
  db.exec(`
    CREATE TABLE deploy_run (
      run_id       TEXT    PRIMARY KEY,
      project      TEXT    NOT NULL,
      target_sha   TEXT    NOT NULL,
      current_step TEXT,
      status       TEXT    NOT NULL,
      started_at   TEXT    NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX idx_deploy_run_project_status ON deploy_run(project, status);
    CREATE UNIQUE INDEX idx_deploy_run_active_per_project
      ON deploy_run(project) WHERE status = 'running';
  `);
}

function realisticDeployRunRows(): Array<Record<string, unknown>> {
  return [
    {
      run_id: 'run-a1b2',
      project: 'dashboard',
      target_sha: 'abc123',
      current_step: 'deploy',
      status: 'completed',
      started_at: '2026-08-20T00:00:00Z',
      completed_at: '2026-08-20T00:05:00Z',
    },
    {
      run_id: 'run-c3d4',
      project: 'dashboard',
      target_sha: 'def456',
      current_step: null,
      status: 'completed',
      started_at: '2026-08-21T00:00:00Z',
      completed_at: '2026-08-21T00:05:00Z',
    },
  ];
}

function sqliteIndexExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
      )
      .get(name) !== undefined
  );
}

describe('populated-database migration fixture — deploy_run.kind', () => {
  it('completes runMigrations without throwing against a deploy_run table that predates the kind column', () => {
    const db = new Database(':memory:');
    preMigrationDeployRunShape(db);
    insertRows(db, 'deploy_run', realisticDeployRunRows());

    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM deploy_run').get() as {
          n: number;
        }
      ).n,
    ).toBe(2);

    expect(() => runMigrations(db)).not.toThrow();
  });

  it('backfills kind to the default for every pre-existing row', () => {
    const db = new Database(':memory:');
    preMigrationDeployRunShape(db);
    insertRows(db, 'deploy_run', realisticDeployRunRows());
    runMigrations(db);

    const rows = db
      .prepare('SELECT kind FROM deploy_run ORDER BY run_id')
      .all() as Array<{ kind: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe('deploy');
    }
  });

  it('creates idx_deploy_run_active_per_project_kind and drops the superseded idx_deploy_run_active_per_project', () => {
    const db = new Database(':memory:');
    preMigrationDeployRunShape(db);
    insertRows(db, 'deploy_run', realisticDeployRunRows());
    runMigrations(db);

    expect(
      sqliteIndexExists(db, 'idx_deploy_run_active_per_project_kind'),
    ).toBe(true);
    expect(sqliteIndexExists(db, 'idx_deploy_run_active_per_project')).toBe(
      false,
    );
  });

  it('produces the same deploy_run shape and final index set from a fresh database', () => {
    const db = new Database(':memory:');
    expect(() => runMigrations(db)).not.toThrow();

    expect(tableXinfoColumnNames(db, 'deploy_run')).toContain('kind');
    expect(
      sqliteIndexExists(db, 'idx_deploy_run_active_per_project_kind'),
    ).toBe(true);
    expect(sqliteIndexExists(db, 'idx_deploy_run_active_per_project')).toBe(
      false,
    );
  });

  it('is idempotent: running twice against the migrated database leaves one kind column and one active-per-project-kind index', () => {
    const db = new Database(':memory:');
    preMigrationDeployRunShape(db);
    insertRows(db, 'deploy_run', realisticDeployRunRows());

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    const kindColumnCount = tableXinfoColumnNames(db, 'deploy_run').filter(
      (name) => name === 'kind',
    ).length;
    expect(kindColumnCount).toBe(1);

    const indexCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_deploy_run_active_per_project_kind'`,
        )
        .get() as { n: number }
    ).n;
    expect(indexCount).toBe(1);
  });
});

// Durable guard against the whole defect class, not just this one column: no
// CREATE INDEX in the baseline schema block may reference a column that is
// absent from that same table's baseline CREATE TABLE definition (i.e. a
// column only a later ALTER TABLE adds). CREATE TABLE IF NOT EXISTS is a
// no-op against a pre-existing table, so any index in the baseline block
// that depends on a not-yet-added column throws on every non-fresh database.
describe('schema.ts static guard — no baseline index references a later-ALTER-only column', () => {
  it("every column referenced by a baseline CREATE INDEX exists in that table's baseline CREATE TABLE definition", () => {
    const schemaSource = fs.readFileSync(
      path.join(__dirname, '../db/schema.ts'),
      'utf8',
    );

    // The baseline block is the first `target.exec(\`...\`)` call in
    // runMigrations — every later migration step runs as its own
    // target.exec()/try-block outside it.
    const baselineMatch = schemaSource.match(
      /target\.exec\(`([\s\S]*?)\n\s*`\);/,
    );
    if (!baselineMatch) {
      throw new Error(
        'Could not locate the baseline target.exec block in schema.ts',
      );
    }
    const baseline = baselineMatch[1];

    const SQL_KEYWORDS = new Set([
      'FOREIGN',
      'PRIMARY',
      'UNIQUE',
      'CONSTRAINT',
      'CHECK',
    ]);

    const tableColumns = new Map<string, Set<string>>();
    const createTableRe =
      /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\);/g;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = createTableRe.exec(baseline))) {
      const [, tableName, body] = tableMatch;
      const columns = new Set<string>();
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim().replace(/,$/, '');
        if (!line) continue;
        const firstToken = line.split(/\s+/)[0].toUpperCase();
        if (SQL_KEYWORDS.has(firstToken)) continue;
        columns.add(line.split(/\s+/)[0]);
      }
      tableColumns.set(tableName, columns);
    }

    expect(tableColumns.size).toBeGreaterThan(0);

    const createIndexRe =
      /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON (\w+)\s*\(([^)]*)\)/g;
    let indexMatch: RegExpExecArray | null;
    let indexesChecked = 0;
    while ((indexMatch = createIndexRe.exec(baseline))) {
      const [, tableName, columnList] = indexMatch;
      const columns = tableColumns.get(tableName);
      if (!columns) continue; // index on a table not defined in this block
      indexesChecked += 1;
      for (const rawCol of columnList.split(',')) {
        // Strip an ORDER BY-style ASC/DESC suffix (e.g. "started_at DESC")
        // to isolate the bare column name.
        const col = rawCol.trim().split(/\s+/)[0];
        if (!col) continue;
        expect({
          table: tableName,
          column: col,
          exists: columns.has(col),
        }).toEqual({ table: tableName, column: col, exists: true });
      }
    }

    expect(indexesChecked).toBeGreaterThan(0);
  });
});
