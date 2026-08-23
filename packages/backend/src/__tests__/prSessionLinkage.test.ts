import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import {
  lookupSessionByBranch,
  insertSession,
  upsertPullRequest,
  getPRByNumber,
} from '../db/queries.js';
import { deriveBranchSlug } from '../session/branchSlug.js';

/**
 * sessions.worktree_path is always `<projectDir>/.claude/worktrees/<uuid>` in
 * production (see SessionManager.start/respawnSession) — purely keyed by the
 * session's own UUID, with no branch-name component anywhere in it.
 */
function realisticWorktreePath(sessionId: string): string {
  return `/home/user/projects/demo/.claude/worktrees/${sessionId}`;
}

function insertTestSession(
  sessionId: string,
  taskName: string | null,
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
    worktree_path: realisticWorktreePath(sessionId),
    session_type: 'standard',
    task_name: taskName,
  });
}

beforeEach(() => {
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM pull_requests');
  db.exec('DELETE FROM projects');
  // upsertPullRequest rejects PRs for repos not configured on a project, to
  // avoid creating phantom rows — seed a project so 'o/r' is recognized.
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'o/r', 'notion', 1000, 1000);
});

describe('lookupSessionByBranch', () => {
  it('matches a session whose worktree_path is realistically UUID-keyed and does not contain the branch name', () => {
    const sessionId = 'a1b2c3d4-0000-0000-0000-000000000001';
    insertTestSession(sessionId, 'My Task', 'task-001');
    const headBranch = deriveBranchSlug('My Task', 'task-001');

    // Sanity-check the fixture is realistic: the branch name is NOT a
    // substring of worktree_path, so the old LIKE-based lookup would (and did)
    // always return null here.
    expect(realisticWorktreePath(sessionId).includes(headBranch)).toBe(false);

    const match = lookupSessionByBranch(headBranch);
    expect(match).not.toBeNull();
    expect(match!.session_id).toBe(sessionId);
    expect(match!.task_id).toBe('task-001');
  });

  it('returns null when no session derives a matching branch', () => {
    insertTestSession('sess-11111111', 'Other Task', 'task-002');
    const match = lookupSessionByBranch('feature/no-such-branch');
    expect(match).toBeNull();
  });

  it('returns null when multiple sessions derive the same branch (ambiguous)', () => {
    insertTestSession('sess-aaaaaaaa', 'Shared Name', 'task-a');
    insertTestSession('sess-bbbbbbbb', 'Shared Name', 'task-b');
    const headBranch = deriveBranchSlug('Shared Name', 'task-a');
    const match = lookupSessionByBranch(headBranch);
    expect(match).toBeNull();
  });

  it('matches the legacy title-only derivation for branches created before the task-id suffix', () => {
    const sessionId = 'sess-cccccccc';
    const longTitle =
      'A very long task title that exceeds the branch slug length cap and therefore gets a task-id-derived hash suffix appended';
    insertTestSession(sessionId, longTitle, 'task-long-id');

    const legacyBranch = deriveBranchSlug(longTitle, null);
    const currentBranch = deriveBranchSlug(longTitle, 'task-long-id');
    expect(legacyBranch).not.toBe(currentBranch);

    const match = lookupSessionByBranch(legacyBranch);
    expect(match).not.toBeNull();
    expect(match!.session_id).toBe(sessionId);
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
