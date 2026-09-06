/**
 * Regression coverage for the task_cache.cached_status generated column
 * (schema.ts) that getTasksByStatusFromCache (queries.ts) now queries
 * against instead of applying JSON_EXTRACT(raw_json, '$.status') to every
 * row inside WHERE. Follows the shape of hasActiveSessionForTaskIndex.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db';
import { getTasksByStatusFromCache } from '../queries';

function insertTaskCache(taskId: string, rawJson: string): void {
  db.prepare(
    `INSERT INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
  ).run(taskId, Date.now(), rawJson);
}

/** Reproduces the pre-fix implementation, for fixture-equivalence comparison. */
function legacyGetTasksByStatusFromCache(
  status: string,
  prefix: string,
): { task_id: string; raw_json: string }[] {
  return db
    .prepare(
      `SELECT task_id, raw_json FROM task_cache
       WHERE task_id LIKE ?
         AND JSON_EXTRACT(raw_json, '$.status') = ?`,
    )
    .all(`${prefix}%`, status) as { task_id: string; raw_json: string }[];
}

describe('getTasksByStatusFromCache — indexable status lookup', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM task_cache').run();
  });

  it('resolves via an index seek on cached_status, not a full table scan', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT task_id, raw_json FROM task_cache
         WHERE cached_status = ? AND task_id LIKE ?`,
      )
      .all('In Progress', 'notion:%') as Array<{ detail: string }>;
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/SEARCH task_cache USING INDEX idx_task_cache_status/);
    expect(detail).not.toMatch(/SCAN task_cache\b/);
  });

  it('returns rows identical to the previous JSON_EXTRACT implementation for matching, non-matching, and wrong-prefix rows', () => {
    insertTaskCache('notion:1', JSON.stringify({ status: 'In Progress', name: 'A' }));
    insertTaskCache('notion:2', JSON.stringify({ status: 'Done', name: 'B' }));
    insertTaskCache('notion:3', JSON.stringify({ status: 'In Progress', name: 'C' }));
    insertTaskCache('yaml:4', JSON.stringify({ status: 'In Progress', name: 'D' }));

    const actual = getTasksByStatusFromCache('In Progress', 'notion:');
    const expected = legacyGetTasksByStatusFromCache('In Progress', 'notion:');

    expect(
      actual.slice().sort((a, b) => a.task_id.localeCompare(b.task_id)),
    ).toEqual(expected.slice().sort((a, b) => a.task_id.localeCompare(b.task_id)));
    expect(actual.map((r) => r.task_id).sort()).toEqual(['notion:1', 'notion:3']);
  });

  it('excludes a malformed-JSON row rather than throwing — an improvement over the previous implementation, which raised "malformed JSON" the moment JSON_EXTRACT scanned a matching-prefix row with invalid raw_json', () => {
    insertTaskCache('notion:1', JSON.stringify({ status: 'In Progress', name: 'A' }));
    insertTaskCache('notion:2', '{not valid json');

    expect(() => getTasksByStatusFromCache('In Progress', 'notion:')).not.toThrow();
    const actual = getTasksByStatusFromCache('In Progress', 'notion:');
    expect(actual.map((r) => r.task_id)).toEqual(['notion:1']);

    expect(() => legacyGetTasksByStatusFromCache('In Progress', 'notion:')).toThrow(
      /malformed JSON/,
    );
  });
});
