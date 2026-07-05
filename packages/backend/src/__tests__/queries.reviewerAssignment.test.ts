import { describe, it, expect, vi } from 'vitest';

// ── In-memory DB setup ────────────────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  return { db };
});

import {
  upsertPullRequest,
  getPRByNumber,
  getPendingRoutedCommentCount,
  markCommentsPending,
  ackPendingComments,
  markReviewerRequested,
} from '../db/queries.js';

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

describe('getPendingRoutedCommentCount', () => {
  it('returns 0 when there are no routed comments', () => {
    expect(getPendingRoutedCommentCount(10, 'owner/repo')).toBe(0);
  });

  it('counts only pending rows, not acked ones', () => {
    markCommentsPending(10, 'owner/repo', ['c1', 'c2', 'c3']);
    expect(getPendingRoutedCommentCount(10, 'owner/repo')).toBe(3);

    ackPendingComments(10, 'owner/repo');
    expect(getPendingRoutedCommentCount(10, 'owner/repo')).toBe(0);
  });

  it('scopes the count to the given PR/repo', () => {
    markCommentsPending(10, 'owner/repo', ['c1']);
    expect(getPendingRoutedCommentCount(11, 'owner/repo')).toBe(0);
  });
});

describe('markReviewerRequested', () => {
  it('stamps reviewer_requested_at once and preserves it on repeat calls', () => {
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/30',
      pr_number: 30,
    });
    expect(getPRByNumber(30, 'owner/repo')!.reviewer_requested_at).toBeNull();

    markReviewerRequested(30, 'owner/repo');
    const firstStamp = getPRByNumber(30, 'owner/repo')!.reviewer_requested_at;
    expect(firstStamp).not.toBeNull();

    markReviewerRequested(30, 'owner/repo');
    const secondStamp = getPRByNumber(30, 'owner/repo')!.reviewer_requested_at;
    expect(secondStamp).toBe(firstStamp);
  });
});
