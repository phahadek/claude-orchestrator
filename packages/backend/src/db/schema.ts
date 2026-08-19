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

    -- Short-lived ledger of the most recent status a write-path applied to a
    -- task, keyed independently of task_cache so a stale bulk board fetch
    -- (NotionClient's own board-level cache, or a TaskCacheRefresher poll
    -- racing an in-flight status write) can be reconciled against the value
    -- we know we just wrote, rather than silently clobbering it.
    CREATE TABLE IF NOT EXISTS task_status_writes (
      task_id    TEXT    PRIMARY KEY,
      status     TEXT    NOT NULL,
      written_at INTEGER NOT NULL
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

    -- session_poke_retry_counts: persisted counter of consecutive failed
    -- poke/resume attempts on the sendOrResume/_doSendOrResume live path
    -- (SessionManager.ts), keyed per session_id (not per task, unlike
    -- task_crash_counts) since a poke targets a specific session. Reset on
    -- a successful poke; once consecutive_failures reaches the retry limit
    -- the session is routed to flagResumeFailure instead of being retried.
    CREATE TABLE IF NOT EXISTS session_poke_retry_counts (
      session_id           TEXT    PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_at      INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS dependency_cache_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   TEXT    NOT NULL,
      lock_hash    TEXT    NOT NULL,
      status       TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      UNIQUE(project_id, lock_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_dependency_cache_entries_status
      ON dependency_cache_entries(status);

    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_id ON session_events(session_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_event_type ON session_events(session_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp DESC);
    -- Covers getSessionLastActivityMs's MAX(timestamp) WHERE session_id = ?
    -- lookup so it resolves as a reverse index seek instead of one table
    -- B-tree seek per event in the session.
    CREATE INDEX IF NOT EXISTS idx_session_events_session_id_timestamp ON session_events(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_archived_started_at ON sessions(archived, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_notion_task_id_session_type ON sessions(task_id, session_type, started_at DESC);
    -- Backs getLatestOpsSessionByTaskId's session_type-scoped scan: task_id
    -- there is matched via normalizeBoardId in JS (ops_journal keys on the
    -- bare board id while sessions.task_id is source-prefixed), so the SQL
    -- layer can only pre-filter on session_type — this index keeps that scan
    -- to just the ops-typed rows instead of the whole sessions table.
    CREATE INDEX IF NOT EXISTS idx_sessions_session_type_started_at ON sessions(session_type, started_at DESC);
    -- Backs getStuckResultSessionRows's WHERE s.status = 'running' filter,
    -- which otherwise full-scans sessions and runs a correlated
    -- session_events subquery per row. Plain (not partial on
    -- status='running') because getSessionsByStatus takes an arbitrary
    -- status list and benefits from the general form.
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_task_id_pr_number ON pull_requests(task_id, pr_number DESC);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_state ON pull_requests(repo, state);
    -- Covers getPRBySessionId's WHERE session_id = ? lookup, which otherwise
    -- scans the table. Cheap today (2.3k rows) but the same defect class as
    -- the test_run_results index above, on a table that also only grows.
    CREATE INDEX IF NOT EXISTS idx_pull_requests_session_id ON pull_requests(session_id);
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
        CREATE INDEX idx_session_events_session_id_timestamp ON session_events(session_id, timestamp);
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
  // stalled_retry_base_exhausted / flake_recovery_base_exhausted: set when a
  // PR's most recent stalled_pr_retry_count / flake_recovery_attempts
  // exhaustion was confirmed base-attributable (see baseAttribution.ts) —
  // the sole scoping signal the base-recovery reset trigger consults, so
  // recovery never blanket-resets every open PR's counter.
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN stalled_retry_base_exhausted INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE pull_requests ADD COLUMN flake_recovery_base_exhausted INTEGER NOT NULL DEFAULT 0`,
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
    -- Covers the session-scoped reads on the decision surface's hot path
    -- (listStagedIntentsBySession, hasBlockedStagedIntentForSession,
    -- hasActiveStagedIntentForSession via isSessionComplete) which otherwise
    -- fall back to a bare SCAN staged_intent. state is the second column so
    -- the two state-filtered probes (LIMIT 1 lookups) are answered from the
    -- index alone.
    CREATE INDEX IF NOT EXISTS idx_staged_intent_session_id ON staged_intent(session_id, state);

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
      project       TEXT    NOT NULL,
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

  // ── arch_unit.project: project-scope the previously-global store ────────
  // arch_unit carried no project column, so every active invariant was
  // injected into every archStoreAdopted project's sessions regardless of
  // which project authored it. Backfill: rows regioned under
  // src/polimarket_analyser/ are polimarket-analyser's; three rows a region
  // glob can't classify (concept-token or abbreviated-path regions) are
  // assigned explicitly by title; every remaining row is the orchestrator's
  // own (claude-dashboard) — the only other project that had authored into
  // the store as of this migration.
  try {
    target.exec(`ALTER TABLE arch_unit ADD COLUMN project TEXT`);
  } catch {
    /* already exists */
  }
  {
    target.exec(`
      UPDATE arch_unit
      SET project = 'polimarket-analyser'
      WHERE project IS NULL
        AND EXISTS (
          SELECT 1 FROM json_each(arch_unit.regions) AS r
          WHERE r.value LIKE 'src/polimarket_analyser/%'
        );
    `);
    target.exec(`
      UPDATE arch_unit
      SET project = 'claude-dashboard'
      WHERE project IS NULL
        AND title IN (
          'Planning Session Filesystem Isolation',
          'Deploy report-in''s credential is engine-owned, not playbook-authored'
        );
    `);
    target.exec(`
      UPDATE arch_unit SET project = 'claude-dashboard' WHERE project IS NULL;
    `);

    const getArchUnitTableSql = (): string =>
      (
        target
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='arch_unit'",
          )
          .get() as { sql: string } | undefined
      )?.sql ?? '';

    if (!/project\s+TEXT\s+NOT NULL/.test(getArchUnitTableSql())) {
      target.exec(`
        BEGIN TRANSACTION;
        DROP TABLE IF EXISTS arch_unit__new;
        CREATE TABLE arch_unit__new (
          id            TEXT    PRIMARY KEY,
          project       TEXT    NOT NULL,
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
        INSERT INTO arch_unit__new
          (id, project, title, kind, topic, regions, status, body, supersedes, superseded_by, version, created_at, updated_at)
          SELECT id, project, title, kind, topic, regions, status, body, supersedes, superseded_by, version, created_at, updated_at
          FROM arch_unit;
        DROP TABLE arch_unit;
        ALTER TABLE arch_unit__new RENAME TO arch_unit;
        CREATE INDEX idx_arch_unit_topic ON arch_unit(topic);
        CREATE INDEX idx_arch_unit_kind ON arch_unit(kind);
        CREATE INDEX idx_arch_unit_status ON arch_unit(status);
        CREATE INDEX idx_arch_unit_project ON arch_unit(project);
        COMMIT;
      `);
    }

    target.exec(
      `CREATE INDEX IF NOT EXISTS idx_arch_unit_project ON arch_unit(project)`,
    );
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
  // task_repo_assignments is only ever populated for multi-repo projects
  // (an explicit human assign-repo action) — single-repo projects never
  // write a row there, so the backfill above misses effectively every
  // single-repo task_id. sessions.task_id + sessions.project_id are
  // populated unconditionally for every dispatched session, so it's tried
  // next to cover the rows the assignment-table backfill can't reach.
  target.exec(`
    UPDATE audit_log
    SET project_id = (
      SELECT sessions.project_id FROM sessions
      WHERE sessions.task_id = audit_log.task_id
        AND sessions.project_id IS NOT NULL
      ORDER BY sessions.started_at DESC LIMIT 1
    )
    WHERE project_id IS NULL
      AND task_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM sessions
        WHERE sessions.task_id = audit_log.task_id
          AND sessions.project_id IS NOT NULL
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_investigation_report_dispatch_unique
      ON investigation_report_dispatch(report_id, session_id);
  `);

  // investigation_report.milestone_id: canonicalize pre-existing rows written
  // before createReport/updateDraftReport's resolveMilestoneRowForProject
  // normalization existed — the operator intake (InvestigationReportSection)
  // posted the gate_item/seed_item display-name form straight through, while
  // the column is designed to hold the milestones.id UUID (matching
  // flow_arm.milestone_id). Left uncanonicalized, such a row is invisible to
  // every UUID-keyed reader (convergenceService's investigationReport axis,
  // investigationReconciler's getArm lookup) — the exact false-green /
  // never-armed class this migration closes. Matches a row's milestone_id
  // against the milestones table (by id, by exact name, or by canonical
  // short id case-insensitively) scoped to the row's own project_id —
  // mirroring findMilestone in milestoneResolver.ts — and rewrites it to
  // the matched milestone's UUID. Idempotent: once milestone_id already
  // equals a milestones.id, the same subquery resolves to that same id on a
  // re-run, a no-op update.
  target.exec(`
    UPDATE investigation_report
    SET milestone_id = (
      SELECT m.id
      FROM milestones m
      WHERE m.project_id = investigation_report.project_id
        AND (m.id = investigation_report.milestone_id
             OR m.name = investigation_report.milestone_id
             OR COALESCE(m.canonical_short_id, m.name) = investigation_report.milestone_id COLLATE NOCASE)
      LIMIT 1
    )
    WHERE milestone_id IS NOT NULL
      AND milestone_id != ''
      AND EXISTS (
        SELECT 1 FROM milestones m
        WHERE m.project_id = investigation_report.project_id
          AND (m.id = investigation_report.milestone_id
               OR m.name = investigation_report.milestone_id
               OR COALESCE(m.canonical_short_id, m.name) = investigation_report.milestone_id COLLATE NOCASE)
      );
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
    target.exec(`ALTER TABLE test_request_runs ADD COLUMN failure_reason TEXT`);
  } catch {
    /* already exists */
  }

  // concurrent_run_count: the number of *other* runs the per-project
  // Semaphore had in flight at admission (this run's own slot excluded),
  // captured immediately before the run is inserted, see
  // testRequestLane.ts — not inferred later. 0 means "ran alone", which is
  // what the concurrent_run_count = 0 validity predicate downstream
  // consumers filter on. Nullable for pre-existing rows.
  try {
    target.exec(
      `ALTER TABLE test_request_runs ADD COLUMN concurrent_run_count INTEGER`,
    );
  } catch {
    /* already exists */
  }
  // oom_killed: copied from TestCommandResult.oomKilled at completion time —
  // previously discarded by completeTestRequestRun.
  try {
    target.exec(
      `ALTER TABLE test_request_runs ADD COLUMN oom_killed INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }

  // test_run_results: one row per test, extracted from a completed run's
  // structured_result (suites[].tests[]) — see testRequestLane.ts's
  // ingestTestRunResults. concurrent_run_count/oom_killed/project_id are
  // denormalized from the parent test_request_runs row onto every extracted
  // test row so per-test validity queries and project-scoped scans never
  // need a join. Extraction is idempotent: a run with any existing
  // test_run_results rows is treated as already ingested (see
  // hasTestRunResults), and all rows for a run are inserted in a single
  // transaction so a crash mid-ingestion never leaves a partial set.
  target.exec(`
    CREATE TABLE IF NOT EXISTS test_run_results (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      test_request_run_id  TEXT    NOT NULL,
      project_id           TEXT    NOT NULL DEFAULT '',
      test_id              TEXT    NOT NULL,
      name                 TEXT    NOT NULL,
      outcome              TEXT    NOT NULL,
      duration_ms          INTEGER NOT NULL,
      concurrent_run_count INTEGER,
      oom_killed           INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      FOREIGN KEY (test_request_run_id) REFERENCES test_request_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_test_run_results_run_id
      ON test_run_results(test_request_run_id);
    CREATE INDEX IF NOT EXISTS idx_test_run_results_created_at
      ON test_run_results(created_at);
    -- Covers the two per-test_id reads ingestTestRunResults runs for EVERY
    -- test in a completed run (computeTestPerfBaseline and
    -- computeTestFlipRateFlag, ~9.5k tests per run here). Without this both
    -- fall back to walking idx_test_run_results_created_at and filtering,
    -- so each lookup scales with the whole table: measured at 52 ms each on
    -- 134,951 rows, i.e. ~17 minutes of synchronous main-thread work after
    -- every test run, lengthening by ~7% per run as the table grows.
    -- created_at is the second column so it also serves both queries'
    -- ORDER BY created_at DESC without a temp B-tree.
    CREATE INDEX IF NOT EXISTS idx_test_run_results_test_id_created_at
      ON test_run_results(test_id, created_at DESC);
  `);

  // Idempotent: project_id column for pre-existing test_run_results tables
  // created before this migration (fresh installs already get it from the
  // CREATE TABLE above). Population of rows written before this migration
  // happens in the guarded backfill below, once schema_backfills exists.
  try {
    target.exec(
      `ALTER TABLE test_run_results ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`,
    );
  } catch {
    /* already exists */
  }
  // Replaces the getFlakyRollupCandidates/getCandidates join through
  // test_request_runs with a direct project-scoped range scan — see the
  // comment above those functions in queries.ts/flakyTestRollupWorker.ts.
  target.exec(`
    CREATE INDEX IF NOT EXISTS idx_test_run_results_project_id_id
      ON test_run_results(project_id, id);
  `);

  // ── concurrent_run_count producer/consumer backfill (one-time, guarded via
  // schema_backfills) ─────────────────────────────────────────────────────
  // Every row written before this migration stored semaphore occupancy
  // *including* the run itself (testRequestLane.ts's old behavior), so a
  // solo run's row held 1, never 0 — the concurrent_run_count = 0 validity
  // predicate downstream consumers filter on (listRecentValidTestDurations,
  // computeTestFlipRateFlag) matched nothing. The producer now records peer
  // occupancy excluding self; existing non-null values need the same
  // correction (old_value - 1) applied once. A WHERE-column-IS-NULL guard
  // doesn't work here (the column is already populated), so a marker row in
  // this schema-owned table (not the app-level `settings` store, whose
  // emptiness on a fresh DB other tests — e.g. setupTestDb.test.ts — depend
  // on) records completion instead — decrementing an already-corrected value
  // a second time would drive it negative.
  target.exec(`
    CREATE TABLE IF NOT EXISTS schema_backfills (
      name        TEXT    PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);
  {
    const marker = target
      .prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`)
      .get('concurrent_run_count_v1');
    if (!marker) {
      target.exec(`
        UPDATE test_request_runs
        SET concurrent_run_count = concurrent_run_count - 1
        WHERE concurrent_run_count IS NOT NULL;

        UPDATE test_run_results
        SET concurrent_run_count = concurrent_run_count - 1
        WHERE concurrent_run_count IS NOT NULL;
      `);
      target
        .prepare(
          `INSERT INTO schema_backfills (name, applied_at) VALUES (?, ?)`,
        )
        .run('concurrent_run_count_v1', Date.now());
    }
  }

  // ── test_run_results.project_id backfill (one-time, guarded via
  // schema_backfills) ─────────────────────────────────────────────────────
  // Rows written before this migration have project_id = '' (the column's
  // DEFAULT, not the app-level "unknown project" marker), so a plain
  // WHERE-column-IS-NULL guard doesn't distinguish "not backfilled yet" from
  // a legitimately-backfilled-but-empty value — same rationale as
  // concurrent_run_count_v1 above. Joins through test_request_runs exactly
  // once, here, rather than on every guard-query tick going forward.
  {
    const marker = target
      .prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`)
      .get('test_run_results_project_id_v1');
    if (!marker) {
      target.exec(`
        UPDATE test_run_results
        SET project_id = (
          SELECT r.project_id FROM test_request_runs r
          WHERE r.id = test_run_results.test_request_run_id
        )
        WHERE project_id = '';
      `);
      target
        .prepare(
          `INSERT INTO schema_backfills (name, applied_at) VALUES (?, ?)`,
        )
        .run('test_run_results_project_id_v1', Date.now());
    }
  }

  // test_perf_baselines: one row per test_id holding the current rolling
  // median/MAD baseline — see computeTestPerfBaseline in testRequestLane.ts.
  // Recomputed (not appended) on every ingestion that touches the test_id, so
  // this survives test_run_results pruning independently of the raw rows it
  // was derived from.
  target.exec(`
    CREATE TABLE IF NOT EXISTS test_perf_baselines (
      test_id             TEXT    PRIMARY KEY,
      median_duration_ms  REAL    NOT NULL,
      mad_duration_ms     REAL    NOT NULL,
      sample_count        INTEGER NOT NULL,
      last_duration_ms    INTEGER NOT NULL,
      is_regressed        INTEGER NOT NULL DEFAULT 0,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_test_perf_baselines_is_regressed
      ON test_perf_baselines(is_regressed);
  `);

  // test_perf_baselines digest extension (dig-test-results-at-ingest task):
  // project_id/name let this table serve as the sole per-test read surface
  // (getRegressedTestsForProject, the flip-rate rollup candidate scan) once
  // test_run_results stops carrying a row for every passing test — this
  // table no longer has a reliable join partner for scoping/naming.
  // recent_outcomes/recent_durations are the bounded digest itself: JSON
  // arrays, newest-last, capped at TEST_OUTCOME_DIGEST_CAPACITY /
  // TEST_DURATION_DIGEST_CAPACITY (queries.ts) on every write — see
  // recordTestPerfDigestSample. updated_at (existing column) doubles as the
  // digest's own append-order watermark: recordTestPerfDigestSample assigns
  // it a strictly-increasing value per ingested test (never a plain
  // Date.now() call from a different writer), so the flip-rate rollup
  // candidate scan can page on (updated_at, test_id) instead of on
  // test_run_results.id like it used to.
  for (const columnDdl of [
    `ALTER TABLE test_perf_baselines ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE test_perf_baselines ADD COLUMN name TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE test_perf_baselines ADD COLUMN recent_outcomes TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE test_perf_baselines ADD COLUMN recent_durations TEXT NOT NULL DEFAULT '[]'`,
  ]) {
    try {
      target.exec(columnDdl);
    } catch {
      /* already exists */
    }
  }
  target.exec(`
    CREATE INDEX IF NOT EXISTS idx_test_perf_baselines_project_updated
      ON test_perf_baselines(project_id, updated_at, test_id);
  `);

  // test_run_summaries: one row per test_request_run holding outcome counts
  // and total duration for the run — the replacement for enumerating every
  // test_run_results row of a run now that only non-passing outcomes get a
  // row there. Written once per run, in the same transaction as the raw
  // failure rows and the test_perf_baselines digest updates (see
  // ingestTestRunResultsTx in queries.ts), so it doubles as the extraction
  // idempotency/existence marker that hasTestRunResults used to serve —
  // required because an all-passing run now writes zero test_run_results
  // rows, so that table can no longer answer "was this run already
  // extracted".
  target.exec(`
    CREATE TABLE IF NOT EXISTS test_run_summaries (
      test_request_run_id  TEXT    PRIMARY KEY,
      project_id           TEXT    NOT NULL,
      passed_count         INTEGER NOT NULL DEFAULT 0,
      failed_count         INTEGER NOT NULL DEFAULT 0,
      skipped_count        INTEGER NOT NULL DEFAULT 0,
      error_count          INTEGER NOT NULL DEFAULT 0,
      other_count          INTEGER NOT NULL DEFAULT 0,
      total_count          INTEGER NOT NULL,
      total_duration_ms    INTEGER NOT NULL,
      concurrent_run_count INTEGER,
      oom_killed           INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      FOREIGN KEY (test_request_run_id) REFERENCES test_request_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_test_run_summaries_project_created
      ON test_run_summaries(project_id, created_at);
  `);

  // flagged_flaky_tests_rollup: one row per (project_id, test_id) currently
  // flagged by computeTestFlipRateFlag — see listFlaggedFlakyTests/
  // replaceFlaggedFlakyTestsRollup in db/queries.ts. Recomputed incrementally
  // for a project on the FlakyTestRollupJob scheduler cadence (only test ids
  // with new test_run_results rows since flagged_flaky_tests_rollup_watermark,
  // see below) rather than derived live on the request path: a from-scratch
  // recompute walks every test_run_results row ever recorded for the project
  // (SEARCH r USING idx_test_request_runs_project_hash, SEARCH trr USING
  // idx_test_run_results_run_id, TEMP B-TREE FOR GROUP BY) to collapse them
  // to distinct test_ids, which cost 7.6s+ at 1.5M rows and grows daily with
  // the table. This table lets GET /api/milestones/:project/lane-health read
  // a project_id-indexed handful of rows instead.
  target.exec(`
    CREATE TABLE IF NOT EXISTS flagged_flaky_tests_rollup (
      project_id        TEXT    NOT NULL,
      test_id           TEXT    NOT NULL,
      name              TEXT    NOT NULL,
      sample_count      INTEGER NOT NULL,
      transition_count  INTEGER NOT NULL,
      computed_at       INTEGER NOT NULL,
      PRIMARY KEY (project_id, test_id)
    );
  `);

  // completing_signal_ledger: durable, append-only record of each
  // completing-signal observation the (not-yet-wired) session-status
  // deriver reads from — see session/sessionStatusDeriver.ts and
  // session/completingSignalRegistry.ts. A row is written synchronously by
  // whatever call site detects the signal (a staged intent reaching a
  // terminal state, a PR merge/close event), never polled/batched in
  // afterward. As of the shared-primitives dual-write migration, the shared
  // status-write primitives (db/queries.ts's markSessionDone/markSessionIdle/
  // updateSessionStatus/markSessionSuperseded/applyPendingDone) and the
  // type-agnostic sweeps also mirror every real write here under the
  // 'legacy_status_write' class (see CompletingSignalClass) — additive only,
  // nothing reads it to drive real session_status writes yet. See the
  // sibling migration tasks that wire per-session-type call sites through
  // the deriver.
  target.exec(`
    CREATE TABLE IF NOT EXISTS completing_signal_ledger (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL,
      task_id      TEXT,
      session_type TEXT    NOT NULL,
      signal_class TEXT    NOT NULL,
      signal_value TEXT    NOT NULL,
      recorded_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_completing_signal_ledger_session
      ON completing_signal_ledger(session_id, recorded_at DESC);
  `);

  // flaky_remediation_tracking: one row per test_id ever auto-disposed by the
  // lane-side f2-only flaky mechanism — upsert-by-test_id, following the same
  // one-linked-task shape as capability_disqualification. See
  // flaky_remediation_pr_counts (below) for the per-triggering-PR dedup that
  // makes auto_disposition_count a distinct-PR count, not a raw actuation
  // count.
  target.exec(`
    CREATE TABLE IF NOT EXISTS flaky_remediation_tracking (
      test_id                 TEXT    PRIMARY KEY,
      remediation_task_id     TEXT,
      remediation_task_open   INTEGER NOT NULL DEFAULT 0,
      auto_disposition_count  INTEGER NOT NULL DEFAULT 0,
      created_at              TEXT    NOT NULL,
      updated_at              TEXT    NOT NULL
    );
  `);

  // flaky_remediation_pr_counts: dedup key of (test_id, pr_number, repo) —
  // a row exists once a given PR has ever contributed a lane-side auto-
  // disposition for that test, so a single PR's retries/force-pushes only
  // ever increment flaky_remediation_tracking.auto_disposition_count once.
  target.exec(`
    CREATE TABLE IF NOT EXISTS flaky_remediation_pr_counts (
      test_id     TEXT    NOT NULL,
      pr_number   INTEGER NOT NULL,
      repo        TEXT    NOT NULL,
      counted_at  TEXT    NOT NULL,
      PRIMARY KEY (test_id, pr_number, repo)
    );
  `);

  // base_health_remediation_test_tracking: one row per (project_id, test_id)
  // ever confirmed failing on the base tree itself (partial_fail outcome —
  // see orchestration/baseHealthCheck.ts). Mirrors flaky_remediation_tracking's
  // atomic-claim/dedup shape exactly (remediation_task_open flipped 0 -> 1 by
  // a single guarded UPDATE, reopened once the linked task reaches a
  // terminal status) — keyed per test id rather than content hash, so a
  // recurring break with the SAME failing tests but a DIFFERENT content hash
  // (e.g. an unrelated file changed on the base branch) dedupes against the
  // still-open remediation instead of filing again. See
  // audit/baseHealthRemediationFiling.ts.
  target.exec(`
    CREATE TABLE IF NOT EXISTS base_health_remediation_test_tracking (
      project_id               TEXT    NOT NULL,
      test_id                  TEXT    NOT NULL,
      remediation_task_id      TEXT,
      remediation_task_open    INTEGER NOT NULL DEFAULT 0,
      created_at                TEXT    NOT NULL,
      updated_at                TEXT    NOT NULL,
      PRIMARY KEY (project_id, test_id)
    );
  `);

  // base_health_remediation_reason_tracking: one row per (project_id,
  // failure_reason) ever confirmed as a whole-process base-branch crash
  // (total_fail outcome — no per-test breakdown to key off of, so the crash's
  // failure_reason is the closest identity available). Same atomic-claim/
  // reopen-on-close shape as base_health_remediation_test_tracking.
  target.exec(`
    CREATE TABLE IF NOT EXISTS base_health_remediation_reason_tracking (
      project_id               TEXT    NOT NULL,
      failure_reason           TEXT    NOT NULL,
      remediation_task_id      TEXT,
      remediation_task_open    INTEGER NOT NULL DEFAULT 0,
      created_at                TEXT    NOT NULL,
      updated_at                TEXT    NOT NULL,
      PRIMARY KEY (project_id, failure_reason)
    );
  `);

  // base_health_remediation_reason_counts: dedup key of triggering_task_id —
  // mirrors flaky_remediation_pr_counts' per-triggering-actor gate. A single
  // triggering task's own retries (e.g. its base tree moves mid-retry and
  // failure_reason drifts) get only one attempt at claiming a
  // base_health_remediation_reason_tracking row; later confirmations from
  // that same task are a pass-through no-op regardless of failure_reason.
  target.exec(`
    CREATE TABLE IF NOT EXISTS base_health_remediation_reason_counts (
      triggering_task_id  TEXT    PRIMARY KEY,
      counted_at           TEXT    NOT NULL
    );
  `);

  // Index audit follow-up: five unindexed lookups plus two FK-cascade scans
  // found by an EXPLAIN QUERY PLAN sweep of every static statement in
  // packages/backend/src. Query text is unchanged everywhere — only the
  // access path was wrong.
  target.exec(`
    -- getAuditLogByActorId (AuditLog.ts), reached from the
    -- capabilities/getRecord/sessionRecordRead read paths, otherwise scans
    -- the full audit_log table (387,891 rows and growing).
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log(actor_id);
    -- hasStagedIntentForTask-shaped WHERE task_id = ? probes, otherwise scan
    -- staged_intent; idx_staged_intent_dedup doesn't cover a task_id-only
    -- lookup since task_id isn't its leading column.
    CREATE INDEX IF NOT EXISTS idx_staged_intent_task_id ON staged_intent(task_id);
    -- getDenialsBySession's WHERE session_id = ? read, and the ON DELETE
    -- CASCADE from sessions that fires on every session delete.
    CREATE INDEX IF NOT EXISTS idx_permission_denials_session_id ON permission_denials(session_id);
    -- The pr_intent_id -> (pr_number, repo) lookup used to resolve a staged
    -- intent's PR.
    CREATE INDEX IF NOT EXISTS idx_pull_requests_pr_intent_id ON pull_requests(pr_intent_id);
    -- session_audits carries no session_id index, so the ON DELETE CASCADE
    -- from sessions scans it end to end on every session delete.
    CREATE INDEX IF NOT EXISTS idx_session_audits_session_id ON session_audits(session_id);
    -- listAllActiveStagedIntents' unscoped WHERE state IN (...) ORDER BY
    -- created_at ASC: idx_staged_intent_project_state can't serve it (its
    -- leading column, project_id, isn't in the predicate), so it fell back
    -- to a full scan of every staged_intent row plus payload. This index
    -- covers both the state predicate and the ORDER BY in one pass.
    CREATE INDEX IF NOT EXISTS idx_staged_intent_state_created_at ON staged_intent(state, created_at);
  `);

  // test_report_acquisition_attempted: whether this run's producer actually
  // tried to collect a JUnit-XML report (i.e. the project declared
  // test_report_glob), independent of whether that attempt found anything.
  // Distinguishes "acquisition ran and matched nothing" from "acquisition
  // was never attempted" — both previously collapsed onto the same
  // structured_result IS NULL, which made an unconfigured/skipped run
  // indistinguishable from a genuine acquisition failure. NULL for rows
  // predating this column and for `running` rows not yet completed.
  try {
    target.exec(
      `ALTER TABLE test_request_runs ADD COLUMN test_report_acquisition_attempted INTEGER`,
    );
  } catch {
    /* already exists */
  }

  // last_event_at: denormalised MAX(session_events.timestamp) for the owning
  // session, maintained at the event-insert sites (see queries.ts) so the
  // archived-sessions route can read it directly instead of aggregating over
  // the entire session_events table (99.8% of which belongs to archived
  // sessions) on every request. Backfilled unconditionally for rows that
  // haven't been touched by the write-path maintenance yet.
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN last_event_at INTEGER`);
  } catch {
    /* already exists */
  }
  target.exec(`
    UPDATE sessions
    SET last_event_at = (
      SELECT MAX(se.timestamp) FROM session_events se WHERE se.session_id = sessions.session_id
    )
    WHERE last_event_at IS NULL
  `);

  // first_event_at / event_count: denormalised MIN(timestamp) and COUNT(*)
  // of session_events for the owning session, maintained alongside
  // last_event_at at the same event-insert sites (see queries.ts) so
  // querySessionEventsByProjectAggregate's unfiltered path can read all
  // three aggregates directly from sessions instead of scanning every
  // session_events row ever recorded on every call.
  try {
    target.exec(`ALTER TABLE sessions ADD COLUMN first_event_at INTEGER`);
  } catch {
    /* already exists */
  }
  try {
    target.exec(
      `ALTER TABLE sessions ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
  target.exec(`
    UPDATE sessions
    SET first_event_at = (
      SELECT MIN(se.timestamp) FROM session_events se WHERE se.session_id = sessions.session_id
    ),
    event_count = (
      SELECT COUNT(*) FROM session_events se WHERE se.session_id = sessions.session_id
    )
    WHERE first_event_at IS NULL AND event_count = 0
  `);

  // scheduler_audit.event_loop_blocked_ms: event-loop-busy time attributable
  // to the job's own synchronous work, sampled as an eventLoopUtilization()
  // delta across the job (see Scheduler._runJob). duration_ms is wall-clock
  // across the job's await and stays unchanged — the two together separate
  // the job that blocked the loop from jobs that merely waited behind it.
  try {
    target.exec(
      `ALTER TABLE scheduler_audit ADD COLUMN event_loop_blocked_ms INTEGER`,
    );
  } catch {
    /* already exists */
  }

  // flagged_flaky_tests_rollup_watermark: one row per project holding the
  // highest test_run_results.id already folded into flagged_flaky_tests_rollup
  // by the last FlakyTestRollupJob tick. Lets replaceFlaggedFlakyTestsRollup
  // recompute flip-rate flags only for test ids with rows past this watermark
  // instead of re-walking every row ever recorded for the project on every
  // tick — see the docstring on replaceFlaggedFlakyTestsRollupSync in
  // db/queries.ts. Durable (read fresh from this table on each tick, not held
  // in process memory) so a restart resumes from the last folded row rather
  // than re-scanning from scratch.
  target.exec(`
    CREATE TABLE IF NOT EXISTS flagged_flaky_tests_rollup_watermark (
      project_id                TEXT    PRIMARY KEY,
      last_test_run_result_id   INTEGER NOT NULL DEFAULT 0,
      updated_at                INTEGER NOT NULL
    );
  `);

  // last_digest_updated_at/last_digest_test_id: the candidate scan's
  // watermark moved from paging test_run_results.id to paging
  // test_perf_baselines(project_id, updated_at, test_id) — see the
  // test_perf_baselines digest comment above. last_test_run_result_id is
  // left in place (unused going forward) rather than dropped, since SQLite
  // can't drop a column referenced by nothing else without a full table
  // rebuild and this migration is forward-only.
  for (const columnDdl of [
    `ALTER TABLE flagged_flaky_tests_rollup_watermark ADD COLUMN last_digest_updated_at INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE flagged_flaky_tests_rollup_watermark ADD COLUMN last_digest_test_id TEXT NOT NULL DEFAULT ''`,
  ]) {
    try {
      target.exec(columnDdl);
    } catch {
      /* already exists */
    }
  }

  // getLatestTestRequestRunForSession (queries.ts) filters on
  // (project_id, session_id, state) and sorts by started_at/finished_at, but
  // the only existing test_request_runs index covers (project_id,
  // content_hash) — nothing serves this lookup, so SQLite pulled every
  // candidate row (including ~1 MB structured_result/output blobs) into a
  // temp b-tree to sort before applying LIMIT 1. These cover both the
  // running-row query (ordered by started_at) and the non-running fallback
  // (ordered by finished_at) so neither needs a sort step. rowid is not
  // listed explicitly — SQLite already appends it as an implicit tiebreak on
  // every index over a rowid table, and referencing it by name in CREATE
  // INDEX throws "no such column: rowid".
  target.exec(`
    CREATE INDEX IF NOT EXISTS idx_test_request_runs_session_state_started
      ON test_request_runs(project_id, session_id, state, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_test_request_runs_session_finished
      ON test_request_runs(project_id, session_id, finished_at DESC);
  `);
}
