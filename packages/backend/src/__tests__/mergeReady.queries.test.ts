import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory DB for query tests ────────────────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { getMergeReadyPRs } from '../db/queries.js';
import { db } from '../db/db.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const now = '2024-01-01T00:00:00Z';
const projectId = 'proj-1';
const milestoneId = 'ms-1';
const sourceId = 'notion-board-abc';

function insertMilestone(id: string, pId: string, sId: string | null) {
  (db as import('better-sqlite3').Database)
    .prepare(
      `INSERT INTO milestones (id, project_id, name, source_id, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ${Date.now()}, ${Date.now()})`,
    )
    .run(id, pId, 'Test Milestone', sId);
}

function insertBoardCache(key: string, taskIds: string[]) {
  (db as import('better-sqlite3').Database)
    .prepare(
      `INSERT OR REPLACE INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
    )
    .run(key, Date.now(), JSON.stringify(taskIds.map((id) => ({ id }))));
}

function insertPR(
  prNumber: number,
  notionTaskId: string | null,
  overrides: Partial<{
    state: string;
    pause_reason: string | null;
    mergeable: number | null;
    review_result: string | null;
    draft: number;
  }> = {},
) {
  const vals = {
    state: 'open',
    pause_reason: null,
    mergeable: 1,
    review_result: JSON.stringify({ verdict: 'approved', summary: 'ok' }),
    draft: 0,
    ...overrides,
  };
  (db as import('better-sqlite3').Database)
    .prepare(
      `INSERT INTO pull_requests
         (pr_number, pr_url, task_id, repo, state, draft,
          review_result, mergeable, pause_reason, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, 'owner/repo', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      prNumber,
      `https://github.com/owner/repo/pull/${prNumber}`,
      notionTaskId,
      vals.state,
      vals.draft,
      vals.review_result,
      vals.mergeable,
      vals.pause_reason,
      now,
      now,
      now,
    );
}

function cleanDb() {
  (db as import('better-sqlite3').Database).exec(
    `DELETE FROM pull_requests; DELETE FROM task_cache; DELETE FROM milestones;`,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getMergeReadyPRs', () => {
  beforeEach(() => {
    cleanDb();
    (db as import('better-sqlite3').Database)
      .prepare(
        `INSERT OR IGNORE INTO projects (id, name, project_dir, task_source,
           auto_launch_enabled, auto_merge_enabled, created_at, updated_at)
         VALUES ('proj-1', 'Test', '/test', 'notion', 0, 0, ${Date.now()}, ${Date.now()})`,
      )
      .run();
    insertMilestone(milestoneId, projectId, sourceId);
    insertBoardCache(`board:${sourceId}`, ['task-aaa', 'task-bbb']);
  });

  it('returns eligible PRs satisfying all filters', () => {
    insertPR(10, 'notion:task-aaa');
    const result = getMergeReadyPRs(projectId, milestoneId);
    expect(result).toHaveLength(1);
    expect(result[0].pr_number).toBe(10);
  });

  it('excludes PRs with pause_reason set', () => {
    insertPR(10, 'notion:task-aaa', { pause_reason: 'stuck_timeout' });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs with mergeable !== 1', () => {
    insertPR(10, 'notion:task-aaa', { mergeable: 0 });
    insertPR(11, 'notion:task-bbb', { mergeable: null });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs with state !== open', () => {
    insertPR(10, 'notion:task-aaa', { state: 'closed' });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs with non-approved verdict', () => {
    insertPR(10, 'notion:task-aaa', {
      review_result: JSON.stringify({
        verdict: 'changes_requested',
        summary: '',
      }),
    });
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('excludes PRs belonging to a different milestone', () => {
    insertPR(10, 'notion:task-zzz');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('includes draft PRs (no draft filter)', () => {
    insertPR(10, 'notion:task-aaa', { draft: 1 });
    const result = getMergeReadyPRs(projectId, milestoneId);
    expect(result).toHaveLength(1);
    expect(result[0].draft).toBe(1);
  });

  it('returns empty when milestone does not exist', () => {
    expect(getMergeReadyPRs(projectId, 'non-existent-ms')).toHaveLength(0);
  });

  it('returns empty when board cache is missing', () => {
    cleanDb();
    insertMilestone(milestoneId, projectId, sourceId);
    // no board cache entry
    insertPR(10, 'notion:task-aaa');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(0);
  });

  it('matches prefixed task_id when board cache has hyphenated raw id', () => {
    cleanDb();
    insertMilestone(milestoneId, projectId, sourceId);
    insertBoardCache(`board:${sourceId}`, [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);
    insertPR(10, 'notion:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(1);
  });

  it('returns multiple eligible PRs', () => {
    insertPR(10, 'notion:task-aaa');
    insertPR(11, 'notion:task-bbb');
    expect(getMergeReadyPRs(projectId, milestoneId)).toHaveLength(2);
  });
});
