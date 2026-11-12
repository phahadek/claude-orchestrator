import type Database from 'better-sqlite3';

/**
 * Applies the full table schema needed for queries.ts prepared statements
 * to compile against an in-memory test database. Mirrors src/db/db.ts
 * + src/db/schema.ts (column-superset). Tests should use this when
 * mocking ../../src/db/db.js so that imports of queries.ts succeed.
 */
export function applyTestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id          TEXT    PRIMARY KEY,
      task_id             TEXT,
      task_url            TEXT,
      project_context_url TEXT,
      status              TEXT    NOT NULL DEFAULT 'running',
      started_at          INTEGER NOT NULL DEFAULT 0,
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
      metadata            TEXT,
      review_result       TEXT
    );
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message_id   TEXT
    );
    CREATE TABLE IF NOT EXISTS permission_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT    NOT NULL,
      tool_name       TEXT    NOT NULL,
      proposed_action TEXT,
      decision        TEXT    NOT NULL,
      rule_matched    TEXT,
      decided_at      INTEGER NOT NULL
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
      timestamp   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_cache (
      task_id    TEXT    PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      raw_json   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_audits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      pr_opened     INTEGER NOT NULL DEFAULT 0,
      pr_targets    TEXT,
      task_status   TEXT,
      violations    TEXT NOT NULL DEFAULT '[]',
      spec_mismatch TEXT,
      audited_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number              INTEGER NOT NULL,
      pr_url                 TEXT    NOT NULL UNIQUE,
      task_id                TEXT,
      session_id             TEXT,
      repo                   TEXT    NOT NULL,
      title                  TEXT,
      body                   TEXT,
      head_branch            TEXT,
      base_branch            TEXT,
      state                  TEXT    NOT NULL DEFAULT 'open',
      draft                  INTEGER NOT NULL DEFAULT 0,
      review_result          TEXT,
      review_at              TEXT,
      created_at             TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL,
      synced_at              TEXT    NOT NULL,
      review_session_id      TEXT,
      review_iteration       INTEGER NOT NULL DEFAULT 0,
      head_sha               TEXT,
      last_reviewed_sha      TEXT,
      node_id                TEXT,
      mergeable              INTEGER,
      merge_state            TEXT,
      merge_state_checked_at TEXT,
      pending_push           INTEGER NOT NULL DEFAULT 0,
      pause_reason           TEXT,
      failing_checks         TEXT
    );
    CREATE TABLE IF NOT EXISTS projects (
      id                       TEXT    PRIMARY KEY,
      name                     TEXT    NOT NULL,
      project_dir              TEXT    NOT NULL,
      context_url              TEXT,
      github_repo              TEXT,
      task_source              TEXT    NOT NULL DEFAULT 'notion',
      auto_launch_enabled      INTEGER NOT NULL DEFAULT 0,
      auto_launch_milestone_id TEXT,
      auto_merge_enabled       INTEGER NOT NULL DEFAULT 0,
      git_mode                 TEXT    NOT NULL DEFAULT 'github',
      milestone_branching          TEXT,
      task_source_config           TEXT,
      non_milestone_source_config  TEXT,
      data_residency_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id            TEXT    PRIMARY KEY,
      project_id    TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      source_id     TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      event_type TEXT    NOT NULL,
      actor_type TEXT    NOT NULL,
      actor_id   TEXT,
      project_id TEXT,
      task_id    TEXT,
      payload    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      user_agent  TEXT,
      last_ip     TEXT,
      last_seen   INTEGER,
      enrolled_at INTEGER NOT NULL,
      token       TEXT    NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS local_branches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      branch_name   TEXT NOT NULL,
      base_branch   TEXT NOT NULL DEFAULT 'dev',
      status        TEXT NOT NULL DEFAULT 'open',
      review_result TEXT,
      pause_reason  TEXT,
      merge_commit_sha TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_pause_intervals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      pause_reason TEXT    NOT NULL,
      paused_at    INTEGER NOT NULL,
      resumed_at   INTEGER NULL
    );
    CREATE TABLE IF NOT EXISTS stuck_session_timers (
      session_id             TEXT    PRIMARY KEY,
      task_name              TEXT    NOT NULL,
      notify_deadline        INTEGER NOT NULL DEFAULT 0,
      pause_deadline         INTEGER NOT NULL DEFAULT 0,
      hard_stop_deadline     INTEGER NOT NULL DEFAULT 0,
      hard_stop_armed        INTEGER NOT NULL DEFAULT 0,
      notify_remaining_ms    INTEGER,
      pause_remaining_ms     INTEGER,
      hard_stop_remaining_ms INTEGER
    );
  `);
}
