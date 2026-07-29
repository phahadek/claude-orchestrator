import Database from 'better-sqlite3';
import { logger } from '../logger';

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
      canonical_short_id TEXT,
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
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number    INTEGER NOT NULL,
      repo         TEXT    NOT NULL,
      comment_id   TEXT    NOT NULL,
      routed_at    INTEGER NOT NULL,
      routed_state TEXT    NOT NULL DEFAULT 'pending',
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

    CREATE TABLE IF NOT EXISTS orchestrator_analyze_results (
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

    CREATE TABLE IF NOT EXISTS task_repo_assignments (
      task_id      TEXT    PRIMARY KEY,
      project_id   TEXT    NOT NULL,
      repo         TEXT    NOT NULL,
      assigned_by  TEXT    NOT NULL DEFAULT 'system',
      assigned_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ops_journal (
      task_id              TEXT    PRIMARY KEY,
      project              TEXT    NOT NULL,
      milestone            TEXT    NOT NULL,
      state                TEXT    NOT NULL,
      disposition          TEXT,
      worked_in            TEXT,
      evidence             TEXT,
      finding_or_proposal  TEXT,
      falsification        TEXT,
      filed_followons      TEXT,
      needs_from_operator  TEXT,
      resolution           TEXT,
      updated_at           TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ops_journal_project_milestone ON ops_journal(project, milestone);

    CREATE TABLE IF NOT EXISTS gate_item (
      id                     TEXT    PRIMARY KEY,
      project                TEXT    NOT NULL,
      milestone              TEXT    NOT NULL,
      text                   TEXT    NOT NULL,
      classification         TEXT    NOT NULL,
      min_deployed_commit    TEXT,
      state                  TEXT    NOT NULL,
      current_disposition    TEXT,
      updated_at             TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gate_item_project_milestone ON gate_item(project, milestone);

    CREATE TABLE IF NOT EXISTS gate_item_source (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_item_id      TEXT    NOT NULL,
      source_task_id    TEXT    NOT NULL,
      source_task_title TEXT    NOT NULL,
      merge_commit      TEXT,
      added_at          TEXT    NOT NULL,
      FOREIGN KEY (gate_item_id) REFERENCES gate_item(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gate_item_source_gate_item_id ON gate_item_source(gate_item_id);

    CREATE TABLE IF NOT EXISTS gate_item_event (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_item_id   TEXT    NOT NULL,
      disposition    TEXT,
      evidence       TEXT,
      filed_followon TEXT,
      deploy_sha     TEXT,
      operator       TEXT,
      at             TEXT    NOT NULL,
      FOREIGN KEY (gate_item_id) REFERENCES gate_item(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gate_item_event_gate_item_id ON gate_item_event(gate_item_id);

    CREATE TABLE IF NOT EXISTS project_deployed_sha (
      project_id  TEXT    PRIMARY KEY,
      sha         TEXT    NOT NULL,
      recorded_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deploy_run (
      run_id       TEXT    PRIMARY KEY,
      project      TEXT    NOT NULL,
      target_sha   TEXT    NOT NULL,
      current_step TEXT,
      status       TEXT    NOT NULL,
      started_at   TEXT    NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_run_project_status ON deploy_run(project, status);
    -- At most one active (status = 'running') run per project.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deploy_run_active_per_project
      ON deploy_run(project) WHERE status = 'running';

    CREATE TABLE IF NOT EXISTS deploy_run_event (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT    NOT NULL,
      step        TEXT    NOT NULL,
      event_type  TEXT    NOT NULL,
      disposition TEXT,
      detail      TEXT,
      at          TEXT    NOT NULL,
      FOREIGN KEY (run_id) REFERENCES deploy_run(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_run_event_run_id ON deploy_run_event(run_id);

    CREATE TABLE IF NOT EXISTS gate_accretion (
      source_task_id TEXT    PRIMARY KEY,
      project         TEXT    NOT NULL,
      milestone       TEXT    NOT NULL,
      decision        TEXT    NOT NULL,
      reason          TEXT,
      accreted_at     TEXT    NOT NULL
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
      pause_reason_set_at          INTEGER,
      conflict_nudge_sha           TEXT,
      session_initiated_close_at   INTEGER
    );

    CREATE TABLE IF NOT EXISTS scheduler_audit (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      job            TEXT    NOT NULL,
      status         TEXT    NOT NULL,
      started_at     TEXT    NOT NULL,
      completed_at   TEXT    NOT NULL,
      duration_ms    INTEGER NOT NULL,
      items_processed INTEGER,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_audit_job ON scheduler_audit(job, started_at DESC);

    CREATE TABLE IF NOT EXISTS session_feedback_inbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      enqueued_at  INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_session_feedback_inbox_session_delivered
      ON session_feedback_inbox(session_id, delivered_at);

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
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN events_pruned_at INTEGER`);
  } catch {
    /* already exists */
  }
  {
    let routedStateColAdded = false;
    try {
      target.exec(
        `ALTER TABLE pr_review_comments_routed ADD COLUMN routed_state TEXT NOT NULL DEFAULT 'pending'`,
      );
      routedStateColAdded = true;
    } catch {
      /* already exists */
    }
    if (routedStateColAdded) {
      // Backfill rows that existed before this migration — they were already
      // delivered, so mark them acked so they are never re-sent.
      target.exec(
        `UPDATE pr_review_comments_routed SET routed_state = 'acked' WHERE routed_state = 'pending'`,
      );
    }
  }

  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN conflict_nudge_sha TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN stalled_pr_retry_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE orchestrator_analyze_results ADD COLUMN is_transient INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN session_initiated_close_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN reviewer_requested_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN flake_recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  target.exec(`
    CREATE TABLE IF NOT EXISTS seed_item (
      id                     TEXT    PRIMARY KEY,
      project                TEXT    NOT NULL,
      milestone              TEXT    NOT NULL,
      spec                   TEXT    NOT NULL,
      min_deployed_commit    TEXT,
      state                  TEXT    NOT NULL,
      updated_at             TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seed_item_project_milestone ON seed_item(project, milestone);

    CREATE TABLE IF NOT EXISTS seed_item_source (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      seed_item_id      TEXT    NOT NULL,
      source_task_id    TEXT    NOT NULL,
      source_task_title TEXT    NOT NULL,
      merge_commit      TEXT,
      added_at          TEXT    NOT NULL,
      FOREIGN KEY (seed_item_id) REFERENCES seed_item(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_seed_item_source_seed_item_id ON seed_item_source(seed_item_id);

    CREATE TABLE IF NOT EXISTS seed_item_event (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      seed_item_id   TEXT    NOT NULL,
      outcome        TEXT    NOT NULL,
      evidence       TEXT,
      filed_followon TEXT,
      operator       TEXT,
      at             TEXT    NOT NULL,
      FOREIGN KEY (seed_item_id) REFERENCES seed_item(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_seed_item_event_seed_item_id ON seed_item_event(seed_item_id);

    CREATE TABLE IF NOT EXISTS seed_accretion (
      source_task_id TEXT    PRIMARY KEY,
      project         TEXT    NOT NULL,
      milestone       TEXT    NOT NULL,
      decision        TEXT    NOT NULL,
      accreted_at     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS completeness_disposition (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_task_id  TEXT    NOT NULL,
      project         TEXT,
      milestone       TEXT,
      questions       TEXT    NOT NULL,
      run_at          TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_completeness_disposition_source ON completeness_disposition(source_task_id);
  `);

  // ── Git-Bash project_dir backfill (win32-only, idempotent) ──────────────────
  // Converts any /c/... or /D/... style project_dir stored by Git-Bash
  // into the native Win32 form C:/... / D:/... so exec cwd is valid.
  // Guard: substr(1,1)='/' ensures already-normalized C:/... rows are skipped.
  if (process.platform === 'win32') {
    target.exec(`
      UPDATE projects
      SET project_dir = upper(substr(project_dir, 2, 1)) || ':' || substr(project_dir, 3)
      WHERE substr(project_dir, 1, 1) = '/'
        AND substr(project_dir, 3, 1) = '/'
        AND (
          (substr(project_dir, 2, 1) BETWEEN 'a' AND 'z')
          OR (substr(project_dir, 2, 1) BETWEEN 'A' AND 'Z')
        )
    `);
  }

  // ── gate_item_source.source_task_id: raw Notion id → prefixed 'notion:<id>' ──
  // Accretion/backfill historically stored the raw Notion id while
  // merge_completed's payload.notion_task_id (from pull_requests.task_id) is
  // always the prefixed canonical form, so the consumer's WHERE source_task_id
  // = ? join never matched and min_deployed_commit was never filled. Idempotent:
  // guarded by NOT LIKE '%:%', re-running is a no-op.
  target.exec(`
    UPDATE gate_item_source
    SET source_task_id = 'notion:' || source_task_id
    WHERE source_task_id NOT LIKE '%:%';
  `);

  // ── milestone key: full Notion title → short M<n> canonical token ──────────
  // resolveMilestoneForProject used to return a milestone's full display name
  // (e.g. "M11 — Orchestrator-Owned Planning") instead of the short form every
  // other write/read/loader/row keys on. Rows minted as accretion stopgaps
  // while that bug stood are re-keyed here to the short token every other
  // store already used. Idempotent: a milestone value already in short form
  // (or with no leading M<n> token) is left untouched.
  const shortMilestoneToken = (name: string): string | null => {
    const match = /^([Mm]\d+[A-Za-z]?)(?=[\s—:-]|$)/.exec(name);
    return match ? match[1] : null;
  };
  for (const table of [
    'gate_item',
    'seed_item',
    'gate_accretion',
    'seed_accretion',
  ]) {
    const rows = target
      .prepare(`SELECT DISTINCT milestone FROM ${table}`)
      .all() as { milestone: string }[];
    for (const { milestone } of rows) {
      const short = shortMilestoneToken(milestone);
      if (short && short !== milestone) {
        target
          .prepare(`UPDATE ${table} SET milestone = ? WHERE milestone = ?`)
          .run(short, milestone);
      }
    }
  }

  // ── seed_item_source.source_task_id: raw Notion id → prefixed 'notion:<id>' ──
  // Mirrors the gate_item_source migration above so seed accretion keys on
  // the same store-wide 'notion:<id>' convention as gate accretion.
  target.exec(`
    UPDATE seed_item_source
    SET source_task_id = 'notion:' || source_task_id
    WHERE source_task_id NOT LIKE '%:%';
  `);

  // ── gate_accretion / seed_accretion source_task_id: raw → prefixed ─────────
  // The promotion-gate marker lookup (groomGate.ts) and the accretion writers
  // (accreteGateContribution / stageSeedContribution) must agree on one
  // taskId form. source_task_id is the PRIMARY KEY here, so a raw-keyed row
  // is merged into any pre-existing prefixed row for the same underlying
  // task (keeping whichever marker is newer) rather than blindly UPDATEd,
  // to avoid a PK collision.
  for (const table of ['gate_accretion', 'seed_accretion']) {
    const rawRows = target
      .prepare(`SELECT * FROM ${table} WHERE source_task_id NOT LIKE '%:%'`)
      .all() as {
      source_task_id: string;
      project: string;
      milestone: string;
      decision: string;
      accreted_at: string;
    }[];
    for (const row of rawRows) {
      const normalized = `notion:${row.source_task_id}`;
      const existing = target
        .prepare(`SELECT * FROM ${table} WHERE source_task_id = ?`)
        .get(normalized) as { accreted_at: string } | undefined;
      if (existing) {
        if (row.accreted_at > existing.accreted_at) {
          target
            .prepare(
              `UPDATE ${table} SET project = ?, milestone = ?, decision = ?, accreted_at = ? WHERE source_task_id = ?`,
            )
            .run(
              row.project,
              row.milestone,
              row.decision,
              row.accreted_at,
              normalized,
            );
        }
        target
          .prepare(`DELETE FROM ${table} WHERE source_task_id = ?`)
          .run(row.source_task_id);
      } else {
        target
          .prepare(
            `UPDATE ${table} SET source_task_id = ? WHERE source_task_id = ?`,
          )
          .run(normalized, row.source_task_id);
      }
    }
  }

  // ── staged_intent: durable per-intent lifecycle store ────────────────────
  // Replaces the in-memory Map that used to back routes/stagedIntents.ts.
  // Lifecycle: staged -> approved -> committed | rejected | superseded.
  // Existing in-flight in-memory intents are dropped at cutover (same loss
  // profile as a restart today) — no backfill needed.
  target.exec(`
    CREATE TABLE IF NOT EXISTS staged_intent (
      id           TEXT    PRIMARY KEY,
      kind         TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      payload_hash TEXT    NOT NULL,
      task_id      TEXT,
      project_id   TEXT    NOT NULL,
      session_id   TEXT,
      group_id     TEXT,
      state        TEXT    NOT NULL DEFAULT 'staged',
      supersedes   TEXT,
      annotation   TEXT,
      decision_proposal TEXT,
      advisory     TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_staged_intent_project_state ON staged_intent(project_id, state);
    CREATE INDEX IF NOT EXISTS idx_staged_intent_group ON staged_intent(group_id);
    CREATE INDEX IF NOT EXISTS idx_staged_intent_dedup ON staged_intent(project_id, kind, task_id, state);

    CREATE TABLE IF NOT EXISTS staged_intent_group (
      group_id         TEXT    PRIMARY KEY,
      route_back_count INTEGER NOT NULL DEFAULT 0,
      escalated        INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL
    );
  `);

  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN decision_proposal TEXT`);
  } catch {
    /* already exists */
  }

  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN advisory TEXT`);
  } catch {
    /* already exists */
  }

  // staged_intent.disposition_reason: operator-supplied rationale for a
  // reject disposition (pushback | decline) — durable, not only carried in
  // the transient session re-turn message. Forward-only: existing rows get
  // NULL (no reason on record for dispositions made before this column
  // existed).
  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN disposition_reason TEXT`);
  } catch {
    /* already exists */
  }

  // staged_intent.answer: the operator's response to a decision.pickOne
  // question-intent — { chosenLabel, freeForm } as JSON. Set only on the
  // terminal `committed` transition for that kind; never read by any apply
  // path, since decision.pickOne writes no task-store mutation.
  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN answer TEXT`);
  } catch {
    /* already exists */
  }

  // staged_intent.groom_proposal: the /groom skill's structured proposal
  // fields (achieves / openQuestions / automatedTests / manualVerification /
  // operationalSeed — presentation.md's per-task summary) as JSON, carried by
  // a dispatched groom session's Ready-flip decision instead of a free-prose
  // decisionProposal string. Forward-only: existing rows get NULL.
  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN groom_proposal TEXT`);
  } catch {
    /* already exists */
  }

  // ── arch_unit: architecture-information store ───────────────────────────
  // A single titled architecture statement (kind/topic/regions/status envelope
  // + markdown body). Mirrors the gate_item/seed_item shape: envelope as typed
  // columns, prose as a markdown body column, plus an append-only event log.
  // supersede-not-delete: a superseded unit is retained with status='superseded',
  // not removed.
  target.exec(`
    CREATE TABLE IF NOT EXISTS arch_unit (
      id            TEXT    PRIMARY KEY,
      title         TEXT    NOT NULL,
      kind          TEXT    NOT NULL,
      topic         TEXT    NOT NULL,
      regions       TEXT    NOT NULL DEFAULT '[]',
      status        TEXT    NOT NULL DEFAULT 'active',
      body          TEXT    NOT NULL,
      supersedes    TEXT,
      superseded_by TEXT,
      version       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arch_unit_topic ON arch_unit(topic);
    CREATE INDEX IF NOT EXISTS idx_arch_unit_kind ON arch_unit(kind);
    CREATE INDEX IF NOT EXISTS idx_arch_unit_status ON arch_unit(status);

    CREATE TABLE IF NOT EXISTS arch_unit_event (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      arch_unit_id TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT,
      at           TEXT    NOT NULL,
      FOREIGN KEY (arch_unit_id) REFERENCES arch_unit(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_arch_unit_event_arch_unit_id ON arch_unit_event(arch_unit_id);
  `);

  try {
    target.exec(
      `ALTER TABLE arch_unit ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
    );
  } catch {
    /* already exists */
  }

  // ── milestones.canonical_short_id: stored canonical short-form key ─────────
  // Replaces the read-path extractMilestoneToken(name) parse in
  // milestoneResolver.ts with an explicit stored field, populated once at
  // registration. NOTE: this backfill's source_id-first precedence was wrong
  // for Notion-synced milestones — it left canonical_short_id on the hex
  // source_id while gate_item/seed_item key on the M<n> token. Left as-is
  // (idempotent-on-NULL, so it won't re-run); the corrective follow-up
  // migration below re-derives token-first for rows this one mis-populated.
  try {
    target.exec(`ALTER TABLE milestones ADD COLUMN canonical_short_id TEXT`);
  } catch {
    /* already exists */
  }
  {
    const shortMilestoneToken = (name: string): string | null => {
      const match = /^([Mm]\d+[A-Za-z]?)(?=[\s—:-]|$)/.exec(name);
      return match ? match[1] : null;
    };
    const rows = target
      .prepare(
        `SELECT id, name, source_id FROM milestones WHERE canonical_short_id IS NULL`,
      )
      .all() as { id: string; name: string; source_id: string | null }[];
    const update = target.prepare(
      `UPDATE milestones SET canonical_short_id = ? WHERE id = ?`,
    );
    for (const row of rows) {
      const canonical =
        row.source_id ?? shortMilestoneToken(row.name) ?? row.name;
      update.run(canonical, row.id);
    }
  }

  // Per-project uniqueness: a canonical_short_id must resolve to exactly one
  // milestone within a project (case-insensitive, matching resolver lookup),
  // else findMilestone's first-match semantics would silently pick one.
  target.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_milestones_project_canonical_short_id
    ON milestones(project_id, canonical_short_id COLLATE NOCASE)
    WHERE canonical_short_id IS NOT NULL;
  `);

  // ── milestones.canonical_short_id: corrective re-backfill, token-first ─────
  // The backfill above derived canonical_short_id source_id-first, so
  // Notion-synced milestones ended up keyed on their hex source_id while
  // gate_item.milestone / seed_item.milestone (and reconcileYamlMilestones,
  // and createMilestone) key on the M<n> token — the resolver never matched.
  // Recompute only rows this migration itself mis-populated (canonical_short_id
  // still equals source_id) where the name yields a token; token-less names
  // (MVP, hex-named milestones) keep their existing fallback untouched.
  // Migrations can't import app modules, so the token regex is duplicated
  // inline (matches extractMilestoneToken / shortMilestoneToken above).
  {
    const shortMilestoneToken = (name: string): string | null => {
      const match = /^([Mm]\d+[A-Za-z]?)(?=[\s—:-]|$)/.exec(name);
      return match ? match[1] : null;
    };
    const rows = target
      .prepare(
        `SELECT id, project_id, name, source_id, canonical_short_id FROM milestones
         WHERE source_id IS NOT NULL AND canonical_short_id = source_id`,
      )
      .all() as {
      id: string;
      project_id: string;
      name: string;
      source_id: string | null;
      canonical_short_id: string | null;
    }[];
    const update = target.prepare(
      `UPDATE milestones SET canonical_short_id = ? WHERE id = ?`,
    );
    const conflictCheck = target.prepare(
      `SELECT id FROM milestones
       WHERE project_id = ? AND id != ? AND canonical_short_id IS NOT NULL
         AND canonical_short_id = ? COLLATE NOCASE`,
    );
    for (const row of rows) {
      const token = shortMilestoneToken(row.name);
      if (!token) continue;
      const conflict = conflictCheck.get(row.project_id, row.id, token);
      if (conflict) {
        logger.warn(
          `[schema] milestone canonical_short_id re-backfill: skipping "${row.name}" (${row.id}) — token "${token}" already used by another milestone in project ${row.project_id}`,
        );
        continue;
      }
      update.run(token, row.id);
    }
  }

  // ── projects.arch_store_adopted: per-project dual-read flag ─────────────
  // A whole project flips to reading the arch_unit store at once — no
  // per-page split-brain. Default 0 (Notion fallback) until migrated.
  try {
    target.exec(
      `ALTER TABLE projects ADD COLUMN arch_store_adopted INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // ── sessions.granted_capabilities: durable per-session capability grants ──
  // Operator-approved grants (a Bash command prefix or named MCP write verb)
  // sticky for the session's life, discarded at session end. Rehydrated on
  // boot so a restart mid-session doesn't lose them. JSON array of strings.
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN granted_capabilities TEXT NOT NULL DEFAULT '[]'`,
    );
  } catch {
    /* already exists */
  }

  // gate_item_event.disposition: NOT NULL -> nullable. A dispositionless
  // event is a pure log entry (evidence appended, state left unchanged) —
  // see appendGateItemEvent's optional-disposition handling in gateService.ts.
  // SQLite can't ALTER a column's NOT NULL away, so recreate the table.
  {
    const getTableSql = (name: string): string =>
      (
        target
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name) as { sql: string } | undefined
      )?.sql ?? '';

    if (
      getTableSql('gate_item_event').includes('disposition    TEXT    NOT NULL')
    ) {
      target.exec(`
        BEGIN TRANSACTION;
        DROP TABLE IF EXISTS gate_item_event__new;
        CREATE TABLE gate_item_event__new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          gate_item_id   TEXT    NOT NULL,
          disposition    TEXT,
          evidence       TEXT,
          filed_followon TEXT,
          deploy_sha     TEXT,
          operator       TEXT,
          at             TEXT    NOT NULL,
          FOREIGN KEY (gate_item_id) REFERENCES gate_item(id) ON DELETE CASCADE
        );
        INSERT INTO gate_item_event__new (id, gate_item_id, disposition, evidence, filed_followon, deploy_sha, operator, at)
          SELECT id, gate_item_id, disposition, evidence, filed_followon, deploy_sha, operator, at
          FROM gate_item_event;
        DROP TABLE gate_item_event;
        ALTER TABLE gate_item_event__new RENAME TO gate_item_event;
        CREATE INDEX idx_gate_item_event_gate_item_id ON gate_item_event(gate_item_id);
        COMMIT;
      `);
    }
  }

  // pr_review_comment_disposition_replies: idempotency guard for
  // handleDispositions — records which (comment_id, disposition) replies have
  // already been posted to GitHub so a redelivered 'pending' comment can't
  // trigger a duplicate reply.
  target.exec(`
    CREATE TABLE IF NOT EXISTS pr_review_comment_disposition_replies (
      pr_number   INTEGER NOT NULL,
      repo        TEXT    NOT NULL,
      comment_id  TEXT    NOT NULL,
      disposition TEXT    NOT NULL,
      replied_at  INTEGER NOT NULL,
      PRIMARY KEY (pr_number, repo, comment_id, disposition)
    );
  `);

  // planning_checkout_locks dropped: the OS-level read-only checkout
  // lockdown it backed was reverted (recursive chmod is scoped to the OS,
  // not the session, so it stranded every concurrent consumer of a shared
  // checkout — see the 2026-07-27 revert). Forward-only drop; any rows
  // present at migration time are stale by definition now.
  target.exec(`
    DROP INDEX IF EXISTS idx_planning_checkout_locks_project_dir;
    DROP TABLE IF EXISTS planning_checkout_locks;
  `);

  // gate_accretion.reason: substantive reason recorded for a bare
  // 'none'/'n/a' gate_contribution decision — distinguishes an assessed
  // none (the groomer read the change and judged it has nothing
  // runtime-observable) from an unassessed one (the old accretion-as-
  // relocation behavior, where 'none' fell out of an empty input section).
  // Forward-only: existing rows get NULL (no reason on record for markers
  // written before this column existed).
  try {
    target.exec(`ALTER TABLE gate_accretion ADD COLUMN reason TEXT`);
  } catch {
    /* already exists */
  }

  // sessions.pending_done_*: a done-marking call that arrives while a
  // session's turn is still in flight (status='running') cannot write done
  // immediately without racing the in-flight turn's own terminal write — see
  // markSessionDone's in-flight guard. The transition is stashed here instead
  // and applied once the turn actually completes (SessionManager's wireSession
  // settle handler, plus a boot-time sweep for rows left pending across a
  // restart), so a deferred mark is never silently dropped.
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN pending_done_ended_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN pending_done_pr_url TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN pending_done_call_site TEXT`);
  } catch {
    /* already exists */
  }

  // sessions.pending_approve_terminal_at: an approve-driven terminal
  // transition (PlanningOrchestrator.handleApproveDisposition) that arrives
  // while the session's turn is still in flight (AgentSession.hasActiveTurn())
  // is deferred rather than applied immediately. The in-memory
  // pendingApproveTerminal Set that also tracks this is empty on a fresh
  // process, so this column is the durable copy a boot-time sweep
  // (SessionManager.resumeOrphanSessions) reads to apply any deferred
  // transition that never got its turn-boundary drain (result event or
  // session_ended) before a restart.
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN pending_approve_terminal_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
}
