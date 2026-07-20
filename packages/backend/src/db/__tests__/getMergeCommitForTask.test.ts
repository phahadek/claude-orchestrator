/**
 * Tests for getMergeCommitForTask's pull_requests fallback — recovers the
 * merge commit for tasks merged by sessions that predate local_branches
 * tracking (no local_branches row at all), without ever substituting the
 * PR's head_sha (the pre-merge feature tip, not the commit landed on base).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetMergeCommitSha = vi.fn();

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../github/GitHubClient', () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    getMergeCommitSha: mockGetMergeCommitSha,
  })),
}));

import { db } from '../db.js';
import {
  insertSession,
  insertLocalBranch,
  markLocalBranchMerged,
  getMergeCommitForTask,
} from '../queries.js';

beforeEach(() => {
  vi.clearAllMocks();
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(sessionId: string, taskId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
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

function seedPullRequest(params: {
  taskId: string;
  prNumber: number;
  repo: string;
  headSha: string;
  state: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, session_id, repo, title, body,
       head_branch, base_branch, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, head_sha)
    VALUES
      (@pr_number, @pr_url, @task_id, NULL, @repo, NULL, NULL,
       'feature/x', 'dev', @state, 0, NULL, NULL,
       @now, @now, @now, @head_sha)
  `,
  ).run({
    pr_number: params.prNumber,
    pr_url: `https://github.com/${params.repo}/pull/${params.prNumber}`,
    task_id: params.taskId,
    repo: params.repo,
    state: params.state,
    now,
    head_sha: params.headSha,
  });
}

describe('getMergeCommitForTask', () => {
  it('returns the local_branches merge commit when a merged row exists (unchanged behaviour)', async () => {
    seedSession('sess-1', 'notion:task-1');
    const branch = insertLocalBranch({
      project_id: 'proj-1',
      session_id: 'sess-1',
      branch_name: 'feature/task-1',
      base_branch: 'dev',
      status: 'open',
      review_result: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    markLocalBranchMerged(branch.id, 'local-branch-sha');

    const result = await getMergeCommitForTask('notion:task-1');

    expect(result).toBe('local-branch-sha');
    expect(mockGetMergeCommitSha).not.toHaveBeenCalled();
  });

  it('falls back to the merged pull_requests row and returns its true merge commit, not head_sha', async () => {
    seedPullRequest({
      taskId: 'notion:task-2',
      prNumber: 42,
      repo: 'acme/widgets',
      headSha: 'pre-merge-feature-head',
      state: 'merged',
    });
    mockGetMergeCommitSha.mockResolvedValue('true-merge-commit-sha');

    const result = await getMergeCommitForTask('notion:task-2');

    expect(result).toBe('true-merge-commit-sha');
    expect(result).not.toBe('pre-merge-feature-head');
    expect(mockGetMergeCommitSha).toHaveBeenCalledWith(42, 'acme/widgets');
  });

  it('returns null when neither a merged local_branches row nor a merged pull_requests row exists', async () => {
    const result = await getMergeCommitForTask('notion:task-3');

    expect(result).toBeNull();
    expect(mockGetMergeCommitSha).not.toHaveBeenCalled();
  });
});
