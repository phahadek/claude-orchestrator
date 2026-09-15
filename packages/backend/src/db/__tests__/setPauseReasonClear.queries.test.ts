/**
 * Audits every pause_reason clear at the write path: setPauseReason(n, repo,
 * null) must always emit pr_pause_reason_changed, and every caller that
 * clears pause_reason — including the raw-SQL clears in resetReviewIteration
 * and clearPausedPrReasonForTask — must route through it rather than
 * bypassing the audit trail. See the polimarket PR #1405 incident: pause_reason
 * went from ci_failing to NULL with no pr_pause_reason_changed row recorded.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  setPauseReason,
  resetReviewIteration,
  clearPausedPrReasonForTask,
} from '../queries.js';

const REPO = 'owner/repo';

function seedPR(prNumber: number, overrides: Record<string, unknown> = {}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, review_iteration, pause_reason, pause_reason_set_at)
    VALUES
      (@pr_number, @pr_url, @task_id, @repo, @state, 0, @review_result, NULL,
       '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
       @review_iteration, @pause_reason, @pause_reason_set_at)
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/${REPO}/pull/${prNumber}`,
    task_id: 'task-pr-1',
    repo: REPO,
    state: 'open',
    review_result: null,
    review_iteration: 1,
    pause_reason: null,
    pause_reason_set_at: null,
    ...overrides,
  });
}

function auditEvents(
  eventType: string,
): Array<{ payload: string; task_id: string | null }> {
  return db
    .prepare(`SELECT payload, task_id FROM audit_log WHERE event_type = ?`)
    .all(eventType) as Array<{ payload: string; task_id: string | null }>;
}

function getRow(prNumber: number) {
  return db
    .prepare(`SELECT * FROM pull_requests WHERE pr_number = ? AND repo = ?`)
    .get(prNumber, REPO) as {
    pause_reason: string | null;
    pause_reason_set_at: number | null;
    review_iteration: number;
  };
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('setPauseReason(prNumber, repo, null)', () => {
  it('emits exactly one pr_pause_reason_changed row with from = prior set and to = null', () => {
    seedPR(42);
    setPauseReason(42, REPO, 'ci_failing');
    db.prepare('DELETE FROM audit_log').run();
    const before = getRow(42);

    setPauseReason(42, REPO, null);

    const after = getRow(42);
    expect(after.pause_reason).toBeNull();
    const events = auditEvents('pr_pause_reason_changed');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.from).toBe(before.pause_reason);
    expect(payload.to).toBeNull();
  });

  it('does not emit when pause_reason was already null', () => {
    seedPR(42);
    setPauseReason(42, REPO, null);
    expect(auditEvents('pr_pause_reason_changed')).toHaveLength(0);
  });
});

describe('resetReviewIteration — pause_reason clear is audited', () => {
  it('clears pause_reason, resets review_iteration, and emits pr_pause_reason_changed', () => {
    seedPR(42, { review_iteration: 3 });
    setPauseReason(42, REPO, 'ci_failing');
    db.prepare('DELETE FROM audit_log').run();

    resetReviewIteration(42, REPO);

    const after = getRow(42);
    expect(after.pause_reason).toBeNull();
    expect(after.review_iteration).toBe(0);
    expect(auditEvents('pr_pause_reason_changed')).toHaveLength(1);
  });

  it('does not emit when there was no pause to clear', () => {
    seedPR(42, { review_iteration: 2 });
    resetReviewIteration(42, REPO);
    expect(auditEvents('pr_pause_reason_changed')).toHaveLength(0);
  });
});

describe('clearPausedPrReasonForTask — pause_reason clear is audited', () => {
  it('clears pause_reason on every PR for the task and emits one event per row', () => {
    seedPR(42, { task_id: 'task-shared' });
    seedPR(43, { task_id: 'task-shared' });
    setPauseReason(42, REPO, 'stuck_timeout');
    setPauseReason(43, REPO, 'ci_failing');
    db.prepare('DELETE FROM audit_log').run();

    clearPausedPrReasonForTask('task-shared');

    expect(getRow(42).pause_reason).toBeNull();
    expect(getRow(43).pause_reason).toBeNull();
    expect(auditEvents('pr_pause_reason_changed')).toHaveLength(2);
  });

  it('does not touch or emit for PRs with no pause_reason', () => {
    seedPR(42, { task_id: 'task-shared' });
    clearPausedPrReasonForTask('task-shared');
    expect(auditEvents('pr_pause_reason_changed')).toHaveLength(0);
  });
});
