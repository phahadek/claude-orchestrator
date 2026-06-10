import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// The migration SQL extracted from runMigrations, tested in isolation.
// Each block recreates a child table with ON DELETE CASCADE and drops orphan rows.

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      status     TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE session_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT    NOT NULL,
      event_type TEXT    NOT NULL DEFAULT 'test',
      payload    TEXT    NOT NULL DEFAULT '{}',
      timestamp  INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL DEFAULT 'bash',
      proposed_action TEXT,
      decision        TEXT    NOT NULL DEFAULT 'allow',
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE permission_denials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL DEFAULT 'bash',
      tool_use_id TEXT    NOT NULL DEFAULT 'tu1',
      tool_input  TEXT    NOT NULL DEFAULT '{}',
      timestamp   INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE session_audits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      pr_opened     INTEGER NOT NULL DEFAULT 0,
      pr_targets    TEXT,
      task_status   TEXT,
      violations    TEXT NOT NULL DEFAULT '[]',
      spec_mismatch TEXT,
      audited_at    TEXT NOT NULL DEFAULT '2024-01-01'
    );

    CREATE TABLE session_pause_intervals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      pause_reason TEXT    NOT NULL DEFAULT 'test',
      paused_at    INTEGER NOT NULL DEFAULT 0,
      resumed_at   INTEGER NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE TABLE stuck_session_timers (
      session_id             TEXT    PRIMARY KEY,
      task_name              TEXT    NOT NULL DEFAULT 'task',
      notify_deadline        INTEGER NOT NULL DEFAULT 0,
      pause_deadline         INTEGER NOT NULL DEFAULT 0,
      hard_stop_deadline     INTEGER NOT NULL DEFAULT 0,
      hard_stop_armed        INTEGER NOT NULL DEFAULT 0,
      notify_remaining_ms    INTEGER,
      pause_remaining_ms     INTEGER,
      hard_stop_remaining_ms INTEGER
    );
  `);
  return db;
}

function runCascadeMigration(db: InstanceType<typeof Database>): void {
  type TableSqlRow = { sql: string };
  const getTableSql = (name: string): string =>
    (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(name) as TableSqlRow | undefined
    )?.sql ?? '';

  if (!getTableSql('session_events').includes('ON DELETE CASCADE')) {
    db.exec(`
      BEGIN TRANSACTION;
      DROP TABLE IF EXISTS session_events__new;
      CREATE TABLE session_events__new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        event_type   TEXT    NOT NULL,
        payload      TEXT    NOT NULL,
        timestamp    INTEGER NOT NULL,
        message_id   TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO session_events__new (id, session_id, event_type, payload, timestamp, message_id)
        SELECT id, session_id, event_type, payload, timestamp, message_id
        FROM session_events
        WHERE session_id IN (SELECT session_id FROM sessions);
      DROP TABLE session_events;
      ALTER TABLE session_events__new RENAME TO session_events;
      COMMIT;
    `);
  }

  if (!getTableSql('permission_events').includes('ON DELETE CASCADE')) {
    db.exec(`
      BEGIN TRANSACTION;
      DROP TABLE IF EXISTS permission_events__new;
      CREATE TABLE permission_events__new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT    NOT NULL,
        tool_name       TEXT    NOT NULL,
        proposed_action TEXT,
        decision        TEXT    NOT NULL,
        rule_matched    TEXT,
        decided_at      INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO permission_events__new (id, session_id, tool_name, proposed_action, decision, rule_matched, decided_at)
        SELECT id, session_id, tool_name, proposed_action, decision, rule_matched, decided_at
        FROM permission_events
        WHERE session_id IN (SELECT session_id FROM sessions);
      DROP TABLE permission_events;
      ALTER TABLE permission_events__new RENAME TO permission_events;
      COMMIT;
    `);
  }

  if (!getTableSql('permission_denials').includes('ON DELETE CASCADE')) {
    db.exec(`
      BEGIN TRANSACTION;
      DROP TABLE IF EXISTS permission_denials__new;
      CREATE TABLE permission_denials__new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        tool_name   TEXT    NOT NULL,
        tool_use_id TEXT    NOT NULL,
        tool_input  TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO permission_denials__new (id, session_id, tool_name, tool_use_id, tool_input, timestamp)
        SELECT id, session_id, tool_name, tool_use_id, tool_input, timestamp
        FROM permission_denials
        WHERE session_id IN (SELECT session_id FROM sessions);
      DROP TABLE permission_denials;
      ALTER TABLE permission_denials__new RENAME TO permission_denials;
      COMMIT;
    `);
  }

  if (!getTableSql('session_audits').includes('ON DELETE CASCADE')) {
    db.exec(`
      BEGIN TRANSACTION;
      DROP TABLE IF EXISTS session_audits__new;
      CREATE TABLE session_audits__new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        pr_opened     INTEGER NOT NULL DEFAULT 0,
        pr_targets    TEXT,
        task_status   TEXT,
        violations    TEXT NOT NULL DEFAULT '[]',
        spec_mismatch TEXT,
        audited_at    TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO session_audits__new (id, session_id, pr_opened, pr_targets, task_status, violations, spec_mismatch, audited_at)
        SELECT id, session_id, pr_opened, pr_targets, task_status, violations, spec_mismatch, audited_at
        FROM session_audits
        WHERE session_id IN (SELECT session_id FROM sessions);
      DROP TABLE session_audits;
      ALTER TABLE session_audits__new RENAME TO session_audits;
      COMMIT;
    `);
  }

  if (!getTableSql('session_pause_intervals').includes('ON DELETE CASCADE')) {
    db.exec(`
      BEGIN TRANSACTION;
      DROP TABLE IF EXISTS session_pause_intervals__new;
      CREATE TABLE session_pause_intervals__new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT    NOT NULL,
        pause_reason TEXT    NOT NULL,
        paused_at    INTEGER NOT NULL,
        resumed_at   INTEGER NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO session_pause_intervals__new (id, session_id, pause_reason, paused_at, resumed_at)
        SELECT id, session_id, pause_reason, paused_at, resumed_at
        FROM session_pause_intervals
        WHERE session_id IN (SELECT session_id FROM sessions);
      DROP TABLE session_pause_intervals;
      ALTER TABLE session_pause_intervals__new RENAME TO session_pause_intervals;
      COMMIT;
    `);
  }

  if (!getTableSql('stuck_session_timers').includes('ON DELETE CASCADE')) {
    db.exec(`
      BEGIN TRANSACTION;
      DROP TABLE IF EXISTS stuck_session_timers__new;
      CREATE TABLE stuck_session_timers__new (
        session_id             TEXT    PRIMARY KEY,
        task_name              TEXT    NOT NULL,
        notify_deadline        INTEGER NOT NULL DEFAULT 0,
        pause_deadline         INTEGER NOT NULL DEFAULT 0,
        hard_stop_deadline     INTEGER NOT NULL DEFAULT 0,
        hard_stop_armed        INTEGER NOT NULL DEFAULT 0,
        notify_remaining_ms    INTEGER,
        pause_remaining_ms     INTEGER,
        hard_stop_remaining_ms INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO stuck_session_timers__new
        (session_id, task_name, notify_deadline, pause_deadline, hard_stop_deadline,
         hard_stop_armed, notify_remaining_ms, pause_remaining_ms, hard_stop_remaining_ms)
        SELECT session_id, task_name, notify_deadline, pause_deadline, hard_stop_deadline,
               hard_stop_armed, notify_remaining_ms, pause_remaining_ms, hard_stop_remaining_ms
        FROM stuck_session_timers
        WHERE session_id IN (SELECT session_id FROM sessions);
      DROP TABLE stuck_session_timers;
      ALTER TABLE stuck_session_timers__new RENAME TO stuck_session_timers;
      COMMIT;
    `);
  }
}

function count(
  db: InstanceType<typeof Database>,
  table: string,
  sessionId: string,
): number {
  return (
    db
      .prepare(`SELECT COUNT(*) as n FROM ${table} WHERE session_id = ?`)
      .get(sessionId) as { n: number }
  ).n;
}

function insertSession(db: InstanceType<typeof Database>, id: string): void {
  db.prepare('INSERT INTO sessions (session_id) VALUES (?)').run(id);
}

describe('CASCADE migration — orphan cleanup during migration', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('drops orphan session_events rows during migration', () => {
    // Disable FK temporarily to insert orphan rows (pre-migration, no cascade yet)
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, 'x', '{}', 0)",
    ).run('orphan-1');
    db.pragma('foreign_keys = ON');

    runCascadeMigration(db);

    expect(count(db, 'session_events', 'orphan-1')).toBe(0);
  });

  it('preserves valid session_events rows during migration', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, 'x', '{}', 0)",
    ).run('s1');

    runCascadeMigration(db);

    expect(count(db, 'session_events', 's1')).toBe(1);
  });

  it('drops orphan session_audits rows during migration', () => {
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO session_audits (session_id, audited_at) VALUES (?, '2024-01-01')",
    ).run('orphan-2');
    db.pragma('foreign_keys = ON');

    runCascadeMigration(db);

    expect(count(db, 'session_audits', 'orphan-2')).toBe(0);
  });

  it('drops orphan session_pause_intervals rows during migration', () => {
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO session_pause_intervals (session_id, pause_reason, paused_at) VALUES (?, 'test', 0)",
    ).run('orphan-3');
    db.pragma('foreign_keys = ON');

    runCascadeMigration(db);

    expect(count(db, 'session_pause_intervals', 'orphan-3')).toBe(0);
  });

  it('drops orphan stuck_session_timers rows during migration', () => {
    db.pragma('foreign_keys = OFF');
    db.prepare(
      "INSERT INTO stuck_session_timers (session_id, task_name) VALUES (?, 'task')",
    ).run('orphan-4');
    db.pragma('foreign_keys = ON');

    runCascadeMigration(db);

    expect(count(db, 'stuck_session_timers', 'orphan-4')).toBe(0);
  });
});

describe('CASCADE migration — cascade behavior after migration', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
    runCascadeMigration(db);
  });

  it('deleting a session cascades to session_events', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, 'x', '{}', 0)",
    ).run('s1');

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');

    expect(count(db, 'session_events', 's1')).toBe(0);
  });

  it('deleting a session cascades to permission_events', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO permission_events (session_id, tool_name, decision, decided_at) VALUES (?, 'bash', 'allow', 0)",
    ).run('s1');

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');

    expect(count(db, 'permission_events', 's1')).toBe(0);
  });

  it('deleting a session cascades to permission_denials', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO permission_denials (session_id, tool_name, tool_use_id, tool_input, timestamp) VALUES (?, 'bash', 'tu1', '{}', 0)",
    ).run('s1');

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');

    expect(count(db, 'permission_denials', 's1')).toBe(0);
  });

  it('deleting a session cascades to session_audits', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO session_audits (session_id, audited_at) VALUES (?, '2024-01-01')",
    ).run('s1');

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');

    expect(count(db, 'session_audits', 's1')).toBe(0);
  });

  it('deleting a session cascades to session_pause_intervals', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO session_pause_intervals (session_id, pause_reason, paused_at) VALUES (?, 'test', 0)",
    ).run('s1');

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');

    expect(count(db, 'session_pause_intervals', 's1')).toBe(0);
  });

  it('deleting a session cascades to stuck_session_timers', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO stuck_session_timers (session_id, task_name) VALUES (?, 'task')",
    ).run('s1');

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');

    expect(count(db, 'stuck_session_timers', 's1')).toBe(0);
  });

  it('cascade only removes rows for the deleted session, not others', () => {
    insertSession(db, 's1');
    insertSession(db, 's2');
    db.prepare(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, 'x', '{}', 0)",
    ).run('s1');
    db.prepare(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, 'x', '{}', 0)",
    ).run('s2');

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');

    expect(count(db, 'session_events', 's1')).toBe(0);
    expect(count(db, 'session_events', 's2')).toBe(1);
  });
});

describe('CASCADE migration — idempotency', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('running the migration twice is a no-op the second time', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, 'x', '{}', 0)",
    ).run('s1');

    runCascadeMigration(db);
    runCascadeMigration(db);

    expect(count(db, 'session_events', 's1')).toBe(1);
  });

  it('second run still enforces cascade correctly', () => {
    insertSession(db, 's1');
    db.prepare(
      "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?, 'x', '{}', 0)",
    ).run('s1');

    runCascadeMigration(db);
    runCascadeMigration(db);

    db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');
    expect(count(db, 'session_events', 's1')).toBe(0);
  });
});
