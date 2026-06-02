import { describe, it, expect, vi } from 'vitest';

// ── DB-level: incrementCompactionCount query ────────────────────────────────
// Uses an in-memory SQLite database so persistence is verified without touching
// the real dashboard.db.

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      task_id             TEXT,
      task_url            TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL,
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      pr_url              TEXT,
      worktree_path       TEXT,
      archived            INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      favorited           INTEGER NOT NULL DEFAULT 0,
      note                TEXT,
      tags                TEXT,
      task_name           TEXT,
      model               TEXT,
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      compaction_count    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT,
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
    CREATE TABLE IF NOT EXISTS permission_denials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL,
      tool_use_id TEXT    NOT NULL,
      tool_input  TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number         INTEGER NOT NULL,
      pr_url            TEXT    NOT NULL UNIQUE,
      task_id           TEXT,
      session_id        TEXT,
      repo              TEXT    NOT NULL,
      title             TEXT,
      body              TEXT,
      head_branch       TEXT,
      base_branch       TEXT,
      state             TEXT    NOT NULL DEFAULT 'open',
      draft             INTEGER NOT NULL DEFAULT 0,
      review_result     TEXT,
      review_at         TEXT,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL,
      synced_at         TEXT    NOT NULL,
      review_session_id TEXT,
      review_iteration  INTEGER NOT NULL DEFAULT 0,
      head_sha          TEXT
    );
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      user_agent  TEXT,
      last_ip     TEXT,
      last_seen   INTEGER,
      enrolled_at INTEGER NOT NULL,
      token       TEXT    NOT NULL UNIQUE,
      revoked     INTEGER NOT NULL DEFAULT 0
    );
  `);
  return { db };
});

import {
  insertSession,
  getSession,
  incrementCompactionCount,
} from '../db/queries.js';

const baseSession = {
  session_id: 'compaction-db-test',
  task_id: null,
  task_url: null,
  project_context_url: null,
  project_id: null,
  status: 'running' as const,
  started_at: Date.now(),
};

describe('incrementCompactionCount — SQLite integration', () => {
  it('initializes compaction_count to 0', () => {
    insertSession(baseSession);
    const row = getSession('compaction-db-test');
    expect(row?.compaction_count).toBe(0);
  });

  it('increments compaction_count by 1 each call (persists across "restarts")', () => {
    incrementCompactionCount('compaction-db-test');
    const row = getSession('compaction-db-test');
    expect(row?.compaction_count).toBe(1);
  });

  it('accumulates across multiple calls', () => {
    incrementCompactionCount('compaction-db-test');
    incrementCompactionCount('compaction-db-test');
    const row = getSession('compaction-db-test');
    expect(row?.compaction_count).toBe(3);
  });
});
