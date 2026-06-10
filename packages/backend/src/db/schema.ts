import Database from 'better-sqlite3';

export function runMigrations(target: Database.Database): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
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
      compaction_count          INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT    PRIMARY KEY,
      name         TEXT    NOT NULL,
      project_dir  TEXT    NOT NULL,
      context_url  TEXT,
      github_repo  TEXT,
      task_source  TEXT    NOT NULL DEFAULT 'notion',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS local_branches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      branch_name   TEXT NOT NULL,
      base_branch   TEXT NOT NULL DEFAULT 'dev',
      status        TEXT NOT NULL DEFAULT 'open',
      review_result TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_branches_project_status ON local_branches(project_id, status);

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
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);

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

    CREATE TABLE IF NOT EXISTS pr_review_comments_routed (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number  INTEGER NOT NULL,
      repo       TEXT    NOT NULL,
      comment_id TEXT    NOT NULL,
      routed_at  INTEGER NOT NULL,
      UNIQUE(pr_number, repo, comment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pr_review_comments_routed_pr ON pr_review_comments_routed(pr_number, repo);

    CREATE TABLE IF NOT EXISTS orchestrator_autofix_shas (
      pr_number  INTEGER NOT NULL,
      repo       TEXT    NOT NULL,
      sha        TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (pr_number, repo, sha)
    );

    CREATE TABLE IF NOT EXISTS orchestrator_test_results (
      pr_number  INTEGER NOT NULL,
      repo       TEXT    NOT NULL,
      sha        TEXT    NOT NULL,
      passed     INTEGER NOT NULL,
      output     TEXT    NOT NULL DEFAULT '',
      ran_at     TEXT    NOT NULL,
      PRIMARY KEY (pr_number, repo, sha)
    );

    CREATE TABLE IF NOT EXISTS task_no_op_attempts (
      task_id          TEXT PRIMARY KEY,
      retry_count      INTEGER NOT NULL DEFAULT 0,
      last_attempt_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_crash_counts (
      task_id             TEXT    PRIMARY KEY,
      consecutive_crashes INTEGER NOT NULL DEFAULT 0,
      last_crash_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_review_sync (
      pr_number  INTEGER NOT NULL,
      repo       TEXT    NOT NULL,
      sync_state TEXT    NOT NULL DEFAULT 'pending',
      PRIMARY KEY (pr_number, repo)
    );

    CREATE TABLE IF NOT EXISTS session_pause_intervals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      pause_reason TEXT    NOT NULL,
      paused_at    INTEGER NOT NULL,
      resumed_at   INTEGER NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_pause_intervals_session_id ON session_pause_intervals(session_id);

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

    CREATE TABLE IF NOT EXISTS active_merges (
      key        TEXT    PRIMARY KEY,
      repo       TEXT    NOT NULL,
      pr_number  INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pull_requests (
      id                           INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number                    INTEGER NOT NULL,
      pr_url                       TEXT    NOT NULL UNIQUE,
      task_id                      TEXT,
      session_id                   TEXT,
      repo                         TEXT    NOT NULL,
      title                        TEXT,
      body                         TEXT,
      head_branch                  TEXT,
      base_branch                  TEXT,
      state                        TEXT    NOT NULL DEFAULT 'open',
      draft                        INTEGER NOT NULL DEFAULT 0,
      review_result                TEXT,
      review_at                    TEXT,
      created_at                   TEXT    NOT NULL,
      updated_at                   TEXT    NOT NULL,
      synced_at                    TEXT    NOT NULL,
      review_session_id            TEXT,
      review_iteration             INTEGER NOT NULL DEFAULT 0,
      head_sha                     TEXT,
      last_reviewed_sha            TEXT,
      node_id                      TEXT,
      mergeable                    INTEGER,
      merge_state                  TEXT,
      merge_state_checked_at       TEXT,
      pending_push                 INTEGER NOT NULL DEFAULT 0,
      pause_reason                 TEXT,
      failing_checks               TEXT,
      ci_remediation_attempted_sha TEXT,
      pause_reason_set_at          INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id ON session_events(session_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_event_type ON session_events(session_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_archived_started_at ON sessions(archived, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_notion_task_id_session_type ON sessions(task_id, session_type, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_task_id_pr_number ON pull_requests(task_id, pr_number DESC);
  `);

  // Idempotent column additions for existing databases
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN project_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN session_type TEXT DEFAULT 'standard'`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN note TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN tags TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE session_events ADD COLUMN message_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN context_occupancy_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN review_session_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN review_iteration INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN head_sha TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN last_reviewed_sha TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN auto_launch_enabled INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN auto_launch_milestone_id TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN pause_reason TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN failing_checks TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN auto_merge_enabled INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN metadata TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN git_mode TEXT NOT NULL DEFAULT 'github'`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN review_result TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE local_branches ADD COLUMN pause_reason TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE local_branches ADD COLUMN merge_commit_sha TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE projects ADD COLUMN milestone_branching TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN non_milestone_source_config TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE projects ADD COLUMN task_source_config TEXT`);
  } catch {
    /* already exists */
  }

  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN ci_remediation_attempted_sha TEXT`,
    );
  } catch {
    /* already exists */
  }

  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN pause_reason_set_at INTEGER`,
    );
  } catch {
    /* already exists */
  }

  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN pre_review_stage TEXT`);
  } catch {
    /* already exists */
  }

  // ── Double-prefix cleanup (notion:notion: contamination from pre-fix-release) ──
  // Per-task rows with double-prefixed keys are deleted; they re-populate on next fetch.
  // Board-cache JSON is repaired in-place so the route doesn't serve stale IDs.
  target.exec(`
    DELETE FROM task_cache WHERE task_id LIKE 'notion:notion:%';

    UPDATE task_cache
    SET raw_json = REPLACE(raw_json, '"id":"notion:notion:', '"id":"notion:')
    WHERE task_id LIKE 'board:%' AND raw_json LIKE '%notion:notion:%';
  `);

  // ── Source-prefix backfill (idempotent: NOT LIKE '%:%' guard) ──────────────
  // Prefix sessions.task_id with source based on owning project's task_source.
  // Rows with no project_id default to 'notion:' (all pre-M6 sessions were Notion).
  target.exec(`
    UPDATE sessions
    SET task_id = 'notion:' || task_id
    WHERE task_id IS NOT NULL AND task_id NOT LIKE '%:%'
    AND (project_id IS NULL
         OR project_id IN (SELECT id FROM projects WHERE task_source = 'notion'));

    UPDATE sessions
    SET task_id = 'yaml:' || task_id
    WHERE task_id IS NOT NULL AND task_id NOT LIKE '%:%'
    AND project_id IN (SELECT id FROM projects WHERE task_source = 'yaml');

    DELETE FROM task_cache
    WHERE task_id NOT LIKE '%:%'
      AND EXISTS (SELECT 1 FROM task_cache t2 WHERE t2.task_id = 'notion:' || task_cache.task_id);

    DELETE FROM task_cache
    WHERE task_id NOT LIKE '%:%'
      AND EXISTS (SELECT 1 FROM task_cache t2 WHERE t2.task_id = 'yaml:' || task_cache.task_id);

    UPDATE task_cache
    SET task_id = 'notion:' || task_id
    WHERE task_id NOT LIKE '%:%';
  `);
  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN data_residency_confirmed INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN compaction_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // ── Backfill github_repo for GitHub-task-source projects ─────────────────────
  // Idempotent: guarded by github_repo IS NULL, re-running is a no-op.
  target.exec(`
    UPDATE projects
    SET github_repo = json_extract(task_source_config, '$.owner') || '/' || json_extract(task_source_config, '$.repo')
    WHERE task_source = 'github'
      AND github_repo IS NULL
      AND task_source_config IS NOT NULL
      AND json_extract(task_source_config, '$.owner') IS NOT NULL
      AND json_extract(task_source_config, '$.repo') IS NOT NULL;
  `);

  // ── pull_requests: notion_task_id → task_id ──────────────────────────────────
  try {
    target.exec(
      `ALTER TABLE pull_requests RENAME COLUMN notion_task_id TO task_id`,
    );
  } catch {
    /* already renamed or column doesn't exist (fresh DB uses task_id already) */
  }
  // Backfill: add 'notion:' prefix for legacy unprefixed rows.
  // Delete raw duplicate first to avoid UNIQUE constraint violations.
  target.exec(`
    DELETE FROM pull_requests
    WHERE task_id IS NOT NULL
      AND task_id NOT LIKE '%:%'
      AND EXISTS (
        SELECT 1 FROM pull_requests pr2
        WHERE pr2.task_id = 'notion:' || pull_requests.task_id
          AND pr2.pr_url != pull_requests.pr_url
      );

    UPDATE pull_requests
    SET task_id = 'notion:' || task_id
    WHERE task_id IS NOT NULL
      AND task_id NOT LIKE '%:%';
  `);

  // Drop old index on notion_task_id (may still exist on pre-D1 databases).
  try {
    target.exec(
      `DROP INDEX IF EXISTS idx_pull_requests_notion_task_id_pr_number`,
    );
  } catch {
    /* ignore */
  }

  // ── Dashless → dashed backfill (idempotent) ──────────────────────────────
  // SessionManager historically wrote dashless 32-hex UUIDs (from URL regex).
  // task_cache stores dashed UUIDs (from Notion API). Align sessions, pull_requests,
  // and audit_log to the dashed form so the JOIN in getActiveTaskAggregates matches.
  // Guard: LENGTH = 39 means 'notion:' (7) + dashless 32-hex (32) — already-dashed
  // rows are 43 chars and are untouched. Non-notion task_ids (yaml:, jira:) are
  // untouched because they don't match LIKE 'notion:%'.
  target.exec(`
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
  `);

  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'dev'`,
    );
  } catch {
    /* already exists */
  }

  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN pause_reason TEXT`);
  } catch {
    /* already exists */
  }

  // Task-level pause reasons for tasks that have never had a PR (e.g. launch_failed).
  target.exec(`
    CREATE TABLE IF NOT EXISTS task_pause_reasons (
      task_id      TEXT    PRIMARY KEY,
      pause_reason TEXT    NOT NULL,
      detail       TEXT,
      set_at       INTEGER NOT NULL
    )
  `);

  // Migration: Add ON DELETE CASCADE to all session-FK child tables.
  // SQLite can't ALTER TABLE to add constraints, so each table is recreated.
  // Idempotent: checks sqlite_master before running. Orphan rows are discarded.
  {
    type TableSqlRow = { sql: string };
    const getTableSql = (name: string): string =>
      (
        target
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name) as TableSqlRow | undefined
      )?.sql ?? '';

    if (!getTableSql('session_events').includes('ON DELETE CASCADE')) {
      target.exec(`
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
        CREATE INDEX idx_session_events_session_id_id ON session_events(session_id, id DESC);
        CREATE INDEX idx_session_events_session_id_event_type ON session_events(session_id, event_type);
        CREATE INDEX idx_session_events_timestamp ON session_events(timestamp DESC);
        COMMIT;
      `);
    }

    if (!getTableSql('permission_events').includes('ON DELETE CASCADE')) {
      target.exec(`
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
      target.exec(`
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
      target.exec(`
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
      target.exec(`
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
        CREATE INDEX idx_session_pause_intervals_session_id ON session_pause_intervals(session_id);
        COMMIT;
      `);
    }

    if (!getTableSql('stuck_session_timers').includes('ON DELETE CASCADE')) {
      target.exec(`
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

  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN last_error_detail TEXT`);
  } catch {
    /* already exists */
  }
}
