import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../config.js', () => ({
  getAllProjects: vi.fn(),
  runtimeSettings: { pr_boot_sweep_merged_lookback_days: 30 },
}));

import { db } from '../db/db.js';
import { getAllProjects } from '../config.js';
import {
  insertSession,
  getPRByNumber,
  upsertPullRequest,
} from '../db/queries.js';
import { runPRBootSweep } from '../github/PRBootSweep.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PullRequest } from '../github/types.js';

const mockGetAllProjects = vi.mocked(getAllProjects);

function makeGithubClient(
  openPRs: PullRequest[],
  closedPRs: PullRequest[] = [],
): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue(openPRs),
    listClosedPullRequests: vi.fn().mockResolvedValue(closedPRs),
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

function insertTestProject(id: string, githubRepo: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO projects
       (id, name, project_dir, github_repo, task_source, git_mode,
        auto_launch_enabled, auto_merge_enabled, data_residency_confirmed,
        created_at, updated_at)
     VALUES (?, ?, '/test', ?, 'notion', 'github', 0, 0, 0, 0, 0)`,
  ).run(id, `Project ${id}`, githubRepo);
}

beforeEach(() => {
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM pull_requests');
  db.exec('DELETE FROM projects');
  mockGetAllProjects.mockReset();
});

describe('runPRBootSweep', () => {
  it('inserts a missing PR row with session_id when head_branch matches', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    insertTestSession(
      'sess-aaaaaaaa',
      '/worktrees/w1/feature/something',
      'task-x',
    );
    const pr = makePR();
    const github = makeGithubClient([pr]);

    await runPRBootSweep(github);

    const row = getPRByNumber(42, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe('sess-aaaaaaaa');
    expect(row!.task_id).toBe('task-x');
  });

  it('inserts a missing PR row with null session_id when no session matches', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
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
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
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
      { githubRepo: null, id: 'proj-local' } as unknown as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    const github = makeGithubClient([makePR()]);

    await runPRBootSweep(github);

    expect(
      (github.listOpenPRs as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it('handles null session_id when multiple sessions match (ambiguous)', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
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
    insertTestProject('proj-good', 'owner/good');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/broken', id: 'proj-broken' } as ReturnType<
        typeof getAllProjects
      >[number],
      { githubRepo: 'owner/good', id: 'proj-good' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    const github = {
      listOpenPRs: vi
        .fn()
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce([
          makePR({
            url: 'https://github.com/owner/good/pull/42',
            repo: 'owner/good',
          }),
        ]),
      listClosedPullRequests: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;

    await expect(runPRBootSweep(github)).resolves.not.toThrow();
    // The second project's PR should have been inserted
    const row = getPRByNumber(42, 'owner/good');
    expect(row).not.toBeNull();
  });

  // ── Closed-PR backfill tests ─────────────────────────────────────────────

  it('inserts a merged PR row with state=merged from the closed-PR backfill', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    const mergedPR = makePR({
      id: 99,
      url: 'https://github.com/owner/repo/pull/99',
      state: 'merged',
      headBranch: 'feature/merged-thing',
    });
    const github = makeGithubClient([], [mergedPR]);

    await runPRBootSweep(github);

    const row = getPRByNumber(99, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.state).toBe('merged');
  });

  it('inserts a closed (not merged) PR row with state=closed from the closed-PR backfill', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    const closedPR = makePR({
      id: 77,
      url: 'https://github.com/owner/repo/pull/77',
      state: 'closed',
      headBranch: 'feature/closed-thing',
    });
    const github = makeGithubClient([], [closedPR]);

    await runPRBootSweep(github);

    const row = getPRByNumber(77, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.state).toBe('closed');
  });

  it('does not overwrite an existing merged PR row (INSERT OR IGNORE for closed-PR backfill)', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    const now = '2026-01-01T00:00:00Z';
    upsertPullRequest({
      pr_number: 55,
      pr_url: 'https://github.com/owner/repo/pull/55',
      task_id: 'existing-task',
      session_id: 'existing-sess',
      repo: 'owner/repo',
      title: 'Existing merged PR',
      body: null,
      head_branch: 'feature/already-merged',
      base_branch: 'dev',
      state: 'merged',
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

    const backfillPR = makePR({
      id: 55,
      url: 'https://github.com/owner/repo/pull/55',
      state: 'merged',
      headBranch: 'feature/already-merged',
      title: 'New title from backfill',
    });
    const github = makeGithubClient([], [backfillPR]);

    await runPRBootSweep(github);

    const row = getPRByNumber(55, 'owner/repo');
    expect(row!.session_id).toBe('existing-sess');
    expect(row!.task_id).toBe('existing-task');
  });

  it('links session_id via head_branch when backfilling a merged PR', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    insertTestSession(
      'sess-bbbbbbbb',
      '/worktrees/w1/feature/was-merged',
      'task-y',
    );
    const mergedPR = makePR({
      id: 88,
      url: 'https://github.com/owner/repo/pull/88',
      state: 'merged',
      headBranch: 'feature/was-merged',
    });
    const github = makeGithubClient([], [mergedPR]);

    await runPRBootSweep(github);

    const row = getPRByNumber(88, 'owner/repo');
    expect(row).not.toBeNull();
    expect(row!.session_id).toBe('sess-bbbbbbbb');
    expect(row!.task_id).toBe('task-y');
    expect(row!.state).toBe('merged');
  });

  it('passes the lookback days from runtimeSettings to listClosedPullRequests', async () => {
    insertTestProject('proj-1', 'owner/repo');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'owner/repo', id: 'proj-1' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    const github = makeGithubClient([], []);

    await runPRBootSweep(github);

    expect(
      (github.listClosedPullRequests as ReturnType<typeof vi.fn>).mock.calls[0],
    ).toEqual(['owner/repo', 30]);
  });

  it('integration: deleted merged-PR rows are restored on boot cycle', async () => {
    insertTestProject('polimarket', 'polimarket/app');
    mockGetAllProjects.mockReturnValue([
      { githubRepo: 'polimarket/app', id: 'polimarket' } as ReturnType<
        typeof getAllProjects
      >[number],
    ]);
    // Session exists (the task was launched and did work)
    insertTestSession(
      'sess-polimrkt',
      '/worktrees/w1/feature/some-polimarket-task',
      'task-polimarket-1',
    );
    // Simulate deletion: no row in pull_requests
    expect(getPRByNumber(201, 'polimarket/app')).toBeFalsy();

    // Boot cycle: GitHub still has the merged PR in the API response
    const restoredPR = makePR({
      id: 201,
      state: 'merged',
      headBranch: 'feature/some-polimarket-task',
      url: 'https://github.com/polimarket/app/pull/201',
      apiUrl: 'https://api.github.com/repos/polimarket/app/pulls/201',
    });
    const github = makeGithubClient([], [restoredPR]);

    await runPRBootSweep(github);

    const row = getPRByNumber(201, 'polimarket/app');
    expect(row).not.toBeNull();
    expect(row!.state).toBe('merged');
    expect(row!.session_id).toBe('sess-polimrkt');
    expect(row!.task_id).toBe('task-polimarket-1');
  });
});
