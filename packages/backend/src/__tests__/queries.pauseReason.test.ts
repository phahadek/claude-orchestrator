import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../../test/helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

import { db } from '../db/db.js';
import {
  getApprovedOpenPRs,
  getPausedPrReasonForTask,
  resetReviewIteration,
  setPauseReason,
} from '../db/queries.js';

const NOW = '2024-01-01T00:00:00Z';

function insertPR(opts: {
  pr_number: number;
  notion_task_id?: string | null;
  state?: string;
  review_result?: string | null;
  pause_reason?: string | null;
}): void {
  db.prepare(`
    INSERT INTO pull_requests
      (pr_number, pr_url, notion_task_id, session_id, repo, state,
       review_result, created_at, updated_at, synced_at, pause_reason)
    VALUES
      (@pr_number, @pr_url, @notion_task_id, NULL, 'owner/repo', @state,
       @review_result, @created_at, @updated_at, @synced_at, @pause_reason)
  `).run({
    pr_number: opts.pr_number,
    pr_url: `https://github.com/owner/repo/pull/${opts.pr_number}`,
    notion_task_id: opts.notion_task_id ?? null,
    state: opts.state ?? 'open',
    review_result: opts.review_result ?? null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    pause_reason: opts.pause_reason ?? null,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
});

describe('getApprovedOpenPRs() — Auto-merger candidate query', () => {
  it('returns approved open PRs with no pause_reason', () => {
    insertPR({ pr_number: 1, review_result: JSON.stringify({ verdict: 'approved' }) });
    const rows = getApprovedOpenPRs();
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_number).toBe(1);
  });

  it('excludes approved open PRs paused by stuck_timeout', () => {
    insertPR({
      pr_number: 2,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('excludes approved open PRs paused by max_reviews', () => {
    insertPR({
      pr_number: 3,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'max_reviews',
    });
    expect(getApprovedOpenPRs()).toHaveLength(0);
  });

  it('returns the mix of paused/unpaused approved PRs minus paused ones', () => {
    insertPR({ pr_number: 10, review_result: JSON.stringify({ verdict: 'approved' }) });
    insertPR({
      pr_number: 11,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });
    insertPR({ pr_number: 12, review_result: JSON.stringify({ verdict: 'approved' }) });
    const rows = getApprovedOpenPRs().map((r) => r.pr_number).sort((a, b) => a - b);
    expect(rows).toEqual([10, 12]);
  });
});

describe('resetReviewIteration() — resume-mechanism contract', () => {
  it('clears pause_reason=stuck_timeout when called via the re-review pathway', () => {
    insertPR({ pr_number: 20, pause_reason: 'stuck_timeout' });
    db.prepare('UPDATE pull_requests SET review_iteration = 3 WHERE pr_number = 20').run();

    resetReviewIteration(20, 'owner/repo');

    const row = db.prepare('SELECT review_iteration, pause_reason FROM pull_requests WHERE pr_number = 20')
      .get() as { review_iteration: number; pause_reason: string | null };
    expect(row.review_iteration).toBe(0);
    expect(row.pause_reason).toBeNull();
  });

  it('after reset, the PR is no longer skipped by AutoLauncher / Auto-merger queries', () => {
    insertPR({
      pr_number: 21,
      notion_task_id: 'task-abc',
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });

    // Pre-reset: blocked
    expect(getApprovedOpenPRs()).toHaveLength(0);
    expect(getPausedPrReasonForTask('task-abc')).toBe('stuck_timeout');

    // Reset (mirrors the re-review endpoint)
    resetReviewIteration(21, 'owner/repo');

    // Post-reset: unblocked
    expect(getApprovedOpenPRs()).toHaveLength(1);
    expect(getPausedPrReasonForTask('task-abc')).toBeNull();
  });
});

describe('setPauseReason() round-trip', () => {
  it('a stuck_timeout pause set by the monitor flows through getPausedPrReasonForTask', () => {
    insertPR({ pr_number: 30, notion_task_id: 'task-xyz' });
    setPauseReason(30, 'owner/repo', 'stuck_timeout');
    expect(getPausedPrReasonForTask('task-xyz')).toBe('stuck_timeout');
  });
});
