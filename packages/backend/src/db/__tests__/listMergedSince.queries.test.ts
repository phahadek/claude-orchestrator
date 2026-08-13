/**
 * Tests for listMergedSince (db/queries.ts) — the DB-derived "behind"
 * preview: merged pull_requests + merged local_branches rows since a
 * project's last recorded deployed-SHA timestamp, resolved without any
 * git/GitHub call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertProject,
  insertSession,
  insertLocalBranch,
  listMergedSince,
} from '../queries.js';

function insertPR(overrides: {
  pr_number: number;
  pr_url: string;
  repo: string;
  state: string;
  task_id?: string | null;
  title?: string | null;
  updated_at: string;
  session_id?: string | null;
}): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, repo, task_id, title, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, session_id)
    VALUES
      (@pr_number, @pr_url, @repo, @task_id, @title, @state, 0, NULL, NULL,
       @updated_at, @updated_at, @updated_at, @session_id)
  `,
  ).run({
    pr_number: overrides.pr_number,
    pr_url: overrides.pr_url,
    repo: overrides.repo,
    task_id: overrides.task_id ?? null,
    title: overrides.title ?? null,
    state: overrides.state,
    updated_at: overrides.updated_at,
    session_id: overrides.session_id ?? null,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
  db.prepare('DELETE FROM local_branches').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM projects').run();
});

describe('listMergedSince', () => {
  it('returns merged pull_requests + merged local_branches after the cutoff, correctly attributed, for a single configured repo', () => {
    insertProject({
      id: 'proj-1',
      name: 'Proj',
      project_dir: '/repo/proj-1',
      context_url: null,
      github_repo: 'org/repo',
      task_source: 'notion',
    });
    insertPR({
      pr_number: 1,
      pr_url: 'https://github.com/org/repo/pull/1',
      repo: 'org/repo',
      state: 'merged',
      task_id: 'task-1',
      title: 'Fix bug',
      updated_at: '2026-07-21T00:00:00.000Z',
    });
    // before the cutoff — must not appear
    insertPR({
      pr_number: 2,
      pr_url: 'https://github.com/org/repo/pull/2',
      repo: 'org/repo',
      state: 'merged',
      updated_at: '2026-07-19T00:00:00.000Z',
    });
    insertSession({
      session_id: 'sess-1',
      task_id: 'task-2',
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.parse('2026-07-20T00:00:00.000Z'),
      task_name: 'Local merge task',
    } as never);
    insertLocalBranch({
      project_id: 'proj-1',
      session_id: 'sess-1',
      branch_name: 'feature/local-merge',
      base_branch: 'dev',
      status: 'merged',
      review_result: null,
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
    });

    const items = listMergedSince('proj-1', '2026-07-20T00:00:00.000Z');

    expect(items).toHaveLength(2);
    const pr = items.find((i) => i.kind === 'pr');
    expect(pr).toMatchObject({
      kind: 'pr',
      taskId: 'task-1',
      title: 'Fix bug',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    const branch = items.find((i) => i.kind === 'local-branch');
    expect(branch).toMatchObject({
      kind: 'local-branch',
      taskId: 'task-2',
      title: 'Local merge task',
      branchName: 'feature/local-merge',
    });
  });

  it('covers a project whose github_repo config is a JSON array of multiple repos', () => {
    insertProject({
      id: 'proj-2',
      name: 'Proj',
      project_dir: '/repo/proj-2',
      context_url: null,
      github_repo: JSON.stringify(['org/repo-a', 'org/repo-b']),
      task_source: 'notion',
    });
    insertPR({
      pr_number: 10,
      pr_url: 'https://github.com/org/repo-a/pull/10',
      repo: 'org/repo-a',
      state: 'merged',
      updated_at: '2026-07-21T00:00:00.000Z',
    });
    insertPR({
      pr_number: 11,
      pr_url: 'https://github.com/org/repo-b/pull/11',
      repo: 'org/repo-b',
      state: 'merged',
      updated_at: '2026-07-22T00:00:00.000Z',
    });
    // a repo not configured for this project — must not appear
    insertPR({
      pr_number: 12,
      pr_url: 'https://github.com/org/other/pull/12',
      repo: 'org/other',
      state: 'merged',
      updated_at: '2026-07-23T00:00:00.000Z',
    });

    const items = listMergedSince('proj-2', '2026-07-20T00:00:00.000Z');

    expect(items.map((i) => i.prNumber).sort()).toEqual([10, 11]);
  });

  it('returns a result without throwing for a project with no project_deployed_sha row (never deployed)', () => {
    insertProject({
      id: 'proj-3',
      name: 'Proj',
      project_dir: '/repo/proj-3',
      context_url: null,
      github_repo: 'org/repo',
      task_source: 'notion',
    });
    insertPR({
      pr_number: 20,
      pr_url: 'https://github.com/org/repo/pull/20',
      repo: 'org/repo',
      state: 'merged',
      updated_at: '2026-07-21T00:00:00.000Z',
    });

    expect(() => listMergedSince('proj-3', null)).not.toThrow();
    const items = listMergedSince('proj-3', null);
    expect(items.map((i) => i.prNumber)).toEqual([20]);
  });

  it('dedupes a merged local branch against a merged PR sharing the same session_id, preferring the PR', () => {
    insertProject({
      id: 'proj-4',
      name: 'Proj',
      project_dir: '/repo/proj-4',
      context_url: null,
      github_repo: 'org/repo',
      task_source: 'notion',
    });
    insertSession({
      session_id: 'sess-shared',
      task_id: 'task-shared',
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.parse('2026-07-20T00:00:00.000Z'),
      task_name: 'Shared task',
    } as never);
    insertPR({
      pr_number: 30,
      pr_url: 'https://github.com/org/repo/pull/30',
      repo: 'org/repo',
      state: 'merged',
      task_id: 'task-shared',
      title: 'Shared change',
      updated_at: '2026-07-21T00:00:00.000Z',
      session_id: 'sess-shared',
    });
    insertLocalBranch({
      project_id: 'proj-4',
      session_id: 'sess-shared',
      branch_name: 'feature/shared',
      base_branch: 'dev',
      status: 'merged',
      review_result: null,
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
    });

    const items = listMergedSince('proj-4', '2026-07-20T00:00:00.000Z');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'pr', prNumber: 30 });
  });

  it('keeps a merged local branch whose session_id matches no merged PR', () => {
    insertProject({
      id: 'proj-5',
      name: 'Proj',
      project_dir: '/repo/proj-5',
      context_url: null,
      github_repo: 'org/repo',
      task_source: 'notion',
    });
    insertSession({
      session_id: 'sess-lonely',
      task_id: 'task-lonely',
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.parse('2026-07-20T00:00:00.000Z'),
      task_name: 'Lonely branch task',
    } as never);
    insertPR({
      pr_number: 31,
      pr_url: 'https://github.com/org/repo/pull/31',
      repo: 'org/repo',
      state: 'merged',
      task_id: 'task-other',
      title: 'Unrelated PR',
      updated_at: '2026-07-21T00:00:00.000Z',
      session_id: 'sess-other',
    });
    insertLocalBranch({
      project_id: 'proj-5',
      session_id: 'sess-lonely',
      branch_name: 'feature/lonely',
      base_branch: 'dev',
      status: 'merged',
      review_result: null,
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
    });

    const items = listMergedSince('proj-5', '2026-07-20T00:00:00.000Z');

    expect(items).toHaveLength(2);
    const branch = items.find((i) => i.kind === 'local-branch');
    expect(branch).toMatchObject({
      kind: 'local-branch',
      branchName: 'feature/lonely',
    });
  });

  it('never collapses rows with a null session_id into one another', () => {
    insertProject({
      id: 'proj-6',
      name: 'Proj',
      project_dir: '/repo/proj-6',
      context_url: null,
      github_repo: 'org/repo',
      task_source: 'notion',
    });
    // pull_requests.session_id is nullable and unpopulated for legacy rows;
    // two such rows must both survive rather than being treated as sharing
    // a "null" identity.
    insertPR({
      pr_number: 40,
      pr_url: 'https://github.com/org/repo/pull/40',
      repo: 'org/repo',
      state: 'merged',
      updated_at: '2026-07-21T00:00:00.000Z',
      session_id: null,
    });
    insertPR({
      pr_number: 41,
      pr_url: 'https://github.com/org/repo/pull/41',
      repo: 'org/repo',
      state: 'merged',
      updated_at: '2026-07-22T00:00:00.000Z',
      session_id: null,
    });

    const items = listMergedSince('proj-6', '2026-07-20T00:00:00.000Z');

    expect(items.map((i) => i.prNumber).sort()).toEqual([40, 41]);
  });

  it('remains sorted by mergedAt ascending after dedup', () => {
    insertProject({
      id: 'proj-7',
      name: 'Proj',
      project_dir: '/repo/proj-7',
      context_url: null,
      github_repo: 'org/repo',
      task_source: 'notion',
    });
    insertSession({
      session_id: 'sess-sort-shared',
      task_id: 'task-sort-shared',
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.parse('2026-07-20T00:00:00.000Z'),
      task_name: 'Shared task',
    } as never);
    insertPR({
      pr_number: 50,
      pr_url: 'https://github.com/org/repo/pull/50',
      repo: 'org/repo',
      state: 'merged',
      title: 'Middle PR',
      updated_at: '2026-07-22T00:00:00.000Z',
      session_id: 'sess-sort-shared',
    });
    insertLocalBranch({
      project_id: 'proj-7',
      session_id: 'sess-sort-shared',
      branch_name: 'feature/sort-shared',
      base_branch: 'dev',
      status: 'merged',
      review_result: null,
      created_at: '2026-07-23T00:00:00.000Z',
      updated_at: '2026-07-23T00:00:00.000Z',
    });
    insertPR({
      pr_number: 51,
      pr_url: 'https://github.com/org/repo/pull/51',
      repo: 'org/repo',
      state: 'merged',
      title: 'Last PR',
      updated_at: '2026-07-24T00:00:00.000Z',
    });
    insertSession({
      session_id: 'sess-sort-first',
      task_id: 'task-sort-first',
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.parse('2026-07-20T00:00:00.000Z'),
      task_name: 'First branch task',
    } as never);
    insertLocalBranch({
      project_id: 'proj-7',
      session_id: 'sess-sort-first',
      branch_name: 'feature/sort-first',
      base_branch: 'dev',
      status: 'merged',
      review_result: null,
      created_at: '2026-07-21T00:00:00.000Z',
      updated_at: '2026-07-21T00:00:00.000Z',
    });

    const items = listMergedSince('proj-7', '2026-07-20T00:00:00.000Z');

    const mergedAts = items.map((i) => i.mergedAt);
    const sorted = [...mergedAts].sort((a, b) => a.localeCompare(b));
    expect(mergedAts).toEqual(sorted);
    expect(items).toHaveLength(3);
  });
});
