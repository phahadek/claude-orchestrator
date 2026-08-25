/**
 * Real-DB-level tests for clearTerminalPRFlags. Kept in its own file because
 * it needs the real db/queries.ts implementation backed by an in-memory
 * SQLite db, which is incompatible with the fully-mocked '../db/queries.js'
 * module used by the PRMergeWatcher call-site tests in
 * clearTerminalPRFlags.test.ts (vi.mock is hoisted per-module, so having both
 * mock strategies in one file causes the last vi.mock('../db/queries.js', ...)
 * call to win for the whole file).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  return { db };
});

vi.mock('../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));

import { db } from '../db/db.js';
import { recordEvent } from '../audit/AuditLog.js';
import {
  clearTerminalPRFlags,
  setPauseReason,
  setPreReviewStage,
  setReconcileExhausted,
  upsertPullRequest,
  incrementStalledPRRetryCount,
  setStalledRetryBaseExhausted,
} from '../db/queries.js';
import { isMergeBlockingPause } from '../db/pauseReason.js';

const NOW = '2024-01-01T00:00:00Z';

function insertPR(prNumber: number, repo = 'owner/repo'): void {
  upsertPullRequest({
    pr_number: prNumber,
    pr_url: `https://github.com/${repo}/pull/${prNumber}`,
    task_id: null,
    session_id: null,
    repo,
    title: `PR ${prNumber}`,
    body: null,
    head_branch: 'feature/x',
    base_branch: 'dev',
    state: 'open',
    draft: 0,
    review_result: null,
    review_at: null,
    created_at: NOW,
    updated_at: NOW,
    synced_at: NOW,
    review_iteration: 0,
    review_session_id: null,
    head_sha: null,
    last_reviewed_sha: null,
    node_id: null,
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
  });
}

function getPRRow(prNumber: number, repo = 'owner/repo') {
  return db
    .prepare<{ pr_number: number; repo: string }>(
      `SELECT pause_reason, pause_reason_set_at, pre_review_stage, reconcile_exhausted
       FROM pull_requests
       WHERE pr_number = @pr_number AND repo = @repo`,
    )
    .get({ pr_number: prNumber, repo }) as
    | {
        pause_reason: string | null;
        pause_reason_set_at: number | null;
        pre_review_stage: string | null;
        reconcile_exhausted: number;
      }
    | undefined;
}

function getRetryBudgetRow(prNumber: number, repo = 'owner/repo') {
  return db
    .prepare<{ pr_number: number; repo: string }>(
      `SELECT stalled_pr_retry_count, stalled_retry_base_exhausted
       FROM pull_requests
       WHERE pr_number = @pr_number AND repo = @repo`,
    )
    .get({ pr_number: prNumber, repo }) as
    | {
        stalled_pr_retry_count: number;
        stalled_retry_base_exhausted: number;
      }
    | undefined;
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  vi.clearAllMocks();
});

describe('clearTerminalPRFlags — DB helper', () => {
  it('nulls pause_reason, pause_reason_set_at, and pre_review_stage', () => {
    insertPR(1);
    setPauseReason(1, 'owner/repo', 'review_failed');
    setPreReviewStage(1, 'owner/repo', 'autofix');

    const before = getPRRow(1);
    expect(before?.pause_reason).not.toBeNull();
    expect(before?.pause_reason_set_at).not.toBeNull();
    expect(before?.pre_review_stage).toBe('autofix');

    clearTerminalPRFlags(1, 'owner/repo', 'closed');

    const after = getPRRow(1);
    expect(after?.pause_reason).toBeNull();
    expect(after?.pause_reason_set_at).toBeNull();
    expect(after?.pre_review_stage).toBeNull();
  });

  it('is a no-op when both fields are already null', () => {
    insertPR(2);
    expect(() => clearTerminalPRFlags(2, 'owner/repo', 'closed')).not.toThrow();
    const row = getPRRow(2);
    expect(row?.pause_reason).toBeNull();
    expect(row?.pre_review_stage).toBeNull();
  });

  it('emits pr_terminal_flags_cleared audit event with pr_number and repo', () => {
    insertPR(3);
    clearTerminalPRFlags(3, 'owner/repo', 'closed');
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'pr_terminal_flags_cleared',
        actor_type: 'system',
        payload: expect.objectContaining({ pr_number: 3, repo: 'owner/repo' }),
      }),
    );
  });

  it('does NOT clear reconcile_exhausted when trigger is review_verdict, but still discharges a live cause', () => {
    insertPR(4);
    setReconcileExhausted(4, 'owner/repo', true);
    setPauseReason(4, 'owner/repo', 'review_failed');

    clearTerminalPRFlags(4, 'owner/repo', 'review_verdict');

    const after = getPRRow(4);
    expect(after?.reconcile_exhausted).toBe(1);
    // pause_reason clearing is orthogonal to reconcile_exhausted gating —
    // the live cause is still discharged.
    expect(after?.pause_reason).toBeNull();
  });

  it.each(['merged', 'closed', 'head_sha_advance', 'human_unpark'] as const)(
    'clears reconcile_exhausted when trigger is %s',
    (trigger) => {
      insertPR(5);
      setReconcileExhausted(5, 'owner/repo', true);

      clearTerminalPRFlags(5, 'owner/repo', trigger);

      const after = getPRRow(5);
      expect(after?.reconcile_exhausted).toBe(0);
    },
  );

  it('clears baseline_escalation_floor via human_unpark, and isMergeBlockingPause reports false afterward', () => {
    insertPR(6);
    setPauseReason(6, 'owner/repo', 'baseline_escalation_floor');

    const before = getPRRow(6);
    expect(isMergeBlockingPause(before?.pause_reason ?? null)).toBe(true);

    clearTerminalPRFlags(6, 'owner/repo', 'human_unpark');

    const after = getPRRow(6);
    expect(after?.pause_reason).toBeNull();
    expect(isMergeBlockingPause(after?.pause_reason ?? null)).toBe(false);
  });

  it('restores stalled_pr_retry_count and stalled_retry_base_exhausted when clearing a live reconcile_exhausted via human_unpark', () => {
    insertPR(7);
    setReconcileExhausted(7, 'owner/repo', true);
    incrementStalledPRRetryCount(7, 'owner/repo');
    incrementStalledPRRetryCount(7, 'owner/repo');
    setStalledRetryBaseExhausted(7, 'owner/repo', true);

    const before = getRetryBudgetRow(7);
    expect(before?.stalled_pr_retry_count).toBe(2);
    expect(before?.stalled_retry_base_exhausted).toBe(1);

    clearTerminalPRFlags(7, 'owner/repo', 'human_unpark');

    const after = getRetryBudgetRow(7);
    expect(after?.stalled_pr_retry_count).toBe(0);
    expect(after?.stalled_retry_base_exhausted).toBe(0);
    expect(getPRRow(7)?.reconcile_exhausted).toBe(0);
  });

  it('restores the retry budget on human_unpark even when reconcile_exhausted was never set — the counter that caps dispatch, not the orthogonal flag, is what gates the reset', () => {
    insertPR(8);
    setPauseReason(8, 'owner/repo', 'baseline_escalation_floor');
    incrementStalledPRRetryCount(8, 'owner/repo');

    clearTerminalPRFlags(8, 'owner/repo', 'human_unpark');

    // A PR can sit at stalled_pr_retry_count > 0 with reconcile_exhausted = 0
    // (StalledPRReconciler's retryCap check escalates on the counter alone).
    // human_unpark must still restore it, or the very next stall re-hits an
    // already-exhausted counter with zero fresh attempts.
    const after = getRetryBudgetRow(8);
    expect(after?.stalled_pr_retry_count).toBe(0);
  });

  it('does NOT restore the retry budget for a human_unpark when the counter is already 0', () => {
    insertPR(10);
    setPauseReason(10, 'owner/repo', 'baseline_escalation_floor');

    clearTerminalPRFlags(10, 'owner/repo', 'human_unpark');

    const after = getRetryBudgetRow(10);
    expect(after?.stalled_pr_retry_count).toBe(0);
  });

  it('does NOT restore the retry budget for a non-human_unpark trigger', () => {
    insertPR(11);
    incrementStalledPRRetryCount(11, 'owner/repo');
    incrementStalledPRRetryCount(11, 'owner/repo');

    clearTerminalPRFlags(11, 'owner/repo', 'closed');

    const after = getRetryBudgetRow(11);
    expect(after?.stalled_pr_retry_count).toBe(2);
  });

  it('an operator rerun (budget restored) does not immediately re-hit the cap — re-escalation only after the restored budget is genuinely spent', () => {
    insertPR(9);
    setReconcileExhausted(9, 'owner/repo', true);
    incrementStalledPRRetryCount(9, 'owner/repo');
    incrementStalledPRRetryCount(9, 'owner/repo');

    const retryCap = 2;
    clearTerminalPRFlags(9, 'owner/repo', 'human_unpark');

    // Immediately after the rerun, the restored count is well under the cap.
    let row = getRetryBudgetRow(9);
    expect(row?.stalled_pr_retry_count).toBeLessThan(retryCap);

    // The stall persists and genuinely re-drives retryCap more times before
    // the budget is exhausted again — not on the very next tick.
    for (let i = 0; i < retryCap; i++) {
      row = getRetryBudgetRow(9);
      expect(row?.stalled_pr_retry_count ?? 0).toBeLessThan(retryCap);
      incrementStalledPRRetryCount(9, 'owner/repo');
    }
    row = getRetryBudgetRow(9);
    expect(row?.stalled_pr_retry_count).toBe(retryCap);
  });
});
