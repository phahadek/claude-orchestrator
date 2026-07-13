/**
 * Tests for recordMergeCommitForSession — the uniform local_branches
 * persistence step used by PRMergeWatcher.handleMerged's merge-completion
 * helper. GitHub PR sessions never get a local_branches row from
 * sessionRecovery (only git_mode='local-only' sessions do), so this must
 * create the row on first merge rather than assume one exists.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import(
    '../../../test/helpers/setupTestDb.js'
  );
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  insertLocalBranch,
  getLocalBranchBySession,
  recordMergeCommitForSession,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(sessionId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status: 'done',
    started_at: 0,
    session_type: 'standard',
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

describe('recordMergeCommitForSession', () => {
  it('creates a local_branches row when the session has none (GitHub PR flow)', () => {
    seedSession('sess-github');

    recordMergeCommitForSession({
      sessionId: 'sess-github',
      projectId: 'proj-1',
      branchName: 'feature/foo',
      baseBranch: 'dev',
      commitSha: 'merged-sha-1',
    });

    const row = getLocalBranchBySession('sess-github');
    expect(row).toBeDefined();
    expect(row!.status).toBe('merged');
    expect(row!.merge_commit_sha).toBe('merged-sha-1');
    expect(row!.branch_name).toBe('feature/foo');
    expect(row!.base_branch).toBe('dev');
  });

  it('updates the existing local_branches row when one already exists (local-only flow)', () => {
    seedSession('sess-local');
    insertLocalBranch({
      project_id: 'proj-1',
      session_id: 'sess-local',
      branch_name: 'feature/bar',
      base_branch: 'dev',
      status: 'open',
      review_result: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });

    recordMergeCommitForSession({
      sessionId: 'sess-local',
      projectId: 'proj-1',
      branchName: 'feature/bar',
      baseBranch: 'dev',
      commitSha: 'merged-sha-2',
    });

    const rows = db
      .prepare('SELECT * FROM local_branches WHERE session_id = ?')
      .all('sess-local') as unknown[];
    expect(rows).toHaveLength(1);
    const row = getLocalBranchBySession('sess-local');
    expect(row!.status).toBe('merged');
    expect(row!.merge_commit_sha).toBe('merged-sha-2');
  });
});
