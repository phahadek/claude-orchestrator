import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Tests the dashless→dashed backfill migration in schema.ts.
// The SQL converts `notion:<32hex>` rows to `notion:<dashed-uuid>` form.

const DASHLESS = 'notion:36e22f9152f381018dd2f6f7c0b402e9';
const DASHED = 'notion:36e22f91-52f3-8101-8dd2-f6f7c0b402e9';

const MIGRATION_SQL = `
  UPDATE sessions
  SET task_id = 'notion:' ||
    SUBSTR(task_id, 8, 8) || '-' ||
    SUBSTR(task_id, 16, 4) || '-' ||
    SUBSTR(task_id, 20, 4) || '-' ||
    SUBSTR(task_id, 24, 4) || '-' ||
    SUBSTR(task_id, 28)
  WHERE task_id LIKE 'notion:%'
    AND LENGTH(task_id) = 39;

  UPDATE pull_requests
  SET task_id = 'notion:' ||
    SUBSTR(task_id, 8, 8) || '-' ||
    SUBSTR(task_id, 16, 4) || '-' ||
    SUBSTR(task_id, 20, 4) || '-' ||
    SUBSTR(task_id, 24, 4) || '-' ||
    SUBSTR(task_id, 28)
  WHERE task_id LIKE 'notion:%'
    AND LENGTH(task_id) = 39;

  UPDATE audit_log
  SET task_id = 'notion:' ||
    SUBSTR(task_id, 8, 8) || '-' ||
    SUBSTR(task_id, 16, 4) || '-' ||
    SUBSTR(task_id, 20, 4) || '-' ||
    SUBSTR(task_id, 24, 4) || '-' ||
    SUBSTR(task_id, 28)
  WHERE task_id LIKE 'notion:%'
    AND LENGTH(task_id) = 39;
`;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      task_id    TEXT,
      status     TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pull_requests (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_url   TEXT NOT NULL UNIQUE,
      pr_number INTEGER NOT NULL DEFAULT 1,
      repo     TEXT NOT NULL DEFAULT 'owner/repo',
      state    TEXT NOT NULL DEFAULT 'open',
      draft    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '2024-01-01',
      updated_at TEXT NOT NULL DEFAULT '2024-01-01',
      synced_at  TEXT NOT NULL DEFAULT '2024-01-01',
      review_iteration INTEGER NOT NULL DEFAULT 0,
      task_id  TEXT
    );
    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL DEFAULT 0,
      event_type TEXT NOT NULL DEFAULT 'test',
      actor_type TEXT NOT NULL DEFAULT 'ai',
      task_id    TEXT,
      payload    TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function runMigration(db: InstanceType<typeof Database>) {
  db.exec(MIGRATION_SQL);
}

function getSessionTaskIds(db: InstanceType<typeof Database>): string[] {
  return (
    db
      .prepare(
        'SELECT task_id FROM sessions WHERE task_id IS NOT NULL ORDER BY session_id',
      )
      .all() as { task_id: string }[]
  ).map((r) => r.task_id);
}

function getPRTaskIds(db: InstanceType<typeof Database>): string[] {
  return (
    db
      .prepare(
        'SELECT task_id FROM pull_requests WHERE task_id IS NOT NULL ORDER BY id',
      )
      .all() as { task_id: string }[]
  ).map((r) => r.task_id);
}

function getAuditTaskIds(db: InstanceType<typeof Database>): string[] {
  return (
    db
      .prepare(
        'SELECT task_id FROM audit_log WHERE task_id IS NOT NULL ORDER BY id',
      )
      .all() as { task_id: string }[]
  ).map((r) => r.task_id);
}

