import Database from 'better-sqlite3';
import path from 'path';
import { getOrchestratorConfig } from '../config/appConfig';

const _configDbPath = getOrchestratorConfig().db.path;
const dbPath = _configDbPath || path.join(process.cwd(), 'dashboard.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run migrations immediately so prepared statements in queries.ts compile at import time.
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
    favorited           INTEGER NOT NULL DEFAULT 0
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
  CREATE TABLE IF NOT EXISTS permission_denials (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT    NOT NULL,
    tool_name   TEXT    NOT NULL,
    tool_use_id TEXT    NOT NULL,
    tool_input  TEXT    NOT NULL,
    timestamp   INTEGER NOT NULL,
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
    task_id    TEXT    PRIMARY KEY,
    fetched_at INTEGER NOT NULL,
    raw_json   TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pull_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number       INTEGER NOT NULL,
    pr_url          TEXT    NOT NULL UNIQUE,
    task_id         TEXT,
    session_id      TEXT,
    repo            TEXT    NOT NULL,
    title           TEXT,
    body            TEXT,
    head_branch     TEXT,
    base_branch     TEXT,
    state           TEXT    NOT NULL DEFAULT 'open',
    draft           INTEGER NOT NULL DEFAULT 0,
    review_result   TEXT,
    review_at       TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    synced_at       TEXT    NOT NULL
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

// ── Column rename migrations (run before queries.ts imports so prepared statements
//    compile against the new schema on existing databases) ─────────────────────

// sessions: notion_task_id → task_id
try {
  db.exec(`ALTER TABLE sessions RENAME COLUMN notion_task_id TO task_id`);
} catch {
  /* already renamed or column doesn't exist (fresh DB) */
}
// sessions: notion_task_url → task_url
try {
  db.exec(`ALTER TABLE sessions RENAME COLUMN notion_task_url TO task_url`);
} catch {
  /* already renamed or column doesn't exist */
}
// task_cache: notion_task_id → task_id (primary key rename via SQLite RENAME COLUMN)
try {
  db.exec(`ALTER TABLE task_cache RENAME COLUMN notion_task_id TO task_id`);
} catch {
  /* already renamed or column doesn't exist */
}
// pull_requests: notion_task_id → task_id
try {
  db.exec(`ALTER TABLE pull_requests RENAME COLUMN notion_task_id TO task_id`);
} catch {
  /* already renamed or column doesn't exist (fresh DB uses task_id already) */
}
// Backfill pull_requests.task_id: add 'notion:' prefix for legacy unprefixed rows.
// Idempotent: only touches rows where task_id has no ':' separator.
// Handles duplicate-shape collisions: delete the raw row when a prefixed twin exists.
try {
  db.exec(`
    DELETE FROM pull_requests
    WHERE task_id IS NOT NULL
      AND task_id NOT LIKE '%:%'
      AND EXISTS (
        SELECT 1 FROM pull_requests pr2
        WHERE pr2.task_id = 'notion:' || pull_requests.task_id
          AND pr2.pr_url != pull_requests.pr_url
      )
  `);
  db.exec(`
    UPDATE pull_requests
    SET task_id = 'notion:' || task_id
    WHERE task_id IS NOT NULL
      AND task_id NOT LIKE '%:%'
  `);
} catch {
  /* backfill already ran or table doesn't exist */
}

// ── Migrations (idempotent column additions for existing databases) ──────────
try {
  db.exec(
    `ALTER TABLE pull_requests ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`,
  );
} catch {
  /* already exists */
}
// review_iteration and review_session_id support the auto re-review loop:
// review_iteration tracks how many times a PR has been reviewed (caps escalation).
// review_session_id is the session ID of the paired review session for sendOrResume.
try {
  db.exec(
    `ALTER TABLE pull_requests ADD COLUMN review_iteration INTEGER NOT NULL DEFAULT 0`,
  );
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN review_session_id TEXT`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN head_sha TEXT`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN last_reviewed_sha TEXT`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN node_id TEXT`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN task_name TEXT`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN mergeable INTEGER`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN merge_state TEXT`);
} catch {
  /* already exists */
}
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN merge_state_checked_at TEXT`);
} catch {
  /* already exists */
}
// failing_checks: JSON array of failing check-run names; populated when merge_state is 'ci_failed'.
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN failing_checks TEXT`);
} catch {
  /* already exists */
}
// pending_push: 1 when a push arrives before the initial review session is established.
// Cleared and re-review triggered after the initial review completes.
try {
  db.exec(
    `ALTER TABLE pull_requests ADD COLUMN pending_push INTEGER NOT NULL DEFAULT 0`,
  );
} catch {
  /* already exists */
}
// pause_reason: non-null marks the task as needs_attention (e.g. 'max_reviews', 'stuck_timeout').
try {
  db.exec(`ALTER TABLE pull_requests ADD COLUMN pause_reason TEXT`);
} catch {
  /* already exists */
}
// events_pruned_at: epoch-ms timestamp marking when system event payloads were pruned for this session.
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN events_pruned_at INTEGER`);
} catch {
  /* already exists */
}

// Enable incremental auto_vacuum once — guards against write-blocking full VACUUMs.
// SQLite requires a full VACUUM to switch auto_vacuum mode; this runs at most once ever
// (guarded by a settings row) and is skipped for in-memory test databases.
(function enableIncrementalAutoVacuum() {
  if (dbPath === ':memory:') return;
  const currentMode = (db.pragma('auto_vacuum') as { auto_vacuum: number }[])[0]
    ?.auto_vacuum;
  // 0 = NONE, 1 = FULL, 2 = INCREMENTAL
  if (currentMode === 2) return;
  try {
    const already = db
      .prepare(
        `SELECT value FROM settings WHERE key = 'auto_vacuum_incremental_done'`,
      )
      .get() as { value: string } | undefined;
    if (already) return;
    console.log(
      '[db] Enabling incremental auto_vacuum (one-time VACUUM — may take a moment)',
    );
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run('auto_vacuum_incremental_done', '1');
    console.log('[db] incremental auto_vacuum enabled');
  } catch (err) {
    console.warn('[db] auto_vacuum enablement failed (non-fatal):', err);
  }
})();
