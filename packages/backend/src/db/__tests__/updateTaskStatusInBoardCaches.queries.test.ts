/**
 * Tests for updateTaskStatusInBoardCaches (db/queries.ts): the write-through
 * that patches a task's status field in place inside every cached board:*
 * blob that contains it, without deleting rows or touching non-board keys.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  updateTaskStatusInBoardCaches,
  upsertTaskCache,
  getTaskCache,
} from '../queries.js';

function seedBoard(taskId: string, tasks: unknown[], fetchedAt = 1000) {
  db.prepare(
    `INSERT INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
  ).run(taskId, fetchedAt, JSON.stringify(tasks));
}

beforeEach(() => {
  db.prepare('DELETE FROM task_cache').run();
});

describe('updateTaskStatusInBoardCaches', () => {
  it('patches the status field of the matching entry, leaving other entries byte-identical', () => {
    const other = { id: 'other-uuid', title: 'Other', status: '🔲 Backlog' };
    seedBoard('board:milestone-1', [
      { id: 'abc12345-0000-0000-0000-000000000000', title: 'T', status: '🔲 Backlog' },
      other,
    ]);

    updateTaskStatusInBoardCaches(
      'notion:abc12345-0000-0000-0000-000000000000',
      '🗂️ Ready',
    );

    const row = getTaskCache('board:milestone-1')!;
    const parsed = JSON.parse(row.raw_json) as Array<{
      id: string;
      status: string;
    }>;
    expect(parsed[0].status).toBe('🗂️ Ready');
    expect(parsed[1]).toEqual(other);
  });

  it('updates every board row containing the task (hyphenated, hyphenless, project-prefixed keys)', () => {
    const hyphenated = 'abc12345-0000-0000-0000-000000000000';
    const hyphenless = 'abc12345000000000000000000000000';
    seedBoard('board:m1', [{ id: hyphenated, status: '🔲 Backlog' }]);
    seedBoard('board:m1hyphenless', [{ id: hyphenless, status: '🔲 Backlog' }]);
    seedBoard('board:proj1:boardA', [{ id: hyphenated, status: '🔲 Backlog' }]);
    // A non-board key must never be touched.
    upsertTaskCache(
      `notion:${hyphenated}`,
      JSON.stringify({ id: hyphenated, status: '🔲 Backlog' }),
    );

    updateTaskStatusInBoardCaches(`notion:${hyphenated}`, '🗂️ Ready');

    for (const key of ['board:m1', 'board:m1hyphenless', 'board:proj1:boardA']) {
      const parsed = JSON.parse(getTaskCache(key)!.raw_json) as Array<{
        status: string;
      }>;
      expect(parsed[0].status).toBe('🗂️ Ready');
    }
    const untouched = JSON.parse(
      getTaskCache(`notion:${hyphenated}`)!.raw_json,
    ) as { status: string };
    expect(untouched.status).toBe('🔲 Backlog');
  });

  it('matches ids normalized for both hyphens and the notion: prefix', () => {
    const bareHyphenated = 'abc12345-0000-0000-0000-000000000000';
    seedBoard('board:m1', [{ id: bareHyphenated, status: '🔲 Backlog' }]);

    updateTaskStatusInBoardCaches('abc12345000000000000000000000000', 'Ready');

    const parsed = JSON.parse(getTaskCache('board:m1')!.raw_json) as Array<{
      status: string;
    }>;
    expect(parsed[0].status).toBe('Ready');
  });

  it('does not delete the row — it upserts in place', () => {
    seedBoard('board:m1', [{ id: 'abc', status: '🔲 Backlog' }]);
    updateTaskStatusInBoardCaches('notion:abc', '🗂️ Ready');
    expect(getTaskCache('board:m1')).toBeDefined();
  });

  it('is a no-op when no board row contains the task', () => {
    seedBoard('board:m1', [{ id: 'other', status: '🔲 Backlog' }]);
    expect(() =>
      updateTaskStatusInBoardCaches('notion:missing', '🗂️ Ready'),
    ).not.toThrow();
    const parsed = JSON.parse(getTaskCache('board:m1')!.raw_json) as Array<{
      status: string;
    }>;
    expect(parsed[0].status).toBe('🔲 Backlog');
  });

  it('does not throw when a board row is empty or holds unparseable JSON', () => {
    seedBoard('board:empty', []);
    db.prepare(
      `INSERT INTO task_cache (task_id, fetched_at, raw_json) VALUES (?, ?, ?)`,
    ).run('board:broken', 1000, '{not valid json');

    expect(() =>
      updateTaskStatusInBoardCaches('notion:abc', '🗂️ Ready'),
    ).not.toThrow();
  });

  it('is a no-op when there are no board rows at all', () => {
    expect(() =>
      updateTaskStatusInBoardCaches('notion:abc', '🗂️ Ready'),
    ).not.toThrow();
  });
});
