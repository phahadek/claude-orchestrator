/**
 * The Tests-tab history and authoritative-run queries must seek the
 * session/worktree indexes, never walk every run in the project via
 * idx_test_request_runs_project_started / _project_finished.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  listTestRequestRunsForPrSession,
  getAuthoritativeTestRunForPr,
} from '../queries.js';

/** Captures the SQL each query prepares, then returns its EXPLAIN QUERY PLAN. */
function planFor(run: () => unknown): string {
  const original = db.prepare.bind(db);
  const sqls: string[] = [];
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    sqls.push(sql);
    return original(sql);
  }) as typeof db.prepare);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  const sql = sqls.find((s) => s.includes('FROM test_request_runs'))!;
  const params = {
    project_id: 'p',
    session_id: 's',
    worktree_path: '/wt',
    limit: 10,
  };
  const used = Object.fromEntries(
    Object.entries(params).filter(([k]) => sql.includes(`@${k}`)),
  );
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(used) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(' | ');
}

let seq = 0;
function insertRun(opts: {
  session: string | null;
  worktree: string | null;
  startedAt: number;
  finishedAt?: number;
  kind?: string;
}): string {
  const id = `run-${++seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, state, started_at, finished_at, session_id, worktree_path, run_kind)
     VALUES (?, 'p', 'h', 'passed', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.startedAt,
    opts.finishedAt ?? opts.startedAt + 1,
    opts.session,
    opts.worktree,
    opts.kind ?? 'full',
  );
  return id;
}

beforeEach(() => {
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('query plans', () => {
  it('listTestRequestRunsForPrSession never scans by project alone', () => {
    const plan = planFor(() =>
      listTestRequestRunsForPrSession('p', 's', '/wt', 10),
    );
    expect(plan).not.toMatch(/idx_test_request_runs_project_(started|finished)/);
    expect(plan).toMatch(/idx_test_request_runs_session_/);
    expect(plan).toMatch(/idx_test_request_runs_project_worktree_state/);
    expect(plan).not.toMatch(/SCAN test_request_runs/);
  });

  it('getAuthoritativeTestRunForPr searches on project_id + worktree_path', () => {
    const plan = planFor(() => getAuthoritativeTestRunForPr('p', 's', '/wt'));
    expect(plan).not.toMatch(/idx_test_request_runs_project_(started|finished)/);
    expect(plan).toMatch(/idx_test_request_runs_project_worktree_state/);
    expect(plan).not.toMatch(/SCAN test_request_runs/);
  });
});

describe('listTestRequestRunsForPrSession behaviour', () => {
  it('merges session and same-worktree NULL-session rows, ordered, deduped', () => {
    const a = insertRun({ session: 's', worktree: '/wt', startedAt: 1 });
    const b = insertRun({ session: null, worktree: '/wt', startedAt: 3 });
    const c = insertRun({ session: 's', worktree: null, startedAt: 2 });
    insertRun({ session: null, worktree: '/other', startedAt: 4 });
    insertRun({ session: 'x', worktree: '/wt', startedAt: 5 });
    const ids = listTestRequestRunsForPrSession('p', 's', '/wt').map(
      (r) => r.id,
    );
    expect(ids).toEqual([b, c, a]);
  });

  it('honours limit and a NULL worktree never matches NULL-session rows', () => {
    insertRun({ session: null, worktree: null, startedAt: 9 });
    const a = insertRun({ session: 's', worktree: '/wt', startedAt: 1 });
    insertRun({ session: 's', worktree: '/wt', startedAt: 0 });
    expect(
      listTestRequestRunsForPrSession('p', 's', null).map((r) => r.id),
    ).toEqual([a, expect.any(String)]);
    expect(listTestRequestRunsForPrSession('p', 's', '/wt', 1)).toHaveLength(
      1,
    );
  });
});

describe('getAuthoritativeTestRunForPr behaviour', () => {
  it('picks the latest-finished full run across session and NULL-session rows', () => {
    insertRun({ session: 's', worktree: '/wt', startedAt: 1, finishedAt: 10 });
    const b = insertRun({
      session: null,
      worktree: '/wt',
      startedAt: 2,
      finishedAt: 20,
    });
    insertRun({ session: null, worktree: '/other', startedAt: 3, finishedAt: 30 });
    expect(getAuthoritativeTestRunForPr('p', 's', '/wt')?.id).toBe(b);
  });
});