describe('dashless→dashed migration — sessions', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('converts dashless notion task_id to dashed form', () => {
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      's1',
      DASHLESS,
    );
    runMigration(db);
    expect(getSessionTaskIds(db)).toEqual([DASHED]);
  });

  it('leaves already-dashed rows unchanged', () => {
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      's2',
      DASHED,
    );
    runMigration(db);
    expect(getSessionTaskIds(db)).toEqual([DASHED]);
  });

  it('leaves non-notion task_ids unchanged', () => {
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      's3',
      'yaml:some-task-id',
    );
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      's4',
      'jira:PROJ-123',
    );
    runMigration(db);
    // Ordered by session_id: s3 before s4
    expect(getSessionTaskIds(db)).toEqual(['yaml:some-task-id', 'jira:PROJ-123']);
  });

  it('leaves NULL task_ids unchanged', () => {
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      's5',
      null,
    );
    runMigration(db);
    const rows = db
      .prepare('SELECT task_id FROM sessions WHERE session_id = ?')
      .all('s5') as { task_id: string | null }[];
    expect(rows[0].task_id).toBeNull();
  });

  it('is idempotent — running twice is a no-op the second time', () => {
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      's6',
      DASHLESS,
    );
    runMigration(db);
    const afterFirst = getSessionTaskIds(db);
    runMigration(db);
    expect(getSessionTaskIds(db)).toEqual(afterFirst);
    expect(getSessionTaskIds(db)).toEqual([DASHED]);
  });

  it('handles multiple sessions — only dashless ones are converted', () => {
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      'a',
      DASHLESS,
    );
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      'b',
      DASHED,
    );
    db.prepare('INSERT INTO sessions(session_id, task_id) VALUES(?,?)').run(
      'c',
      'yaml:something',
    );
    runMigration(db);
    expect(getSessionTaskIds(db)).toEqual([DASHED, DASHED, 'yaml:something']);
  });
});

describe('dashless→dashed migration — pull_requests', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('converts dashless PR task_id to dashed form', () => {
    db.prepare(
      'INSERT INTO pull_requests(pr_url, task_id) VALUES(?,?)',
    ).run('https://github.com/owner/repo/pull/1', DASHLESS);
    runMigration(db);
    expect(getPRTaskIds(db)).toEqual([DASHED]);
  });

  it('leaves already-dashed PR task_id unchanged', () => {
    db.prepare(
      'INSERT INTO pull_requests(pr_url, task_id) VALUES(?,?)',
    ).run('https://github.com/owner/repo/pull/2', DASHED);
    runMigration(db);
    expect(getPRTaskIds(db)).toEqual([DASHED]);
  });

  it('is idempotent for pull_requests', () => {
    db.prepare(
      'INSERT INTO pull_requests(pr_url, task_id) VALUES(?,?)',
    ).run('https://github.com/owner/repo/pull/3', DASHLESS);
    runMigration(db);
    runMigration(db);
    expect(getPRTaskIds(db)).toEqual([DASHED]);
  });
});

describe('dashless→dashed migration — audit_log', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('converts dashless audit_log task_id to dashed form', () => {
    db.prepare(
      'INSERT INTO audit_log(event_type, actor_type, task_id, payload) VALUES(?,?,?,?)',
    ).run('test', 'ai', DASHLESS, '{}');
    runMigration(db);
    expect(getAuditTaskIds(db)).toEqual([DASHED]);
  });

  it('leaves already-dashed audit_log task_id unchanged', () => {
    db.prepare(
      'INSERT INTO audit_log(event_type, actor_type, task_id, payload) VALUES(?,?,?,?)',
    ).run('test', 'ai', DASHED, '{}');
    runMigration(db);
    expect(getAuditTaskIds(db)).toEqual([DASHED]);
  });

  it('is idempotent for audit_log', () => {
    db.prepare(
      'INSERT INTO audit_log(event_type, actor_type, task_id, payload) VALUES(?,?,?,?)',
    ).run('test', 'ai', DASHLESS, '{}');
    runMigration(db);
    runMigration(db);
    expect(getAuditTaskIds(db)).toEqual([DASHED]);
  });
});
