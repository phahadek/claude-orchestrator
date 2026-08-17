import Database from 'better-sqlite3';
import fs from 'fs';
import { getOrchestratorConfig } from '../config/appConfig';
import { getDataDir } from '../config/dataDir';
import { resolveDbPath } from '../config/resolveDbPath';
import { logger } from '../logger';
import { assertDatabaseSchema } from './assertDatabaseSchema';

const _configDbPath = getOrchestratorConfig().db.path || './dashboard.db';
// Resolved against the data directory, never process.cwd() — a CWD-relative
// path is set by whatever launched the process (e.g. a systemd drop-in), not
// by the operator, and silently pointed a production install at an empty
// database at the wrong location.
export const dbPath = resolveDbPath(_configDbPath, getDataDir());

// A test process (vitest, or anything with NODE_ENV=test) must never bind a
// real on-disk database file: an inherited/misconfigured DB_PATH pointing at
// the production database would otherwise be opened and written to silently.
// The vitest setup file (see vitest.config.ts) forces DB_PATH=':memory:'
// ahead of this module's first import; if it's anything else here, either
// that setup didn't run or something is bypassing it — fail loudly rather
// than risk writing to a real file.
const isTestMode =
  process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
if (isTestMode && dbPath !== ':memory:') {
  throw new Error(
    `[db] Refusing to open database at "${dbPath}" while running in test mode ` +
      `(NODE_ENV=test / VITEST set). Test runs must use an in-memory database ` +
      `(DB_PATH=':memory:'); binding a real file risks writing to production data.`,
  );
}

// Captured before opening — better-sqlite3 creates the file on open, which
// would otherwise make a pre-existing file indistinguishable from a fresh one.
const dbFileExistedBeforeOpen = dbPath !== ':memory:' && fs.existsSync(dbPath);

// Chosen at grooming (2026-08-17) against this host's live `free -h`: 30 GiB
// total, 9.9 GiB available, 9.6 GiB of 23 GiB swap already in use — real
// memory pressure alongside a large postgres instance sharing the box.
// cache_size covers ~6% and mmap_size ~23% of the 4.4 GB db file, enough to
// hold a real working set without competing meaningfully with postgres for
// the already-strained remaining headroom. See applyPerformancePragmas below
// for why the defaults (16 MB cache, mmap disabled) caused 30.8M read()
// syscalls and pinned the disk at 100% utilisation.
export const DB_CACHE_SIZE_PRAGMA_KB = -262144; // 256 MB (negative = KiB, per SQLite pragma semantics)
export const DB_MMAP_SIZE_BYTES = 1073741824; // 1 GB

// Applied to every connection the backend opens against the on-disk database
// (not just the primary `db` export below) — a connection left on SQLite's
// defaults (16 MB cache, mmap disabled) re-reads the whole working set from
// disk on every query. Values are read back and asserted so a future edit to
// this file, or a driver upgrade that changes pragma defaults, fails loudly
// at startup instead of silently reverting to the pathological defaults.
export function applyPerformancePragmas(
  database: Database.Database,
  targetPath: string,
): void {
  database.pragma(`cache_size = ${DB_CACHE_SIZE_PRAGMA_KB}`);
  const actualCacheSize = (
    database.pragma('cache_size') as { cache_size: number }[]
  )[0]?.cache_size;
  if (actualCacheSize !== DB_CACHE_SIZE_PRAGMA_KB) {
    throw new Error(
      `[db] cache_size pragma did not apply: expected ${DB_CACHE_SIZE_PRAGMA_KB}, got ${actualCacheSize}`,
    );
  }

  // mmap_size has no effect on an in-memory database (no file to map) and
  // better-sqlite3 returns an empty pragma result for it there — skip the
  // (otherwise-failing) assertion in that case rather than the pragma itself.
  database.pragma(`mmap_size = ${DB_MMAP_SIZE_BYTES}`);
  if (targetPath !== ':memory:') {
    const actualMmapSize = (
      database.pragma('mmap_size') as { mmap_size: number }[]
    )[0]?.mmap_size;
    if (actualMmapSize !== DB_MMAP_SIZE_BYTES) {
      throw new Error(
        `[db] mmap_size pragma did not apply: expected ${DB_MMAP_SIZE_BYTES}, got ${actualMmapSize}`,
      );
    }
  }
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
applyPerformancePragmas(db, dbPath);

assertDatabaseSchema(db, dbPath, dbFileExistedBeforeOpen);

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
  CREATE TABLE IF NOT EXISTS scheduler_audit (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job             TEXT    NOT NULL,
    status          TEXT    NOT NULL,
    started_at      TEXT    NOT NULL,
    completed_at    TEXT    NOT NULL,
    duration_ms     INTEGER NOT NULL,
    items_processed INTEGER,
    error           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scheduler_audit_job ON scheduler_audit(job, started_at DESC);
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
    logger.info(
      '[db] Enabling incremental auto_vacuum (one-time VACUUM — may take a moment)',
    );
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run('auto_vacuum_incremental_done', '1');
    logger.info('[db] incremental auto_vacuum enabled');
  } catch (err) {
    logger.warn('[db] auto_vacuum enablement failed (non-fatal):', err);
  }
})();
