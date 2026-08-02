/**
 * Tests for getPRs (db/queries.ts): the list must stay bounded regardless of
 * how many terminal PRs a repo has accumulated, while never dropping an open
 * row — the request-scoped stale-open reconciliation in routes/prs.ts is the
 * only repair path for escalated state='open' rows and depends on seeing all
 * of them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  getPRs,
  getApprovedOpenPRs,
  getApprovedLocalBranches,
} from '../queries.js';

const REPO = 'owner/repo';

function insertPR(overrides: {
  pr_number: number;
  state: string;
  updated_at: string;
}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, @repo, @state, 0, NULL, NULL,
       @created_at, @updated_at, @updated_at)
  `,
  ).run({
    pr_number: overrides.pr_number,
    pr_url: `https://github.com/${REPO}/pull/${overrides.pr_number}`,
    repo: REPO,
    state: overrides.state,
    created_at: overrides.updated_at,
    updated_at: overrides.updated_at,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
});

describe('getPRs', () => {
  it('returns every open row even when it exceeds the terminal cap', () => {
    for (let i = 0; i < 5; i++) {
      insertPR({
        pr_number: i,
        state: 'open',
        updated_at: `2024-01-0${i + 1}T00:00:00Z`,
      });
    }
    const rows = getPRs(REPO, 2);
    expect(rows.filter((r) => r.state === 'open')).toHaveLength(5);
  });

  it('caps terminal (merged/closed) rows at the configured limit', () => {
    for (let i = 0; i < 10; i++) {
      insertPR({
        pr_number: i,
        state: i % 2 === 0 ? 'merged' : 'closed',
        updated_at: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const rows = getPRs(REPO, 3);
    expect(rows).toHaveLength(3);
  });

  it('prefers the most recently updated terminal rows when capping', () => {
    for (let i = 0; i < 5; i++) {
      insertPR({
        pr_number: i,
        state: 'merged',
        updated_at: `2024-01-0${i + 1}T00:00:00Z`,
      });
    }
    const rows = getPRs(REPO, 2);
    expect(rows.map((r) => r.pr_number).sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it('combines all open rows with the capped terminal rows', () => {
    insertPR({
      pr_number: 100,
      state: 'open',
      updated_at: '2024-02-01T00:00:00Z',
    });
    for (let i = 0; i < 5; i++) {
      insertPR({
        pr_number: i,
        state: 'merged',
        updated_at: `2024-01-0${i + 1}T00:00:00Z`,
      });
    }
    const rows = getPRs(REPO, 2);
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.pr_number === 100 && r.state === 'open')).toBe(
      true,
    );
  });
});

function insertPRWithReview(overrides: {
  pr_number: number;
  review_result: string | null;
  pause_reason?: string | null;
  human_merge_only?: number;
}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, pause_reason, human_merge_only)
    VALUES
      (@pr_number, @pr_url, @repo, 'open', 0, @review_result, NULL,
       @created_at, @created_at, @created_at, @pause_reason, @human_merge_only)
  `,
  ).run({
    pr_number: overrides.pr_number,
    pr_url: `https://github.com/${REPO}/pull/${overrides.pr_number}`,
    repo: REPO,
    review_result: overrides.review_result,
    created_at: '2024-01-01T00:00:00Z',
    pause_reason: overrides.pause_reason ?? null,
    human_merge_only: overrides.human_merge_only ?? 0,
  });
}

describe('getApprovedOpenPRs', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM pull_requests').run();
  });

  it('excludes a needs_changes verdict whose reviewer notes contain "approval"', () => {
    insertPRWithReview({
      pr_number: 1,
      review_result: JSON.stringify({
        prNumber: 1,
        repo: REPO,
        verdict: 'needs_changes',
        dimensions: [
          { name: 'x', passed: false, notes: 'needs a post-approval cleanup' },
        ],
      }),
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('returns a PR whose verdict is approved', () => {
    insertPRWithReview({
      pr_number: 2,
      review_result: JSON.stringify({
        prNumber: 2,
        repo: REPO,
        verdict: 'approved',
        dimensions: [],
      }),
    });
    const rows = getApprovedOpenPRs();
    expect(rows.map((r) => r.pr_number)).toEqual([2]);
  });

  it('does not treat "approved": false as approved', () => {
    insertPRWithReview({
      pr_number: 3,
      review_result: JSON.stringify({
        prNumber: 3,
        repo: REPO,
        verdict: 'needs_changes',
        approved: false,
      }),
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('still excludes rows with a pause_reason set', () => {
    insertPRWithReview({
      pr_number: 4,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('still excludes rows marked human_merge_only', () => {
    insertPRWithReview({
      pr_number: 5,
      review_result: JSON.stringify({ verdict: 'approved' }),
      human_merge_only: 1,
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('includes an approved row with no pause_reason and human_merge_only unset', () => {
    insertPRWithReview({
      pr_number: 6,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    expect(getApprovedOpenPRs().map((r) => r.pr_number)).toEqual([6]);
  });
});

describe('getApprovedLocalBranches', () => {
  const PROJECT_ID = 'proj-1';

  beforeEach(() => {
    db.prepare('DELETE FROM local_branches').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare(
      `
      INSERT INTO projects (id, name, project_dir, auto_merge_enabled, created_at, updated_at)
      VALUES (@id, 'proj', '/tmp/proj', 1, 0, 0)
    `,
    ).run({ id: PROJECT_ID });
  });

  function insertLocalBranch(overrides: {
    id: number;
    review_result: string | null;
  }): void {
    db.prepare(
      `
      INSERT INTO local_branches
        (id, project_id, session_id, branch_name, status, review_result, created_at, updated_at)
      VALUES
        (@id, @project_id, @session_id, @branch_name, 'open', @review_result, @ts, @ts)
    `,
    ).run({
      id: overrides.id,
      project_id: PROJECT_ID,
      session_id: `sess-${overrides.id}`,
      branch_name: `branch-${overrides.id}`,
      review_result: overrides.review_result,
      ts: '2024-01-01T00:00:00Z',
    });
  }

  it('excludes a needs_changes verdict whose reviewer notes contain "approval"', () => {
    insertLocalBranch({
      id: 1,
      review_result: JSON.stringify({
        verdict: 'needs_changes',
        dimensions: [{ name: 'x', passed: false, notes: 'pending approval' }],
      }),
    });
    expect(getApprovedLocalBranches()).toHaveLength(0);
  });

  it('returns a branch whose verdict is approved', () => {
    insertLocalBranch({
      id: 2,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    expect(getApprovedLocalBranches().map((r) => r.id)).toEqual([2]);
  });

  it('does not treat "approved": false as approved', () => {
    insertLocalBranch({
      id: 3,
      review_result: JSON.stringify({
        verdict: 'needs_changes',
        approved: false,
      }),
    });
    expect(getApprovedLocalBranches()).toHaveLength(0);
  });
});
