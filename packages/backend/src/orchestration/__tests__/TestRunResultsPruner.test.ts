import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { pruneTestRunResultsOlderThan } from '../../db/queries.js';
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

describe('TestRunResultsPruner', () => {
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
