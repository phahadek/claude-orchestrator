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
      compaction_count          INTEGER NOT NULL DEFAULT 0,
      effort                    TEXT,
      model_setting_key         TEXT,
      effort_setting_key        TEXT
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      event_type   TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
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
    CREATE INDEX IF NOT EXISTS idx_audit_log_project_task ON audit_log(project_id, task_id);

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

    CREATE TABLE IF NOT EXISTS orchestrator_analyze_content_cache (
      command       TEXT    NOT NULL,
      content_hash  TEXT    NOT NULL,
      passed        INTEGER NOT NULL,
      output        TEXT    NOT NULL DEFAULT '',
      ran_at        TEXT    NOT NULL,
      PRIMARY KEY (command, content_hash)
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

    CREATE TABLE IF NOT EXISTS capability_disqualification (
      id                     TEXT    PRIMARY KEY,
      project_id             TEXT    NOT NULL,
      capability             TEXT    NOT NULL,
      investigation_task_id  TEXT    NOT NULL,
      state                  TEXT    NOT NULL,
      created_at             TEXT    NOT NULL,
      resolved_at            TEXT,
      lifted_at              TEXT,
      updated_at             TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capability_disqualification_project ON capability_disqualification(project_id);
    CREATE INDEX IF NOT EXISTS idx_capability_disqualification_investigation_task ON capability_disqualification(investigation_task_id);

    CREATE TABLE IF NOT EXISTS gate_item (
      id                     TEXT    PRIMARY KEY,
      project                TEXT    NOT NULL,
      milestone              TEXT    NOT NULL,
      text                   TEXT    NOT NULL,
      classification         TEXT    NOT NULL,
      min_deployed_commit    TEXT,
      state                  TEXT    NOT NULL,
      current_disposition    TEXT,
      latest_disposition     TEXT,
      next_attempt_at        TEXT,
      pending_attempt_count  INTEGER NOT NULL DEFAULT 0,
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
      unattended     INTEGER,
      min_deployed_commit_at_fail TEXT,
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
      hard_stop_remaining_ms INTEGER,
      suspended              INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS convergence_snapshot (
      id                TEXT    PRIMARY KEY,
      project           TEXT    NOT NULL,
      milestone         TEXT    NOT NULL,
      ts                TEXT    NOT NULL,
      tasks_open        INTEGER NOT NULL,
      tasks_closed      INTEGER NOT NULL,
      gate_open         INTEGER NOT NULL,
      gate_closed       INTEGER NOT NULL,
      gate_parked       INTEGER NOT NULL DEFAULT 0,
      seed_open         INTEGER NOT NULL,
      seed_closed       INTEGER NOT NULL,
      ops_open          INTEGER NOT NULL,
      ops_closed        INTEGER NOT NULL,
      total_scope       INTEGER NOT NULL,
      distance_to_green INTEGER NOT NULL,
      status            TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_convergence_snapshot_project_milestone_ts
      ON convergence_snapshot(project, milestone, ts DESC);

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

    CREATE TABLE IF NOT EXISTS test_request_runs (
      id           TEXT    PRIMARY KEY,
      project_id   TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      state        TEXT    NOT NULL,
      output       TEXT    NOT NULL DEFAULT '',
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_test_request_runs_project_hash
      ON test_request_runs(project_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_test_request_runs_state
      ON test_request_runs(state);

    CREATE TABLE IF NOT EXISTS session_test_request_cycles (
      session_id TEXT    PRIMARY KEY,
      count      INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id ON session_events(session_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_event_type ON session_events(session_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_archived_started_at ON sessions(archived, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_notion_task_id_session_type ON sessions(task_id, session_type, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_task_id_pr_number ON pull_requests(task_id, pr_number DESC);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_state ON pull_requests(repo, state);
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

  // staged_intent.investigation: the file:line / arch-section / API-result
  // evidence a decision.pickOne intent's recommendation rests on, carried
  // separately from decision_proposal (which now stays at design altitude —
  // the named recommendation and its load-bearing reason). Forward-only:
  // existing rows get NULL and render exactly as before this column existed.
  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN investigation TEXT`);
  } catch {
    /* already exists */
  }

  // staged_intent.milestone: the milestone (canonical_short_id) the intent's
  // target task belongs to — populated at every stage path (dispatched
  // planning sessions, which know their milestone at dispatch, and the human
  // POST /staged-intents route). Legacy rows and intents whose task can't be
  // resolved to a milestone stay NULL, surfaced on the decision-inbox
  // ?milestone lens as the "unattributed" bucket — never dropped.
  // Forward-only: existing rows get NULL until best-effort backfilled (see
  // backfillStagedIntentMilestones in queries.ts, run once at boot).
  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN milestone TEXT`);
  } catch {
    /* already exists */
  }
  target.exec(`
    CREATE INDEX IF NOT EXISTS idx_staged_intent_project_milestone ON staged_intent(project_id, milestone);
  `);

  // staged_intent.applied_task_id: the id `applyIntent` minted for a
  // non-idempotent create-shaped kind (task.create / arch.createUnit) —
  // set unconditionally the instant the backend write succeeds, in the same
  // synchronous step, before the separate staged/approved -> committed state
  // transition is even attempted. That transition can lose a race against a
  // concurrent supersede of the still-staged row (see
  // AlreadyAppliedCreateSupersedeError's doc comment in stagedIntents.ts) and
  // never reach 'committed' even though the task already exists — leaving
  // `state` an unreliable signal for "has this create's side effect already
  // run". `applied_task_id` is the durable, race-proof answer to that
  // question, independent of whatever state the row ends up in. Forward-only:
  // existing rows get NULL.
  try {
    target.exec(`ALTER TABLE staged_intent ADD COLUMN applied_task_id TEXT`);
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

  // staged_intent.milestone: canonicalize pre-existing rows written before
  // stageIntent's caller-side resolveMilestoneForProject normalization
  // existed (see stagedIntents.milestoneNormalization.test.ts) — those rows
  // were keyed on whatever form the caller happened to pass (a milestone's
  // DB id/UUID, or its full display name) instead of the canonical short id
  // every read (listStagedIntentsByMilestone, the GET /staged-intents
  // ?milestone= route) matches on literally. Left uncanonicalized, such a
  // row is invisible to any caller that queries in a different form than it
  // was written in — the exact false-empty this migration closes. Runs after
  // the canonical_short_id backfills above so `m.canonical_short_id` is
  // populated. Matches a row's milestone value against the milestones table
  // (by id, or by name case-insensitively) scoped to the row's own
  // project_id — mirroring findMilestone in milestoneResolver.ts — and
  // rewrites it to COALESCE(canonical_short_id, name), i.e.
  // canonicalMilestoneKey. A value already in canonical form (or belonging
  // to no milestone the row's project knows about) matches nothing and is
  // left untouched — this is deliberate, not a gap: a NULL milestone is the
  // "unattributed" bucket's rows, handled separately by
  // backfillStagedIntentMilestones (queries.ts, task-id-based, run at every
  // boot) rather than this schema migration, and an unmatched non-NULL value
  // could belong to a deleted/renamed milestone that would be unsafe to
  // guess at. Idempotent: a row already canonical produces no EXISTS match
  // on a second run.
  target.exec(`
    UPDATE staged_intent
    SET milestone = (
      SELECT COALESCE(m.canonical_short_id, m.name)
      FROM milestones m
      WHERE m.project_id = staged_intent.project_id
        AND (m.id = staged_intent.milestone
             OR m.name = staged_intent.milestone COLLATE NOCASE)
      LIMIT 1
    )
    WHERE milestone IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM milestones m
        WHERE m.project_id = staged_intent.project_id
          AND (m.id = staged_intent.milestone
               OR m.name = staged_intent.milestone COLLATE NOCASE)
      );
  `);

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

  // gate_item_event.unattended: distinguishes a fully-unattended reconciler
  // auto-launch pass from an operator-triggered manual dispatch — both write
  // through the same appendGateItemEvent path (gateReconciler.ts's
  // processItem / dispatchGateItemVerification) and were previously
  // indistinguishable in the event log. 1 = auto-launched with zero human
  // involvement, 0 = manual dispatch, NULL = not a verifier-originated event
  // (pre-existing rows, or an operator/system event with no dispatch mode).
  try {
    target.exec(`ALTER TABLE gate_item_event ADD COLUMN unattended INTEGER`);
  } catch {
    /* already exists */
  }

  // pull_requests.human_merge_only: the docs execution flow's never-auto-merged
  // output gate for repo-file docs PRs — set at PR-open time by the /docs
  // skill's dispatch path. Excluded from auto-merge at getApprovedOpenPRs
  // (the periodic sweep query) AND independently at AutoMerger's actual
  // merge-attempt choke point (attempt()), since attempt() is also invoked
  // directly by callers that bypass getApprovedOpenPRs entirely (see
  // AutoMerger.ts). Waits indefinitely for a human to merge — never stalled,
  // orphaned, nudged, or escalated by the sweepers.
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN human_merge_only INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // flow_arm: per-(milestone, flow) auto-dispatch arm state. Absent row
  // means "use the flow's DEFAULT_ARM" (see orchestration/flowArm.ts) —
  // this migration creates the empty table only, no seeded rows.
  // Orphan-tolerant by design (no FK to milestones): the read path already
  // defaults on an absent row, so a stale milestone_id is harmless and
  // arming can't be blocked by milestone sync ordering.
  target.exec(`
    CREATE TABLE IF NOT EXISTS flow_arm (
      milestone_id TEXT    NOT NULL,
      flow         TEXT    NOT NULL,
      armed        INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (milestone_id, flow)
    );
  `);

  // milestones.wrapped_at: nullable Done marker, set once /milestone-wrap
  // closes out a milestone. Convergence and the milestone list read filter
  // wrapped_at IS NULL to scope to active + in-planning milestones — the
  // non-Done scope rule.
  try {
    target.exec(`ALTER TABLE milestones ADD COLUMN wrapped_at INTEGER`);
  } catch {
    /* already exists */
  }

  // stuck_session_timers.suspended: true while notify/pause are cancelled
  // for a code session's PR review (pr_created / push_detected), so that
  // an activity-based reset (session_event) does not re-arm timers a
  // review verdict hasn't yet asked to resume.
  try {
    target.exec(
      `ALTER TABLE stuck_session_timers ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // usage_deferral: global (account-wide, not per-session-type) admission
  // gate state for the plan-usage five_hour/seven_day windows. A row means
  // "do not launch/resume/dispatch until deferred_until" — populated from
  // the poller's resets_at when a window is observed exhausted, and
  // persisted so a deferral survives a backend restart (in-memory-only
  // state would otherwise resume the relaunch loop after any restart
  // during the deferral window).
  target.exec(`
    CREATE TABLE IF NOT EXISTS usage_deferral (
      window          TEXT    PRIMARY KEY,
      deferred_until  INTEGER NOT NULL,
      recorded_at     INTEGER NOT NULL
    );
  `);

  // Wedged-group-recovery backfill: before this migration, a grouped member
  // stuck in needs_revision/pending_verification had no route off that
  // state — commitGroupIntents refuses any group containing one, and
  // nothing could move it to `rejected`. This declines every such member
  // outright (the same exit routes/stagedIntents.ts now exposes going
  // forward per-member and per-group), never touching a live
  // (staged/approved) sibling, so a group still doing live work keeps that
  // work untouched — only its non-live blocked member is retired. Also
  // scrubs the specific self-referential failure mode observed live: a
  // prior pushback that recorded the commit guard's own 409 refusal text as
  // disposition_reason, which destroyed the record of why the member was
  // actually blocked. Runs on every startup; idempotent — once no row is
  // left in either state, the UPDATE matches nothing.
  target.exec(`
    UPDATE staged_intent
    SET state = 'rejected',
        disposition_reason = CASE
          WHEN disposition_reason IS NULL OR trim(disposition_reason) = '' THEN
            'Auto-resolved by migration: this member was blocked with no operator-usable route to disposition it.'
          WHEN disposition_reason LIKE '%it must be recovered or resolved before this group can commit%' THEN
            'Auto-resolved by migration: the previously recorded reason was the commit-refusal message itself, not a real disposition reason.'
          ELSE disposition_reason
        END,
        updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE group_id IS NOT NULL AND state IN ('needs_revision', 'pending_verification');
  `);

  // gate_item.latest_disposition: the disposition carried by an item's most
  // recent event, regardless of whether that event advanced state. Before
  // this column, a non-terminal disposition (needs-setup, noted) was a pure
  // log entry — recorded in gate_item_event but invisible on the item's
  // denormalized row, byte-identical to an item that was never dispatched
  // for verification at all. Backfilled from each item's most recent event
  // (ordered by id, i.e. insertion order) so pre-existing rows are
  // trustworthy too, not just events appended after this migration.
  try {
    target.exec(`ALTER TABLE gate_item ADD COLUMN latest_disposition TEXT`);
  } catch {
    /* already exists */
  }
  target.exec(`
    UPDATE gate_item
    SET latest_disposition = (
      SELECT e.disposition
      FROM gate_item_event e
      WHERE e.gate_item_id = gate_item.id AND e.disposition IS NOT NULL
      ORDER BY e.id DESC
      LIMIT 1
    )
    WHERE latest_disposition IS NULL
      AND EXISTS (
        SELECT 1 FROM gate_item_event e
        WHERE e.gate_item_id = gate_item.id AND e.disposition IS NOT NULL
      );
  `);

  // gate_item.next_attempt_at / pending_attempt_count: the `pending` state's
  // backoff schedule. next_attempt_at is the earliest time the item is
  // eligible for its next not-yet-triggerable re-check (NULL once the item
  // leaves pending); pending_attempt_count is the number of consecutive
  // not-yet-triggerable results so far, driving the doubling backoff (3h,
  // 6h, 12h, ... capped at 168h). Pre-existing rows never entered `pending`,
  // so no backfill beyond the column defaults is needed.
  try {
    target.exec(`ALTER TABLE gate_item ADD COLUMN next_attempt_at TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE gate_item ADD COLUMN pending_attempt_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // sessions.terminal_completion_reason: durable copy of the `reason` string
  // PlanningOrchestrator.markTerminal already threads through to
  // markSessionDone's `callSite` argument (previously log/audit-only). Read
  // by the ops-journal route's deferred close: the operator-confirmed
  // applied-pending-confirm -> resolved transition happens well after the
  // session has gone terminal, so completeOpsTask's synchronous check
  // misses it — the route needs a durable, queryable record of *why* the
  // session ended to decide whether to close the task itself.
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN terminal_completion_reason TEXT`,
    );
  } catch {
    /* already exists */
  }

  // Backfill audit_log.project_id for historical rows written before
  // recordEvent (audit/AuditLog.ts) started deriving it from actor_id/task_id
  // — otherwise every project-scoped auditLog.query silently drops them.
  // Only ever touches rows still NULL, so this is safe to re-run.
  target.exec(`
    UPDATE audit_log
    SET project_id = (
      SELECT sessions.project_id FROM sessions
      WHERE sessions.session_id = audit_log.actor_id
    )
    WHERE project_id IS NULL
      AND actor_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM sessions
        WHERE sessions.session_id = audit_log.actor_id
          AND sessions.project_id IS NOT NULL
      );
  `);
  target.exec(`
    UPDATE audit_log
    SET project_id = (
      SELECT task_repo_assignments.project_id FROM task_repo_assignments
      WHERE task_repo_assignments.task_id = audit_log.task_id
    )
    WHERE project_id IS NULL
      AND task_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM task_repo_assignments
        WHERE task_repo_assignments.task_id = audit_log.task_id
      );
  `);

  // gate_item_event.min_deployed_commit_at_fail: stamped server-side (in
  // gateStore.appendEvent) at write time for a `fail` disposition, from the
  // item's own min_deployed_commit — never trusted from client-supplied
  // evidence, which the /gate skill documents as a plain string and can't be
  // relied on to carry this. reconcileGateRunnability's auto-reopen reads
  // this column (via minDeployedCommitAtLastFail) instead of parsing
  // evidence, so a fail only auto-reopens once min_deployed_commit has
  // genuinely advanced past its value at fail-time.
  try {
    target.exec(
      `ALTER TABLE gate_item_event ADD COLUMN min_deployed_commit_at_fail TEXT`,
    );
  } catch {
    /* already exists */
  }

  // Cache-token spend, captured with overwrite/SET semantics mirroring
  // context_occupancy_tokens — the usage payload's cache figures are
  // cumulative-per-turn, not per-turn deltas. Rows written before this
  // migration default to 0, which is what distinguishes pre-migration from
  // post-migration cache spend in analytics.
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // pull_requests.pr_intent_id: the approved ops.prIntent (staged_intent.id)
  // this PR was opened for — the Ops rubric's pointer to the operator-approved
  // "here's the diff scope and why" declaration PRReviewService resolves at
  // review time in place of a task-body Files/paths section. Set once, at
  // PR-open time, via db/queries.ts's linkPRToPRIntent, which enforces that
  // one approved PR-intent authorizes exactly one PR (fire-once) — a second
  // PR row claiming the same intent id is rejected there rather than at the
  // schema level, since SQLite has no partial-unique-except-null shorthand
  // that also produces an actionable error message.
  try {
    target.exec(`ALTER TABLE pull_requests ADD COLUMN pr_intent_id TEXT`);
  } catch {
    /* already exists */
  }

  // seed_item.classification: mirrors gate_item's classification column, but
  // nullable/optional — unlike gate_item's NOT NULL classification, existing
  // seed_item rows predate this concept and a caller that hasn't started
  // passing it yet (groomGate.ts's seedContributionCandidates fails open the
  // same way) should not be broken by its absence.
  try {
    target.exec(`ALTER TABLE seed_item ADD COLUMN classification TEXT`);
  } catch {
    /* already exists */
  }

  // ── audit_finding_dedup: scheduled base-branch dependency/license-audit
  // sweep's dedup record ──────────────────────────────────────────────────
  // One row per (project, finding-identity) currently covered by a filed
  // dep-bump task. finding_identity is the advisory id (GHSA/npm advisory
  // number) for a dependency-vulnerability finding, or
  // "<package>@<version>:<license>" for a license finding. The record only
  // suppresses re-filing while task_id remains open (not Done) — the sweep
  // re-checks the referenced task's live status before treating a hit as
  // "already covered", so a closed task's row is stale rather than binding.
  target.exec(`
    CREATE TABLE IF NOT EXISTS audit_finding_dedup (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id     TEXT    NOT NULL,
      finding_identity TEXT  NOT NULL,
      task_id        TEXT    NOT NULL,
      filed_at       TEXT    NOT NULL,
      UNIQUE(project_id, finding_identity)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_finding_dedup_project_identity
      ON audit_finding_dedup(project_id, finding_identity);
  `);

  // Non-blocking `pending` (parked) gate-item count, alongside the existing
  // open/closed split — never subtracted from gate_open, since parked items
  // don't count toward blocking/green status.
  try {
    target.exec(
      `ALTER TABLE convergence_snapshot ADD COLUMN gate_parked INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // Resolved effort level used at session launch (e.g. "high") — nullable
  // for historical rows launched before this column existed.
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN effort TEXT`);
  } catch {
    /* already exists */
  }

  // sessions.terminalized_at: written only at a genuine terminal transition
  // (status -> done/error/killed), never on a non-terminal write that
  // happens to also touch ended_at (e.g. the deferred-while-running path).
  // ended_at's semantics are left unchanged for backwards compatibility —
  // this is a separate, additive column so "was this session terminal at
  // time T" can be answered directly. NULL for historical rows; backfill is
  // out of scope.
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN terminalized_at INTEGER`);
  } catch {
    /* already exists */
  }

  // Which settings key (e.g. "groom_session_model") the session's model/effort
  // were actually resolved from — dedicated key vs. shared fallback — so
  // provenance is recoverable even when the resolved values happen to match.
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN model_setting_key TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN effort_setting_key TEXT`);
  } catch {
    /* already exists */
  }

  // depth_review_verdicts: durable record of each PR's latest depth-review
  // pass (the second, post-conformance review dispatched by
  // ReviewOrchestrator.dispatchDepthReview) — separate from
  // pull_requests.review_result, which carries only the conformance verdict.
  // Keyed on (pr_number, repo) so "this PR's latest depth verdict" is a
  // single-row read; a re-run overwrites the prior row rather than
  // accumulating history.
  target.exec(`
    CREATE TABLE IF NOT EXISTS depth_review_verdicts (
      pr_number        INTEGER NOT NULL,
      repo             TEXT    NOT NULL,
      head_sha         TEXT,
      verdict          TEXT    NOT NULL,
      dimensions       TEXT    NOT NULL,
      summary          TEXT    NOT NULL,
      depth_session_id TEXT,
      recorded_at      TEXT    NOT NULL,
      route_count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pr_number, repo)
    );
  `);
  // route_count: how many times a depth finding has been routed to the
  // implementing session on an unchanged head SHA — bounds re-routing (see
  // ReviewOrchestrator.dispatchDepthReview). Added after the table's initial
  // creation, so existing rows need the column backfilled.
  try {
    target.exec(
      `ALTER TABLE depth_review_verdicts ADD COLUMN route_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  // Normalized test-result JSON (junit-xml parse), populated by the
  // acquisition/parser follow-on — nullable, defaults to NULL for existing rows.
  try {
    target.exec(
      `ALTER TABLE test_request_runs ADD COLUMN structured_result TEXT`,
    );
  } catch {
    /* already exists */
  }

  // investigation_report: closed-vocabulary state (draft/committed/resolved/
  // abandoned) — no persisted 'dispatched' state. In-flight status is a
  // derived live read from investigation_report_dispatch (mirrors gate_item's
  // verifyInFlight). milestone_id stores milestones.id (a UUID), matching
  // flow_arm.milestone_id — NOT the gate_item/seed_item display-name form.
  // evidence_text and the source/origin_* provenance columns are unused
  // until the sibling session-filing capability lands, shipped now to avoid
  // a later migration.
  target.exec(`
    CREATE TABLE IF NOT EXISTS investigation_report (
      id                TEXT    PRIMARY KEY,
      project_id        TEXT    NOT NULL,
      milestone_id      TEXT    NOT NULL,
      title             TEXT    NOT NULL,
      symptom_text      TEXT    NOT NULL,
      evidence_text     TEXT,
      state             TEXT    NOT NULL DEFAULT 'draft',
      source            TEXT    NOT NULL DEFAULT 'operator',
      origin_session_id TEXT,
      origin_task_id    TEXT,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_investigation_report_project_milestone
      ON investigation_report(project_id, milestone_id);

    CREATE TABLE IF NOT EXISTS investigation_report_dispatch (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id   TEXT    NOT NULL,
      session_id  TEXT    NOT NULL,
      dispatched_at TEXT  NOT NULL,
      FOREIGN KEY (report_id) REFERENCES investigation_report(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_investigation_report_dispatch_report_id
      ON investigation_report_dispatch(report_id);
    CREATE INDEX IF NOT EXISTS idx_investigation_report_dispatch_session_id
      ON investigation_report_dispatch(session_id);
  `);

  // test_request_runs: link each run back to the originating session, carry
  // a requestedAt captured before admission/semaphore queueing can delay a
  // run's started_at, and record a failure sub-reason distinguishing timeout
  // vs OOM-kill vs generic non-zero-exit — see testRequestLane.ts. All
  // nullable: historical rows predate these columns.
  try {
    target.exec(`ALTER TABLE test_request_runs ADD COLUMN session_id TEXT`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE test_request_runs ADD COLUMN requested_at INTEGER`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE test_request_runs ADD COLUMN failure_reason TEXT`,
    );
  } catch {
    /* already exists */
  }
}
