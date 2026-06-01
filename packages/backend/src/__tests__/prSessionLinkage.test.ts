import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  const { applyTestSchema } = await import('../../test/helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

import { db } from '../db/db.js';
import { lookupSessionByBranch, insertSession, upsertPullRequest, getPRByNumber } from '../db/queries.js';

function insertTestSession(
  sessionId: string,
  worktreePath: string,
  taskId: string | null = null,
): void {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    project_id: null,
    status: 'running',
    started_at: Date.now(),
    ended_at: null,
    pr_url: null,
    worktree_path: worktreePath,
    session_type: 'standard',
    task_name: null,
  });
}

beforeEach(() => {
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM pull_requests');
});

describe('lookupSessionByBranch', () => {
  it('returns session when exactly one worktree_path matches', () => {
    insertTestSession('sess-aabbccdd', '/worktrees/abc123/feature/my-task', 'task-001');
    const match = lookupSessionByBranch('feature/my-task');
    expect(match).not.toBeNull();
    expect(match!.session_id).toBe('sess-aabbccdd');
    expect(match!.task_id).toBe('task-001');
  });

  it('returns null when no session worktree_path matches', () => {
    insertTestSession('sess-11111111', '/worktrees/abc/feature/other-task');
    const match = lookupSessionByBranch('feature/no-such-branch');
    expect(match).toBeNull();
  });

  it('returns null when multiple sessions match (ambiguous)', () => {
    insertTestSession('sess-aaaaaaaa', '/worktrees/w1/feature/shared-name');
    insertTestSession('sess-bbbbbbbb', '/worktrees/w2/feature/shared-name');
    const match = lookupSessionByBranch('feature/shared-name');
    expect(match).toBeNull();
  });

  it('matches a session/<id> style branch embedded in worktree_path', () => {
    insertTestSession('sess-cccccccc', '/worktrees/ba902f90/session/d02abb9b');
    const match = lookupSessionByBranch('session/d02abb9b');
    expect(match).not.toBeNull();
    expect(match!.session_id).toBe('sess-cccccccc');
  });
});

describe('upsertPullRequest session linkage on insert', () => {
  const now = '2026-01-01T00:00:00Z';

  it('preserves existing session_id when upserted with a null session_id', () => {
    upsertPullRequest({
      pr_number: 1,
      pr_url: 'https://github.com/o/r/pull/1',
      task_id: 'task-abc',
      session_id: 'sess-existing',
      repo: 'o/r',
      title: 'PR 1',
      body: null,
      head_branch: 'feature/t1',
      base_branch: 'dev',
      state: 'open',
      draft: 0,
      review_result: null,
      review_at: null,
      created_at: now,
      updated_at: now,
      synced_at: now,
      review_iteration: 0,
      review_session_id: null,
      head_sha: null,
      last_reviewed_sha: null,
      node_id: null,
      merge_state: null,
      merge_state_checked_at: null,
    });

    // Re-upsert with null session_id (e.g. from a second sync)
    upsertPullRequest({
      pr_number: 1,
      pr_url: 'https://github.com/o/r/pull/1',
      task_id: null,
      session_id: null,
      repo: 'o/r',
      title: 'PR 1',
      body: null,
      head_branch: 'feature/t1',
      base_branch: 'dev',
      state: 'open',
      draft: 0,
      review_result: null,
      review_at: null,
      created_at: now,
      updated_at: now,
      synced_at: now,
      review_iteration: 0,
      review_session_id: null,
      head_sha: null,
      last_reviewed_sha: null,
      node_id: null,
      merge_state: null,
      merge_state_checked_at: null,
    });

    const row = getPRByNumber(1, 'o/r');
    expect(row!.session_id).toBe('sess-existing');
    expect(row!.task_id).toBe('task-abc');
  });
});
