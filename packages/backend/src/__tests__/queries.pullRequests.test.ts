import { describe, it, expect, vi } from 'vitest';

// ── In-memory DB setup ────────────────────────────────────────────────────────
// vi.mock() is hoisted by vitest, so the factory must create the database
// inline without referencing outer-scope variables.
vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
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
      archived            INTEGER NOT NULL DEFAULT 0,
      project_id          TEXT,
      session_type        TEXT    NOT NULL DEFAULT 'standard',
      favorited           INTEGER NOT NULL DEFAULT 0,
      note                TEXT,
      tags                TEXT
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
      notion_task_id TEXT    PRIMARY KEY,
      fetched_at     INTEGER NOT NULL,
      raw_json       TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number         INTEGER NOT NULL,
      pr_url            TEXT    NOT NULL UNIQUE,
      notion_task_id    TEXT,
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
  `);
  return { db };
});

import { upsertPullRequest, getPRByNumber } from '../db/queries.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('upsertPullRequest + getPRByNumber', () => {
  const now = '2024-01-01T00:00:00Z';
  const baseRow = {
    pr_number: 10,
    pr_url: 'https://github.com/owner/repo/pull/10',
    notion_task_id: null,
    session_id: null,
    repo: 'owner/repo',
    title: 'feat: initial',
    body: null,
    head_branch: 'feature/foo',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: now,
    updated_at: now,
    synced_at: now,
  } as const;

  it('returns null/undefined when PR does not exist', () => {
    expect(getPRByNumber(999, 'owner/repo')).toBeFalsy();
  });

  it('returns the correct row after upsertPullRequest', () => {
    upsertPullRequest(baseRow);
    const row = getPRByNumber(10, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.pr_number).toBe(10);
    expect(row!.repo).toBe('owner/repo');
    expect(row!.title).toBe('feat: initial');
    expect(row!.notion_task_id).toBeNull();
  });

  it('preserves existing notion_task_id when upserted with null', () => {
    // First upsert sets notion_task_id
    upsertPullRequest({ ...baseRow, pr_url: 'https://github.com/owner/repo/pull/11', pr_number: 11, notion_task_id: 'task-abc' });
    // Second upsert (e.g. from PRSyncJob) passes null — should not overwrite
    upsertPullRequest({ ...baseRow, pr_url: 'https://github.com/owner/repo/pull/11', pr_number: 11, notion_task_id: null });
    const row = getPRByNumber(11, 'owner/repo');
    expect(row!.notion_task_id).toBe('task-abc');
  });

  it('updates notion_task_id when upserted with a non-null value', () => {
    // Row created by PRSyncJob without notion_task_id
    upsertPullRequest({ ...baseRow, pr_url: 'https://github.com/owner/repo/pull/12', pr_number: 12 });
    expect(getPRByNumber(12, 'owner/repo')!.notion_task_id).toBeNull();
    // Session ends and links the task
    upsertPullRequest({ ...baseRow, pr_url: 'https://github.com/owner/repo/pull/12', pr_number: 12, notion_task_id: 'task-xyz', session_id: 'sess-1' });
    const row = getPRByNumber(12, 'owner/repo');
    expect(row!.notion_task_id).toBe('task-xyz');
    expect(row!.session_id).toBe('sess-1');
  });
});
