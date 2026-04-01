import Database from 'better-sqlite3';
import path from 'path';

const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'dashboard.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run migrations immediately so prepared statements in queries.ts compile at import time.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT    PRIMARY KEY,
    notion_task_id      TEXT,
    notion_task_url     TEXT,
    project_context_url TEXT,
    status              TEXT    NOT NULL,
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    pr_url              TEXT,
    worktree_path       TEXT,
    favorited           INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS session_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT    NOT NULL,
    event_type   TEXT    NOT NULL,
    payload      TEXT    NOT NULL,
    timestamp    INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );
  CREATE TABLE IF NOT EXISTS permission_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    tool_name       TEXT    NOT NULL,
    proposed_action TEXT,
    decision        TEXT    NOT NULL,
    rule_matched    TEXT,
    decided_at      INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );
  CREATE TABLE IF NOT EXISTS permission_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_index INTEGER NOT NULL,
    pattern     TEXT    NOT NULL,
    match_type  TEXT    NOT NULL,
    decision    TEXT    NOT NULL,
    label       TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS task_cache (
    notion_task_id TEXT    PRIMARY KEY,
    fetched_at     INTEGER NOT NULL,
    raw_json       TEXT    NOT NULL
  );
`);
