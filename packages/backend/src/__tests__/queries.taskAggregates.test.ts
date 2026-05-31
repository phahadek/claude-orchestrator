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
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      review_result       TEXT,
      metadata            TEXT
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
      task_id         TEXT,
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
    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      event_type TEXT    NOT NULL,
      actor_type TEXT    NOT NULL,
      actor_id   TEXT,
      project_id TEXT,
      task_id    TEXT,
      payload    TEXT    NOT NULL
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
    CREATE TABLE IF NOT EXISTS pr_review_comments_routed (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number  INTEGER NOT NULL,
      repo       TEXT    NOT NULL,
      comment_id TEXT    NOT NULL,
      routed_at  INTEGER NOT NULL,
      UNIQUE(pr_number, repo, comment_id)
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
const PREFIXED_ID = `notion:${DASHED_UUID}`;

function makeSession(overrides: {
  session_id: string;
  task_id: string;
  session_type?: string;
  started_at?: number;
}) {
  return {
    session_id: overrides.session_id,
    task_id: overrides.task_id,
    task_url: `https://www.notion.so/${overrides.task_id}`,
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
  task_id: string;
  session_id?: string;
}) {
  const now = '2024-01-01T00:00:00Z';
  return {
    pr_number: overrides.pr_number,
    pr_url: `https://github.com/owner/repo/pull/${overrides.pr_number}`,
    task_id: overrides.task_id,
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

describe('getActiveTaskAggregates — pull_requests.task_id format matching', () => {
  it('returns non-null code_session_id when session and task_cache use same prefixed format', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-001',
        task_id: PREFIXED_ID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
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
        task_id: DASHLESS_UUID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([DASHLESS_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-002');
  });

  it('returns non-null pr_number when PR and task_cache use same prefixed format', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    upsertPullRequest(makePR({ pr_number: 42, task_id: PREFIXED_ID }));

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_number).toBe(42);
  });

  it('returns non-null pr_url when PR and task_cache use same prefixed format', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    upsertPullRequest(makePR({ pr_number: 43, task_id: PREFIXED_ID }));

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_url).toBe('https://github.com/owner/repo/pull/43');
  });

  it('handles direct equality — both dashed UUID in task_cache and sessions', () => {
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
        task_id: DASHED_UUID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([DASHED_UUID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-003');
  });

  it('returns null code_session_id when no session exists for the task', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Test Task',
        status: '🗂️ Ready',
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBeNull();
    expect(rows[0].pr_number).toBeNull();
  });

  it('picks the most recent session when multiple exist for the same task', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Test Task',
        status: '🔄 In Progress',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-old',
        task_id: PREFIXED_ID,
        session_type: 'standard',
        started_at: 1000,
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-new',
        task_id: PREFIXED_ID,
        session_type: 'standard',
        started_at: 2000,
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-new');
  });

  it('returns empty array when taskIds is empty', () => {
    const rows = getActiveTaskAggregates([]);
    expect(rows).toHaveLength(0);
  });

  it('regression: dashless session task_id does NOT match dashed task_cache (documents the bug)', () => {
    // task_cache stores dashed (Notion API native), session stores dashless (old bug)
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Mismatch Task',
        status: '🔄 In Progress',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-dashless',
        task_id: `notion:${DASHLESS_UUID}`,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    // Without the fix the JOIN fails and code_session_id would be null.
    // This asserts the pre-fix broken behavior so if the query ever regresses
    // back to REPLACE-based normalisation we can detect it here.
    expect(rows[0].code_session_id).toBeNull();
  });

  it('regression: dashed session task_id matches dashed task_cache (validates the fix)', () => {
    // After the fix: both sides use dashed — the JOIN must succeed.
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Fixed Task',
        status: '🔄 In Progress',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'sess-dashed',
        task_id: PREFIXED_ID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('sess-dashed');
  });
});

describe('getActiveTaskAggregates — direct comparison with uniform prefixed format', () => {
  it('prefixed tc.task_id + prefixed session → session matched as code_session_id', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({ id: PREFIXED_ID, title: 'T', status: 'In Progress' }),
    );
    insertSession(
      makeSession({
        session_id: 'prefix-sess-1',
        task_id: PREFIXED_ID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_id).toBe('prefix-sess-1');
  });

  it('prefixed tc.task_id + prefixed PR task_id → PR fields populated', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({ id: PREFIXED_ID, title: 'T', status: 'In Progress' }),
    );
    upsertPullRequest(makePR({ pr_number: 99, task_id: PREFIXED_ID }));

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_number).toBe(99);
    expect(rows[0].pr_url).toBe('https://github.com/owner/repo/pull/99');
  });

  it('prefixed tc.task_id + prefixed review session → review_session_id matched', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({ id: PREFIXED_ID, title: 'T', status: 'In Review' }),
    );
    insertSession(
      makeSession({
        session_id: 'review-prefix-1',
        task_id: PREFIXED_ID,
        session_type: 'review',
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].review_session_id).toBe('review-prefix-1');
  });
});

describe('getActiveTaskAggregates — review session token fields', () => {
  it('returns review_session_input_tokens and review_session_output_tokens for a review session', async () => {
    const { db } = await import('../db/db.js');
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Token Task',
        status: '🔍 In Review',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'code-sess',
        task_id: PREFIXED_ID,
        session_type: 'standard',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'review-sess',
        task_id: PREFIXED_ID,
        session_type: 'review',
      }),
    );
    db.prepare(
      'UPDATE sessions SET total_input_tokens = 200, total_output_tokens = 100 WHERE session_id = ?',
    ).run('review-sess');

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].review_session_id).toBe('review-sess');
    expect(rows[0].review_session_input_tokens).toBe(200);
    expect(rows[0].review_session_output_tokens).toBe(100);
  });

  it('returns null review token fields when no review session exists', () => {
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Token Task',
        status: '🗂️ Ready',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'code-only',
        task_id: PREFIXED_ID,
        session_type: 'standard',
      }),
    );

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].review_session_id).toBeNull();
    expect(rows[0].review_session_input_tokens).toBeNull();
    expect(rows[0].review_session_output_tokens).toBeNull();
  });

  it('returns both code and review session tokens independently', async () => {
    const { db } = await import('../db/db.js');
    upsertTaskCache(
      PREFIXED_ID,
      JSON.stringify({
        id: PREFIXED_ID,
        title: 'Token Task',
        status: '🔍 In Review',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'code-sess-2',
        task_id: PREFIXED_ID,
        session_type: 'standard',
      }),
    );
    insertSession(
      makeSession({
        session_id: 'review-sess-2',
        task_id: PREFIXED_ID,
        session_type: 'review',
      }),
    );
    db.prepare(
      'UPDATE sessions SET total_input_tokens = 500, total_output_tokens = 300 WHERE session_id = ?',
    ).run('code-sess-2');
    db.prepare(
      'UPDATE sessions SET total_input_tokens = 150, total_output_tokens = 75 WHERE session_id = ?',
    ).run('review-sess-2');

    const rows = getActiveTaskAggregates([PREFIXED_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0].code_session_input_tokens).toBe(500);
    expect(rows[0].code_session_output_tokens).toBe(300);
    expect(rows[0].review_session_input_tokens).toBe(150);
    expect(rows[0].review_session_output_tokens).toBe(75);
  });
});
