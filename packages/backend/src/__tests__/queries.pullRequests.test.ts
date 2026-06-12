import { describe, it, expect, vi } from 'vitest';

// ── In-memory DB setup ────────────────────────────────────────────────────────
// vi.mock() is hoisted by vitest, so the factory must create the database
// inline without referencing outer-scope variables.
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  return { db };
});

import { upsertPullRequest, getPRByNumber } from '../db/queries.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('upsertPullRequest + getPRByNumber', () => {
  const now = '2024-01-01T00:00:00Z';
  const baseRow = {
    pr_number: 10,
    pr_url: 'https://github.com/owner/repo/pull/10',
    task_id: null,
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
    review_iteration: 0,
    review_session_id: null,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
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
    expect(row!.task_id).toBeNull();
  });

  it('preserves existing task_id when upserted with null', () => {
    // First upsert sets task_id
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/11',
      pr_number: 11,
      task_id: 'notion:task-abc',
    });
    // Second upsert (e.g. from PRSyncJob) passes null — should not overwrite
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/11',
      pr_number: 11,
      task_id: null,
    });
    const row = getPRByNumber(11, 'owner/repo');
    expect(row!.task_id).toBe('notion:task-abc');
  });

  it('updates task_id when upserted with a non-null value', () => {
    // Row created by PRSyncJob without task_id
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/12',
      pr_number: 12,
    });
    expect(getPRByNumber(12, 'owner/repo')!.task_id).toBeNull();
    // Session ends and links the task
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/12',
      pr_number: 12,
      task_id: 'notion:task-xyz',
      session_id: 'sess-1',
    });
    const row = getPRByNumber(12, 'owner/repo');
    expect(row!.task_id).toBe('notion:task-xyz');
    expect(row!.session_id).toBe('sess-1');
  });

  // ── Terminal-state protection (Change 2) ──────────────────────────────────

  it('preserves merged state when upserted with state=open', () => {
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/20',
      pr_number: 20,
      state: 'merged',
    });
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/20',
      pr_number: 20,
      state: 'open',
    });
    expect(getPRByNumber(20, 'owner/repo')!.state).toBe('merged');
  });

  it('preserves closed state when upserted with state=open', () => {
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/21',
      pr_number: 21,
      state: 'closed',
    });
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/21',
      pr_number: 21,
      state: 'open',
    });
    expect(getPRByNumber(21, 'owner/repo')!.state).toBe('closed');
  });

  it('allows forward transition from open to merged', () => {
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/22',
      pr_number: 22,
      state: 'open',
    });
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/22',
      pr_number: 22,
      state: 'merged',
    });
    expect(getPRByNumber(22, 'owner/repo')!.state).toBe('merged');
  });
});
