/**
 * clearPauseReasonEntry removes a single reason from the concurrent
 * pause-reason set by reason (not source), leaving every other live entry
 * byte-identical — see ReviewOrchestrator.clearDepthReviewHoldAndRemerge,
 * the motivating caller that must clear depth_review_pending without
 * disturbing a co-occurring, higher-severity, non-blocking entry such as
 * test_report_acquisition_failed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { clearPauseReasonEntry, setPauseReason } from '../queries.js';
import { isMergeBlockingPause, parsePauseReasonSet } from '../pauseReason.js';

const REPO = 'owner/repo';
const PR_NUMBER = 42;

function seedPR(overrides: Record<string, unknown> = {}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, pause_reason, pause_reason_set_at)
    VALUES
      (@pr_number, @pr_url, @task_id, @repo, @state, 0, @review_result, NULL,
       '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z',
       @pause_reason, @pause_reason_set_at)
  `,
  ).run({
    pr_number: PR_NUMBER,
    pr_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    task_id: 'task-pr-1',
    repo: REPO,
    state: 'open',
    review_result: null,
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

function getRow() {
  return db
    .prepare(`SELECT * FROM pull_requests WHERE pr_number = ? AND repo = ?`)
    .get(PR_NUMBER, REPO) as {
    pause_reason: string | null;
    pause_reason_set_at: number | null;
  };
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('clearPauseReasonEntry', () => {
  it('removes only the named reason from a two-entry set, leaving the surviving entry untouched', () => {
    seedPR();
    setPauseReason(PR_NUMBER, REPO, 'depth_review_pending');
    setPauseReason(PR_NUMBER, REPO, 'test_report_acquisition_failed');

    const before = getRow();
    const survivorBefore = parsePauseReasonSet(before.pause_reason).find(
      (e) => e.reason === 'test_report_acquisition_failed',
    );
    expect(survivorBefore).toBeDefined();

    clearPauseReasonEntry(PR_NUMBER, REPO, 'depth_review_pending');

    const after = getRow();
    const set = parsePauseReasonSet(after.pause_reason);
    expect(set).toHaveLength(1);
    expect(set[0]).toEqual(survivorBefore);
  });

  it('writes pause_reason = NULL and pause_reason_set_at = NULL when removing the last remaining entry', () => {
    seedPR();
    setPauseReason(PR_NUMBER, REPO, 'depth_review_pending');

    clearPauseReasonEntry(PR_NUMBER, REPO, 'depth_review_pending');

    const after = getRow();
    expect(after.pause_reason).toBeNull();
    expect(after.pause_reason_set_at).toBeNull();
  });

  it('records exactly one pr_pause_reason_changed audit row with pre/post values, and none when the reason is absent', () => {
    seedPR();
    setPauseReason(PR_NUMBER, REPO, 'depth_review_pending');
    setPauseReason(PR_NUMBER, REPO, 'test_report_acquisition_failed');
    db.prepare('DELETE FROM audit_log').run();

    const before = getRow();
    clearPauseReasonEntry(PR_NUMBER, REPO, 'depth_review_pending');
    const after = getRow();

    const events = auditEvents('pr_pause_reason_changed');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.from).toBe(before.pause_reason);
    expect(payload.to).toBe(after.pause_reason);

    db.prepare('DELETE FROM audit_log').run();
    clearPauseReasonEntry(PR_NUMBER, REPO, 'depth_review_pending');
    expect(auditEvents('pr_pause_reason_changed')).toHaveLength(0);
  });

  it('reconstructs the #1064 incident set and confirms the PR is no longer merge-blocking after clearing depth_review_pending', () => {
    seedPR();
    setPauseReason(PR_NUMBER, REPO, 'depth_review_pending');
    setPauseReason(PR_NUMBER, REPO, 'test_report_acquisition_failed');

    const beforeSet = parsePauseReasonSet(getRow().pause_reason);
    expect(beforeSet.map((e) => e.reason).sort()).toEqual(
      ['depth_review_pending', 'test_report_acquisition_failed'].sort(),
    );
    expect(isMergeBlockingPause(getRow().pause_reason)).toBe(true);

    clearPauseReasonEntry(PR_NUMBER, REPO, 'depth_review_pending');

    const afterRow = getRow();
    const afterSet = parsePauseReasonSet(afterRow.pause_reason);
    expect(afterSet).toHaveLength(1);
    expect(afterSet[0].reason).toBe('test_report_acquisition_failed');
    expect(isMergeBlockingPause(afterRow.pause_reason)).toBe(false);
  });
});
