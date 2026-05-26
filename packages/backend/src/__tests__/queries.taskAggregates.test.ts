import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite mock ─────────────────────────────────────────────────────
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
      total_input_tokens  INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0
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
      notion_task_id         TEXT,
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
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      board_id    TEXT,
      repo        TEXT
    );
  `);
  return { db };
});

import {
  getActiveTaskAggregates,
  upsertTaskCache,
  insertSession,
  upsertPullRequest,
} from '../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DASHED_UUID = '33722f91-52f3-816b-967f-c7f230b215ca';
const DASHLESS_UUID = '33722f9152f3816b967fc7f230b215ca';

function makeSession(overrides: {
  session_id: string;
  notion_task_id: string;
  session_type?: string;
  started_at?: number;
}) {
  return {
    session_id: overrides.session_id,
    task_id: overrides.notion_task_id,
    task_url: `https://www.notion.so/${overrides.notion_task_id}`,
    project_context_url: 'https://www.notion.so/context',
    project_id: 'proj-1',
    status: 'completed',
    started_at: overrides.started_at ?? 1000,
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    session_type: overrides.session_type ?? 'standard',
    task_name: null,
  };
}

function makePR(overrides: {
  pr_number: number;
  notion_task_id: string;
  session_id?: string;
}) {
  const now = '2024-01-01T00:00:00Z';
  return {
    pr_number: overrides.pr_number,
    pr_url: `https://github.com/owner/repo/pull/${overrides.pr_number}`,
    notion_task_id: overrides.notion_task_id,
    session_id: overrides.session_id ?? null,
    repo: 'owner/repo',
    title: `PR ${overrides.pr_number}`,
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: now,
    updated_at: now,
    synced_at: now,
    review_iteration: 0,
    review_session_id: null,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
  };
}

beforeEach(async () => {
  const { db } = await import('../db/db.js');
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM pull_requests').run();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getActiveTaskAggregates — notion_task_id format matching', () => {
  it('returns non-null code_session_id when session uses dashless UUID and task_cache uses dashed UUID', () => {
    // task_cache stores dashed UUID (as returned by Notion API)
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    // session stores dashless UUID (as produced by parseNotionPageId)
    insertSession(
      makeSession({
        session_id: 'sess-001',
        notion_task_id: DASHLESS_UUID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-001');
  });

  it('returns non-null code_session_id when both use dashless UUID', () => {
    upsertTaskCache(
      DASHLESS_UUID,
      JSON.stringify({
        id: DASHLESS_UUID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-002',
        notion_task_id: DASHLESS_UUID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([DASHLESS_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-002');
  });

  it('returns non-null pr_number when PR uses dashless UUID and task_cache uses dashed UUID', () => {
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    upsertPullRequest(makePR({ pr_number: 42, notion_task_id: DASHLESS_UUID }));

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_number).toBe(42);
  });

  it('returns non-null pr_url when PR uses dashless UUID and task_cache uses dashed UUID', () => {
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    upsertPullRequest(makePR({ pr_number: 43, notion_task_id: DASHLESS_UUID }));

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_url).toBe('https://github.com/owner/repo/pull/43');
  });

  it('handles dashed UUID normalization — both dashed in task_cache and sessions', () => {
    // If both happen to use dashed format, it still works
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-003',
        notion_task_id: DASHED_UUID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-003');
  });

  it('returns null code_session_id when no session exists for the task', () => {
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Test Task',
        status: '🗂️ Ready',
      }),
    );

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBeNull();
    expect(rows[0].pr_number).toBeNull();
  });

  it('picks the most recent session when multiple exist for the same task', () => {
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-old',
        notion_task_id: DASHLESS_UUID,
        session_type: 'standard',
        started_at: 1000,
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-new',
        notion_task_id: DASHLESS_UUID,
        session_type: 'standard',
        started_at: 2000,
      }),
    );

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-new');
  });

  it('returns empty array when taskIds is empty', () => {
    const rows = getActiveTaskAggregates([]);
    expect(rows).toHaveLength(0);
  });
});

describe('getActiveTaskAggregates — review session token fields', () => {
  it('returns review_session_input_tokens and review_session_output_tokens for a review session', async () => {
    const { db } = await import('../db/db.js');
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Token Task',
        status: '🔍 In Review',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'code-sess',
        notion_task_id: DASHLESS_UUID,
        session_type: 'standard',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'review-sess',
        notion_task_id: DASHLESS_UUID,
        session_type: 'review',
      }),
    );
    db.prepare(
      'UPDATE sessions SET total_input_tokens = 200, total_output_tokens = 100 WHERE session_id = ?',
    ).run('review-sess');

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].review_session_id).toBe('review-sess');
    expect(rows[0].review_session_input_tokens).toBe(200);
    expect(rows[0].review_session_output_tokens).toBe(100);
  });

  it('returns null review token fields when no review session exists', () => {
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Token Task',
        status: '🗂️ Ready',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'code-only',
        notion_task_id: DASHLESS_UUID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].review_session_id).toBeNull();
    expect(rows[0].review_session_input_tokens).toBeNull();
    expect(rows[0].review_session_output_tokens).toBeNull();
  });

  it('returns both code and review session tokens independently', async () => {
    const { db } = await import('../db/db.js');
    upsertTaskCache(
      DASHED_UUID,
      JSON.stringify({
        id: DASHED_UUID,
        title: 'Token Task',
        status: '🔍 In Review',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'code-sess-2',
        notion_task_id: DASHLESS_UUID,
        session_type: 'standard',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'review-sess-2',
        notion_task_id: DASHLESS_UUID,
        session_type: 'review',
      }),
    );
    db.prepare(
      'UPDATE sessions SET total_input_tokens = 500, total_output_tokens = 300 WHERE session_id = ?',
    ).run('code-sess-2');
    db.prepare(
      'UPDATE sessions SET total_input_tokens = 150, total_output_tokens = 75 WHERE session_id = ?',
    ).run('review-sess-2');

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_input_tokens).toBe(500);
    expect(rows[0].code_session_output_tokens).toBe(300);
    expect(rows[0].review_session_input_tokens).toBe(150);
    expect(rows[0].review_session_output_tokens).toBe(75);
  });
});
