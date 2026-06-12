import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite mock ─────────────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
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
