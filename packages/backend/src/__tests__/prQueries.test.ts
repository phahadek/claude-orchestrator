import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory SQLite mock ─────────────────────────────────────────────────────
// vi.mock is hoisted before imports, so the factory runs first and the
// queries module picks up the in-memory database instead of the real file.

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'proj-2',
    'Other Project',
    '/other',
    'other/repo',
    'notion',
    1000,
    1000,
  );
  return { db };
});

import { upsertPullRequest, deletePR, getPRByNumber } from '../db/queries.js';

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
