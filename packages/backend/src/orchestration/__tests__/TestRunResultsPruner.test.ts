import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import fs from 'fs';
import path from 'path';
import { db } from '../../db/db.js';
import {
  pruneTestRunResultsOlderThan,
  reclaimFreelistBounded,
} from '../../db/queries.js';
import { TestRunResultsPruner } from '../TestRunResultsPruner.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function seed(createdAt: number, outcome: string, count = 1): void {
  const insert = db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES ('run-1', ?, 't', ?, 1, 0, 0, ?)`,
  );
  for (let i = 0; i < count; i++)
    insert.run(`t-${createdAt}-${outcome}-${i}`, outcome, createdAt);
}

function rowCount(): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM test_run_results').get() as {
      c: number;
    }
  ).c;
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare(
    `INSERT INTO test_request_runs (id, project_id, content_hash, state, started_at)
     VALUES ('run-1', 'proj-1', 'h', 'passed', 0)`,
  ).run();
});

describe('pruneTestRunResultsOlderThan', () => {
  it('deletes only older rows of any outcome, in bounded batches', () => {
    seed(10, 'error', 4);
    seed(20, 'skipped', 3);
    seed(30, 'failed', 2);
    seed(1000, 'error', 5);

    const deleted = pruneTestRunResultsOlderThan(500, 2);

    expect(deleted).toBe(9);
    expect(rowCount()).toBe(5);
    const min = db
      .prepare('SELECT MIN(created_at) AS m FROM test_run_results')
      .get() as { m: number };
    expect(min.m).toBe(1000);
  });

  it('returns 0 when nothing is old enough', () => {
    seed(1000, 'error', 3);
    expect(pruneTestRunResultsOlderThan(500, 2)).toBe(0);
    expect(rowCount()).toBe(3);
  });
});

function fakeFreelist(initial: number) {
  const state = { freelist: initial, chunks: [] as number[] };
  const spy = vi.spyOn(db, 'pragma').mockImplementation(((p: string) => {
    if (p === 'freelist_count') return state.freelist;
    const m = /^incremental_vacuum\((\d+)\)$/.exec(p);
    if (m) {
      const n = Number(m[1]);
      state.chunks.push(n);
      state.freelist = Math.max(0, state.freelist - n);
    }
    return [];
  }) as never);
  return { state, spy };
}

describe('reclaimFreelistBounded', () => {
  it('reclaims at most maxPagesPerTick and yields between chunks', async () => {
    const { state, spy } = fakeFreelist(10_000);
    try {
      let yielded = false;
      setImmediate(() => {
        yielded = true;
      });
      const reclaimed = await reclaimFreelistBounded({
        chunkPages: 100,
        maxPagesPerTick: 250,
      });
      expect(reclaimed).toBe(250);
      expect(state.chunks).toEqual([100, 100, 50]);
      expect(state.freelist).toBe(9_750);
      expect(yielded).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops when the freelist is empty', async () => {
    const { state, spy } = fakeFreelist(30);
    try {
      expect(
        await reclaimFreelistBounded({ chunkPages: 100, maxPagesPerTick: 500 }),
      ).toBe(30);
      expect(state.freelist).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('incremental_vacuum call sites', () => {
  it('never issue incremental_vacuum without a page count outside db/schema.ts', () => {
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(full);
        } else if (
          /\.ts$/.test(entry.name) &&
          full !== path.join(root, 'db', 'schema.ts')
        ) {
          const src = fs.readFileSync(full, 'utf8');
          if (/incremental_vacuum(?!\s*\()/.test(src.replace(/\/\/.*$/gm, '')))
            offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('TestRunResultsPruner', () => {
  it('still runs the bounded reclaim when it deleted 0 rows', async () => {
    const { state, spy } = fakeFreelist(5);
    try {
      const deleted = await new TestRunResultsPruner({
        nowFn: () => NOW,
      }).pruneOnce();
      expect(deleted).toBe(0);
      expect(state.chunks.length).toBe(1);
      expect(state.freelist).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('scheduler run callback reports rows deleted as items_processed', async () => {
    seed(NOW - 20 * DAY, 'error', 3);
    seed(NOW - 1 * DAY, 'failed', 1);
    seed(NOW - 20 * DAY, 'passed', 0);
    const register = vi.fn();
    new TestRunResultsPruner({ nowFn: () => NOW }).register({
      register,
    } as never);
    const result = await register.mock.calls[0][0].run();
    expect(result).toEqual({ items_processed: 3 });
    expect(rowCount()).toBe(1);
  });

  it('registers on the Scheduler as a daily skip-if-running job', () => {
    const register = vi.fn();
    new TestRunResultsPruner().register({ register } as never);
    expect(register).toHaveBeenCalledTimes(1);
    const job = register.mock.calls[0][0];
    expect(job.name).toBe('test_run_results_pruner');
    expect(job.intervalMs).toBe(DAY);
    expect(job.concurrency).toBe('skip-if-running');
    expect(typeof job.runOnBoot).toBe('boolean');
    expect(typeof job.initialDelayMs).toBe('number');
  });

  it('pruneOnce removes only non-passing rows older than 14 days', async () => {
    seed(NOW - 20 * DAY, 'error', 2);
    seed(NOW - 20 * DAY, 'skipped', 1);
    seed(NOW - 1 * DAY, 'error', 2);
    seed(NOW - 1 * DAY, 'failed', 1);

    await new TestRunResultsPruner({
      nowFn: () => NOW,
      batchSize: 2,
    }).pruneOnce();

    expect(rowCount()).toBe(3);
    const min = db
      .prepare('SELECT MIN(created_at) AS m FROM test_run_results')
      .get() as { m: number };
    expect(min.m).toBe(NOW - 1 * DAY);
  });
});
