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
import { getPRs } from '../queries.js';

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
