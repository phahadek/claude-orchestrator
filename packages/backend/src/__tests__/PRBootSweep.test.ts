import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  const { applyTestSchema } = await import('../../test/helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

vi.mock('../config.js', () => ({
  getAllProjects: vi.fn(),
}));

import { db } from '../db/db.js';
import { getAllProjects } from '../config.js';
import { insertSession, getPRByNumber, upsertPullRequest } from '../db/queries.js';
import { runPRBootSweep } from '../github/PRBootSweep.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PullRequest } from '../github/types.js';

const mockGetAllProjects = vi.mocked(getAllProjects);

function makeGithubClient(openPRs: PullRequest[]): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue(openPRs),
  } as unknown as GitHubClient;
}

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    nodeId: 'PR_node1',
    id: 42,
    title: 'feat: something',
    body: null,
    url: 'https://github.com/owner/repo/pull/42',
    apiUrl: 'https://api.github.com/repos/owner/repo/pulls/42',
    headBranch: 'feature/something',
    headSha: 'abc123',
    baseBranch: 'dev',
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeableState: null,
    draft: false,
    ...overrides,
  };
}

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
  mockGetAllProjects.mockReset();
});

describe('runPRBootSweep', () => {
  it('inserts a missing PR row with session_id when head_branch matches', async () => {
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
    ]);
    insertTestSession('sess-aaaaaaaa', '/worktrees/w1/feature/something', 'task-x');
    const pr = makePR();
    const github = makeGithubClient([pr]);

    await runPRBootSweep(github);

    const row = getPRByNumber(42, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe('sess-aaaaaaaa');
    expect(row!.task_id).toBe('task-x');
  });

  it('inserts a missing PR row with null session_id when no session matches', async () => {
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
    ]);
    // No sessions inserted
    const pr = makePR({ headBranch: 'feature/unknown-branch' });
    const github = makeGithubClient([pr]);

    await runPRBootSweep(github);

    const row = getPRByNumber(42, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.session_id).toBeNull();
  });

  it('does not overwrite an existing PR row', async () => {
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
    ]);
    const now = '2026-01-01T00:00:00Z';
    upsertPullRequest({
      pr_number: 42,
      pr_url: 'https://github.com/owner/repo/pull/42',
      task_id: 'existing-task',
      session_id: 'existing-sess',
      repo: 'owner/repo',
      title: 'Original title',
      body: null,
      head_branch: 'feature/something',
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

    const pr = makePR({ title: 'New title from sweep' });
    const github = makeGithubClient([pr]);

    await runPRBootSweep(github);

    // listOpenPRs was called but the row already existed — should not have been overwritten
    const row = getPRByNumber(42, 'owner/repo');
    expect(row!.session_id).toBe('existing-sess');
    expect(row!.task_id).toBe('existing-task');
  });

  it('skips projects with no githubRepo', async () => {
    mockGetAllProjects.mockReturnValue([
      { githubRepo: null, id: 'proj-local' } as unknown as ReturnType<typeof getAllProjects>[number],
    ]);
    const github = makeGithubClient([makePR()]);

    await runPRBootSweep(github);

    expect((github.listOpenPRs as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('handles null session_id when multiple sessions match (ambiguous)', async () => {
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<typeof getAllProjects>[number],
    ]);
    insertTestSession('sess-11111111', '/worktrees/w1/feature/ambiguous');
    insertTestSession('sess-22222222', '/worktrees/w2/feature/ambiguous');
    const pr = makePR({ headBranch: 'feature/ambiguous' });
    const github = makeGithubClient([pr]);

    await runPRBootSweep(github);

    const row = getPRByNumber(42, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.session_id).toBeNull();
  });

  it('continues to next project if GitHub API throws for one repo', async () => {
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/broken', id: 'proj-broken' } as ReturnType<typeof getAllProjects>[number],
      { githubRepo: 'owner/good', id: 'proj-good' } as ReturnType<typeof getAllProjects>[number],
    ]);
    const github = {
      listOpenPRs: vi
        .fn()
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce([makePR({ url: 'https://github.com/owner/good/pull/42', repo: 'owner/good' })]),
    } as unknown as GitHubClient;

    await expect(runPRBootSweep(github)).resolves.not.toThrow();
    // The second project's PR should have been inserted
    const row = getPRByNumber(42, 'owner/good');
    expect(row).not.toBeNull();
  });
});
