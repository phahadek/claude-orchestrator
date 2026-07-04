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
  upsertPullRequest,
} from '../db/queries.js';

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
      `SELECT pause_reason, pause_reason_set_at, pre_review_stage
       FROM pull_requests
       WHERE pr_number = @pr_number AND repo = @repo`,
    )
    .get({ pr_number: prNumber, repo }) as
    | {
        pause_reason: string | null;
        pause_reason_set_at: number | null;
        pre_review_stage: string | null;
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
    expect(() =>
      clearTerminalPRFlags(2, 'owner/repo', 'closed'),
    ).not.toThrow();
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

  it('does NOT clear pause_reason when stalled_reconcile_cap and trigger is review_verdict', () => {
    insertPR(4);
    setPauseReason(4, 'owner/repo', 'stalled_reconcile_cap');

    clearTerminalPRFlags(4, 'owner/repo', 'review_verdict');

    const after = getPRRow(4);
    expect(after?.pause_reason).not.toBeNull();
    expect(JSON.parse(after!.pause_reason!).reason).toBe(
      'stalled_reconcile_cap',
    );
  });

  it.each(['merged', 'closed', 'head_sha_advance', 'human_unpark'] as const)(
    'clears stalled_reconcile_cap when trigger is %s',
    (trigger) => {
      insertPR(5);
      setPauseReason(5, 'owner/repo', 'stalled_reconcile_cap');

      clearTerminalPRFlags(5, 'owner/repo', trigger);

      const after = getPRRow(5);
      expect(after?.pause_reason).toBeNull();
    },
  );
});
