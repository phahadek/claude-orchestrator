import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite mock ─────────────────────────────────────────────────────
// vi.mock is hoisted before imports, so the factory runs first and the
// queries module picks up the in-memory database instead of the real file.

vi.mock('../db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  memDb.exec(`
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
      total_output_tokens INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, user_agent TEXT, last_ip TEXT,
      last_seen INTEGER, enrolled_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      project_dir TEXT    NOT NULL,
      context_url TEXT,
      github_repo TEXT,
      task_source TEXT    NOT NULL DEFAULT 'notion',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at)
    VALUES ('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000),
           ('proj-2', 'Other Project', '/other', 'other/repo', 'notion', 1000, 1000);
  `);
  return { db: memDb };
});

import {
  upsertPullRequest,
  deletePR,
  getPRByNumber,
} from '../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePR(
  overrides: Partial<{
    pr_number: number;
    repo: string;
    state: string;
    pr_url: string;
  }> = {},
) {
  const pr_number = overrides.pr_number ?? 1;
  const repo = overrides.repo ?? 'owner/repo';
  return {
    pr_number,
    pr_url: overrides.pr_url ?? `https://github.com/${repo}/pull/${pr_number}`,
    task_id: null,
    session_id: null,
    repo,
    title: `PR ${pr_number}`,
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: overrides.state ?? 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    synced_at: '2024-01-01T00:00:00Z',
    review_iteration: 0,
    review_session_id: null,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
  };
}

beforeEach(async () => {
  // Clear pull_requests before each test
  const { db } = await import('../db/db.js');
  db.prepare('DELETE FROM pull_requests').run();
});

// ── deletePR ──────────────────────────────────────────────────────────────────

describe('deletePR()', () => {
  it('removes the row and subsequent getPRByNumber returns null', () => {
    upsertPullRequest(makePR({ pr_number: 10, repo: 'owner/repo' }));
    expect(getPRByNumber(10, 'owner/repo')).not.toBeNull();

    const deleted = deletePR(10, 'owner/repo');
    expect(deleted).toBe(true);
    expect(getPRByNumber(10, 'owner/repo')).toBeFalsy();
  });

  it('returns false when the PR does not exist', () => {
    expect(deletePR(999, 'owner/repo')).toBe(false);
  });

  it('only deletes the matching repo', () => {
    upsertPullRequest(
      makePR({
        pr_number: 10,
        repo: 'owner/repo',
        pr_url: 'https://github.com/owner/repo/pull/10',
      }),
    );
    upsertPullRequest(
      makePR({
        pr_number: 10,
        repo: 'other/repo',
        pr_url: 'https://github.com/other/repo/pull/10',
      }),
    );

    deletePR(10, 'owner/repo');

    expect(getPRByNumber(10, 'owner/repo')).toBeFalsy();
    expect(getPRByNumber(10, 'other/repo')).not.toBeNull();
  });
});

