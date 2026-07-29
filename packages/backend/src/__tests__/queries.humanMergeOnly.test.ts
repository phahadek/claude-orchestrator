import { describe, it, expect, vi } from 'vitest';

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
  getApprovedOpenPRs,
  setHumanMergeOnly,
} from '../db/queries.js';

const now = '2024-01-01T00:00:00Z';
const baseRow = {
  task_id: null,
  session_id: null,
  repo: 'owner/repo',
  title: 'docs: update',
  body: null,
  head_branch: 'feature/docs',
  base_branch: 'dev',
  state: 'open' as const,
  draft: 0,
  review_result: JSON.stringify({ verdict: 'approved' }),
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
};

describe('human_merge_only gate — getApprovedOpenPRs exclusion', () => {
  it('a human_merge_only=1 open+approved PR is absent from getApprovedOpenPRs()', () => {
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/100',
      pr_number: 100,
    });
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/101',
      pr_number: 101,
    });
    setHumanMergeOnly(101, 'owner/repo', true);

    const approved = getApprovedOpenPRs().map((r) => r.pr_number);
    expect(approved).toContain(100);
    expect(approved).not.toContain(101);
  });

  it('defaults to 0 for a freshly-upserted PR', () => {
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/102',
      pr_number: 102,
    });
    expect(getPRByNumber(102, 'owner/repo')!.human_merge_only).toBe(0);
  });

  it('setHumanMergeOnly(false) clears the gate', () => {
    upsertPullRequest({
      ...baseRow,
      pr_url: 'https://github.com/owner/repo/pull/103',
      pr_number: 103,
    });
    setHumanMergeOnly(103, 'owner/repo', true);
    expect(
      getApprovedOpenPRs().map((r) => r.pr_number),
    ).not.toContain(103);
    setHumanMergeOnly(103, 'owner/repo', false);
    expect(getApprovedOpenPRs().map((r) => r.pr_number)).toContain(103);
  });
});
