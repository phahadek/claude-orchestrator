import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  getActiveTaskAggregates,
  getTaskIdsOrderedByFetchedAt,
  upsertTaskCache,
} from '../db/queries.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('getTaskIdsOrderedByFetchedAt + chunked getActiveTaskAggregates', () => {
  it('chunk-concatenated rows equal one call over all ids, with differing fetched_at', () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    // Insert in a scrambled order so fetched_at order differs from id order.
    for (let i = 0; i < 25; i++) {
      const id = `notion:task-${i}`;
      ids.push(id);
      vi.setSystemTime(1_000_000 + ((i * 7) % 25) * 1000);
      upsertTaskCache(
        id,
        JSON.stringify({ id, title: `T${i}`, status: 'Ready' }),
      );
    }

    const single = getActiveTaskAggregates(ids);
    const ordered = getTaskIdsOrderedByFetchedAt(ids);
    expect(ordered).toHaveLength(25);

    const chunked = [];
    for (let i = 0; i < ordered.length; i += 4) {
      chunked.push(...getActiveTaskAggregates(ordered.slice(i, i + 4)));
    }

    expect(chunked).toEqual(single);
    expect(single.map((r) => r.task_id)).toEqual(ordered);
  });

  it('returns [] for no ids', () => {
    expect(getTaskIdsOrderedByFetchedAt([])).toEqual([]);
  });
});
