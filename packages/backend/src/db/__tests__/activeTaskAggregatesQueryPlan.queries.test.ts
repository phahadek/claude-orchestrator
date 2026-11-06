import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('proj-1', 'Test Project', '/test', 'owner/repo', 'notion', 1000, 1000);
  return { db };
});

import { db } from '../db.js';
import {
  getActiveTaskAggregates,
  insertSession,
  upsertTaskCache,
} from '../queries.js';

const TASK_ID = 'notion:33722f91-52f3-816b-967f-c7f230b215ca';
const EMPTY_TASK_ID = 'notion:44722f91-52f3-816b-967f-c7f230b215cb';

function seedSession(
  session_id: string,
  session_type: string,
  started_at: number,
) {
  insertSession({
    session_id,
    task_id: TASK_ID,
    task_url: 'https://www.notion.so/task',
    project_context_url: 'https://www.notion.so/context',
    project_id: 'proj-1',
    status: 'done',
    started_at,
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    session_type,
    task_name: null,
  } as Parameters<typeof insertSession>[0]);
}

function captureSql(): string {
  const spy = vi.spyOn(db, 'prepare');
  try {
    getActiveTaskAggregates([TASK_ID]);
    const call = spy.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('ranked_code'),
    );
    return call![0] as string;
  } finally {
    spy.mockRestore();
  }
}

describe('getActiveTaskAggregates', () => {
  upsertTaskCache(TASK_ID, JSON.stringify({ id: TASK_ID }));
  upsertTaskCache(EMPTY_TASK_ID, JSON.stringify({ id: EMPTY_TASK_ID }));
  seedSession('plan-old', 'groom', 1000);
  seedSession('plan-new', 'design', 3000);
  seedSession('plan-mid', 'groom', 2000);
  seedSession('rev-old', 'review', 1500);
  seedSession('rev-new', 'review', 4000);
  seedSession('rev-mid', 'review', 2500);

  it('query plan has no SCAN on planning/review session sources', () => {
    const sql = captureSql();
    const detail = (
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(TASK_ID, TASK_ID, TASK_ID) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join('\n');
    expect(detail).not.toMatch(/SCAN (ps|rs|ranked_planning|ranked_review)\b/);
    expect(detail).toMatch(/SEARCH ps USING/);
    expect(detail).toMatch(/SEARCH rs USING/);
  });

  it('returns the latest-started planning and review sessions', () => {
    const row = getActiveTaskAggregates([TASK_ID, EMPTY_TASK_ID]).find(
      (r) => r.task_id === TASK_ID,
    )!;
    expect(row.planning_session_id).toBe('plan-new');
    expect(row.planning_session_started_at).toBe(3000);
    expect(row.review_session_id).toBe('rev-new');
  });

  it('returns NULL planning/review columns for a task with neither', () => {
    const row = getActiveTaskAggregates([TASK_ID, EMPTY_TASK_ID]).find(
      (r) => r.task_id === EMPTY_TASK_ID,
    )!;
    for (const [key, value] of Object.entries(row)) {
      if (
        key.startsWith('planning_session_') ||
        key.startsWith('review_session_')
      ) {
        expect(value).toBeNull();
      }
    }
  });
});
