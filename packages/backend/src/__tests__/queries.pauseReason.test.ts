import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  getApprovedOpenPRs,
  getPausedPrReasonForTask,
  resetReviewIteration,
  setPauseReason,
} from '../db/queries.js';
import { deriveDisplayStatus } from '../tasks/TaskStatusEngine.js';

const NOW = '2024-01-01T00:00:00Z';

function insertPR(opts: {
  pr_number: number;
  task_id?: string | null;
  state?: string;
  review_result?: string | null;
  pause_reason?: string | null;
}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, session_id, repo, state,
       review_result, created_at, updated_at, synced_at, pause_reason)
    VALUES
      (@pr_number, @pr_url, @task_id, NULL, 'owner/repo', @state,
       @review_result, @created_at, @updated_at, @synced_at, @pause_reason)
  `,
  ).run({
    pr_number: opts.pr_number,
    pr_url: `https://github.com/owner/repo/pull/${opts.pr_number}`,
    task_id: opts.task_id ?? null,
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
    insertPR({
      pr_number: 1,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
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
    insertPR({
      pr_number: 10,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    insertPR({
      pr_number: 11,
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });
    insertPR({
      pr_number: 12,
      review_result: JSON.stringify({ verdict: 'approved' }),
    });
    const rows = getApprovedOpenPRs()
      .map((r) => r.pr_number)
      .sort((a, b) => a - b);
    expect(rows).toEqual([10, 12]);
  });
});

describe('resetReviewIteration() — resume-mechanism contract', () => {
  it('clears pause_reason=stuck_timeout when called via the re-review pathway', () => {
    insertPR({ pr_number: 20, pause_reason: 'stuck_timeout' });
    db.prepare(
      'UPDATE pull_requests SET review_iteration = 3 WHERE pr_number = 20',
    ).run();

    resetReviewIteration(20, 'owner/repo');

    const row = db
      .prepare(
        'SELECT review_iteration, pause_reason FROM pull_requests WHERE pr_number = 20',
      )
      .get() as { review_iteration: number; pause_reason: string | null };
    expect(row.review_iteration).toBe(0);
    expect(row.pause_reason).toBeNull();
  });

  it('after reset, the PR is no longer skipped by AutoLauncher / Auto-merger queries', () => {
    insertPR({
      pr_number: 21,
      task_id: 'notion:task-abc',
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'stuck_timeout',
    });

    // Pre-reset: blocked
    expect(getApprovedOpenPRs()).toHaveLength(0);
    expect(getPausedPrReasonForTask('notion:task-abc')).toBe('stuck_timeout');

    // Reset (mirrors the re-review endpoint)
    resetReviewIteration(21, 'owner/repo');

    // Post-reset: unblocked
    expect(getApprovedOpenPRs()).toHaveLength(1);
    expect(getPausedPrReasonForTask('notion:task-abc')).toBeNull();
  });
});

describe('setPauseReason() round-trip', () => {
  it('a stuck_timeout pause set by the monitor flows through getPausedPrReasonForTask', () => {
    insertPR({ pr_number: 30, task_id: 'notion:task-xyz' });
    setPauseReason(30, 'owner/repo', 'stuck_timeout');
    expect(getPausedPrReasonForTask('notion:task-xyz')).toBe('stuck_timeout');
  });

  it('a review_failed pause set by the catch site flows through getPausedPrReasonForTask', () => {
    insertPR({ pr_number: 31, task_id: 'notion:task-review-failed' });
    setPauseReason(31, 'owner/repo', 'review_failed');
    expect(getPausedPrReasonForTask('notion:task-review-failed')).toBe(
      'review_failed',
    );
  });
});

describe('TaskStatusEngine regression — review_failed resolves to needs_attention', () => {
  it('deriveDisplayStatus returns needs_attention when pauseReason is review_failed', () => {
    const status = deriveDisplayStatus({
      notionStatus: '👀 In Review',
      codeSessionStatus: 'done',
      prState: 'open',
      prDraft: false,
      reviewVerdict: 'needs_changes',
      reviewIterationCount: 1,
      reviewIterationCap: 3,
      pauseReason: 'review_failed',
    });
    expect(status).toBe('needs_attention');
  });

  it('deriveDisplayStatus returns needs_attention for review_failed outside In Review', () => {
    const status = deriveDisplayStatus({
      notionStatus: '💻 In Progress',
      codeSessionStatus: 'running',
      prState: null,
      prDraft: false,
      reviewVerdict: null,
      reviewIterationCount: 0,
      reviewIterationCap: 3,
      pauseReason: 'review_failed',
    });
    expect(status).toBe('needs_attention');
  });
});

describe('resetReviewIteration() — review_failed reset coverage', () => {
  it('clears pause_reason=review_failed when called via the re-review pathway', () => {
    insertPR({ pr_number: 40, pause_reason: 'review_failed' });
    db.prepare(
      'UPDATE pull_requests SET review_iteration = 2 WHERE pr_number = 40',
    ).run();

    resetReviewIteration(40, 'owner/repo');

    const row = db
      .prepare(
        'SELECT review_iteration, pause_reason FROM pull_requests WHERE pr_number = 40',
      )
      .get() as { review_iteration: number; pause_reason: string | null };
    expect(row.review_iteration).toBe(0);
    expect(row.pause_reason).toBeNull();
  });

  it('after reset, a review_failed-paused PR is unblocked in AutoLauncher / Auto-merger queries', () => {
    insertPR({
      pr_number: 41,
      task_id: 'notion:task-review-failed-2',
      review_result: JSON.stringify({ verdict: 'approved' }),
      pause_reason: 'review_failed',
    });

    // Pre-reset: blocked
    expect(getApprovedOpenPRs()).toHaveLength(0);
    expect(getPausedPrReasonForTask('notion:task-review-failed-2')).toBe(
      'review_failed',
    );

    // Reset (mirrors the re-review endpoint)
    resetReviewIteration(41, 'owner/repo');

    // Post-reset: unblocked
    expect(getApprovedOpenPRs()).toHaveLength(1);
    expect(getPausedPrReasonForTask('task-review-failed-2')).toBeNull();
  });
});
