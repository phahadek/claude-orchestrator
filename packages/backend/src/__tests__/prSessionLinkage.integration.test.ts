/**
 * Integration test for the orphaned-PR session recovery path: a PR row with
 * session_id/task_id null for a head_branch that matches a real, currently
 * running session must get backfilled via lookupSessionByBranch — through
 * both PRBootSweep (insert-time) and StalledPRReconciler (re-derivation on
 * an already-inserted orphaned row) — rather than falling through to
 * StalledPRReconciler's orphaned_no_task_link escalation.
 *
 * Uses the real sqlite db and real db/queries functions throughout (no
 * mocking of lookupSessionByBranch/getAllOpenPRs/upsertPullRequest/etc.) so
 * this exercises the actual worktree_path-can-never-match-head_branch fix,
 * not a mocked stand-in for it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../config.js', () => ({
  getProjectByGithubRepo: vi.fn(() => null),
}));

vi.mock('../session/sessionLifecycle.js', () => ({
  sessionBusyInFlightToolCall: vi.fn(() => false),
  sessionAwaitingOperatorDecision: vi.fn(() => false),
}));

import { db } from '../db/db.js';
import {
  insertSession,
  upsertPullRequest,
  getPRByNumber,
} from '../db/queries.js';
import { deriveBranchSlug } from '../session/branchSlug.js';
import { StalledPRReconciler } from '../orchestration/StalledPRReconciler.js';
import type { ServerMessage } from '../ws/types.js';

const REPO = 'owner/repo';
const NOW = '2026-01-01T00:00:00Z';

function insertTestProject(): void {
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', REPO, 'notion', 1000, 1000);
}

function insertRunningSession(
  sessionId: string,
  taskName: string,
  taskId: string,
): void {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    project_id: 'proj-1',
    status: 'running',
    started_at: Date.now(),
    ended_at: null,
    pr_url: null,
    // Realistic shape: keyed purely by the session's own UUID — never
    // contains a branch name.
    worktree_path: `/test/.claude/worktrees/${sessionId}`,
    session_type: 'standard',
    task_name: taskName,
  });
}

function insertOrphanedPR(prNumber: number, headBranch: string): void {
  upsertPullRequest({
    pr_number: prNumber,
    pr_url: `https://github.com/${REPO}/pull/${prNumber}`,
    task_id: null,
    session_id: null,
    repo: REPO,
    title: 'Some PR',
    body: null,
    head_branch: headBranch,
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
    head_sha: 'sha1',
    last_reviewed_sha: null,
    node_id: null,
    merge_state: null,
    merge_state_checked_at: null,
  });
}

function makeBroadcast() {
  const messages: ServerMessage[] = [];
  return {
    fn: (msg: ServerMessage) => messages.push(msg),
    messages,
  };
}

function makeReviewOrchestrator() {
  return {
    isReviewInFlight: vi.fn(() => false),
    enqueueReview: vi.fn(() => true),
  };
}

beforeEach(() => {
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM pull_requests');
  db.exec('DELETE FROM projects');
  insertTestProject();
});

describe('orphaned PR session recovery (integration)', () => {
  it('StalledPRReconciler re-derives session_id/task_id for an orphaned PR whose head_branch matches a real running session, instead of escalating to orphaned_no_task_link', async () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000099';
    const taskId = 'notion:real-task';
    const taskName = 'Fix the redirect handling';
    insertRunningSession(sessionId, taskName, taskId);

    const headBranch = deriveBranchSlug(taskName, taskId);
    insertOrphanedPR(101, headBranch);

    const { fn: broadcast, messages } = makeBroadcast();
    const ro = makeReviewOrchestrator();
    const reconciler = new StalledPRReconciler(broadcast, { retryCap: 2 });
    reconciler.setReviewOrchestrator(ro as any);

    await reconciler.reconcileOnce();

    const row = getPRByNumber(101, REPO);
    expect(row!.task_id).toBe(taskId);
    expect(row!.session_id).toBe(sessionId);

    // Must not have taken the orphaned escalation path.
    expect(
      messages.find((m) => m.type === 'pr_stalled_escalated'),
    ).toBeUndefined();
  });
});
