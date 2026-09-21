/**
 * Exercises ingestTestRunResults (testRequestLane.ts's own extraction/
 * baseline dispatch entry point — the completion handler's fire-and-forget
 * call target) against a REAL file-backed database and REAL worker threads,
 * proving the two acceptance properties testRunIngestionWorker.test.ts's
 * direct-worker-function tests can't: (1) the completion handler itself
 * issues zero statements against test_perf_baselines/test_run_results/
 * test_run_summaries on the main-thread db connection while extracting a
 * large fixture, and (2) two same-project dispatches are serialized with
 * strictly increasing digest sample timestamps, not just serialized call
 * order.
 *
 * Kept in its own file (rather than testRequestLane.test.ts) because that
 * file mocks db/db.ts to an in-memory database and db/queries.ts's
 * ingestTestRunResultsOffMainThread — both must be real here so dispatch
 * actually takes the worker-thread branch instead of the `:memory:` sync
 * fallback.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import type Database from 'better-sqlite3';

let tmpDir: string | undefined;

// Mirrors testRequestLane.test.ts's own `vi.mock('../../db/db', async () =>
// ...)` pattern (constructing the db inside the factory, not referencing an
// outer variable) — vi.mock factories run during the hoisted import phase,
// before any of this file's own top-level statements have executed, so a
// factory that closed over an outer `const` declared below it would see it
// uninitialized. Unlike that file's setupTestDb() (`:memory:`), this opens a
// real on-disk file so ingestTestRunResultsOffMainThread's `db.name` check
// takes the worker-thread branch instead of the sync fallback.
vi.mock('../../db/db', async () => {
  const fsMod = await import('fs');
  const osMod = await import('os');
  const pathMod = await import('path');
  const { default: DatabaseCtor } = await import('better-sqlite3');
  const { runMigrations } = await import('../../db/schema.js');
  const dir = fsMod.mkdtempSync(
    pathMod.join(osMod.tmpdir(), 'test-request-lane-off-thread-test-'),
  );
  tmpDir = dir;
  const file = pathMod.join(dir, 'test.db');
  const database = new DatabaseCtor(file);
  // Mirrors db.ts's real startup pragmas — see
  // flakyTestRollupOffMainThread.test.ts's matching comment for why this
  // matters for a short-lived file-backed test database specifically.
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  runMigrations(database);
  return { db: database };
});

import { db as fileDb } from '../../db/db';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  getLatestTestRequestRun,
  getTestRunSummary,
  runHasExtractedReport,
} from '../../db/queries';
import { ingestTestRunResults } from '../testRequestLane';

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** Records every SQL string passed to db.prepare, without altering behavior. */
function spyOnPrepare(database: Database.Database): {
  statements: string[];
  restore: () => void;
} {
  const statements: string[] = [];
  const original = database.prepare.bind(database);
  database.prepare = ((sql: string) => {
    statements.push(sql);
    return original(sql);
  }) as typeof database.prepare;
  return {
    statements,
    restore: () => {
      database.prepare = original;
    },
  };
}

const FORBIDDEN_TABLES = [
  'test_perf_baselines',
  'test_run_results',
  'test_run_summaries',
];

function structuredResultFor(
  tests: { id: string; outcome: 'passed' | 'failed'; durationMs: number }[],
): string {
  return JSON.stringify({
    suites: [
      {
        tests: tests.map((t) => ({
          id: t.id,
          name: t.id,
          outcome: t.outcome,
          durationMs: t.durationMs,
        })),
      },
    ],
  });
}

describe('ingestTestRunResults — off-main-thread dispatch against a real file-backed db', () => {
  it('issues zero statements against test_perf_baselines/test_run_results/test_run_summaries on the main-thread connection while extracting a 5,000-test fixture — the rows appear via the worker', async () => {
    insertTestRequestRun(
      'run-real-worker-5000',
      'proj-real-worker',
      'hash-real-worker-5000',
      null,
      Date.now(),
    );
    const totalTests = 5000;
    const structured = structuredResultFor(
      Array.from({ length: totalTests }, (_, i) => ({
        id: `t${i}`,
        outcome: 'passed' as const,
        durationMs: 10,
      })),
    );
    completeTestRequestRun(
      'run-real-worker-5000',
      'passed',
      'ok',
      null,
      structured,
    );

    const run = getLatestTestRequestRun(
      'proj-real-worker',
      'hash-real-worker-5000',
    )!;

    const spy = spyOnPrepare(fileDb);
    try {
      await ingestTestRunResults(run);
    } finally {
      spy.restore();
    }

    const forbiddenStatements = spy.statements.filter((sql) =>
      FORBIDDEN_TABLES.some((table) => sql.includes(table)),
    );
    expect(forbiddenStatements).toEqual([]);

    expect(runHasExtractedReport('run-real-worker-5000')).toBe(true);
    const summary = getTestRunSummary('run-real-worker-5000')!;
    expect(summary.total_count).toBe(totalTests);
    expect(summary.passed_count).toBe(totalTests);

    const baselineCount = (
      fileDb
        .prepare(
          `SELECT COUNT(*) as c FROM test_perf_baselines WHERE project_id = ?`,
        )
        .get('proj-real-worker') as { c: number }
    ).c;
    expect(baselineCount).toBe(totalTests);
  }, 60000);

  it('serializes two same-project dispatches with strictly increasing digest sample timestamps for the shared test_id', async () => {
    const projectId = 'proj-real-worker-serial';
    insertTestRequestRun(
      'run-real-serial-1',
      projectId,
      'hash-real-serial-1',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-real-serial-1',
      'passed',
      'ok',
      null,
      structuredResultFor([
        { id: 'shared-test', outcome: 'passed', durationMs: 5 },
      ]),
    );
    insertTestRequestRun(
      'run-real-serial-2',
      projectId,
      'hash-real-serial-2',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-real-serial-2',
      'passed',
      'ok',
      null,
      structuredResultFor([
        { id: 'shared-test', outcome: 'failed', durationMs: 6 },
      ]),
    );

    const run1 = getLatestTestRequestRun(projectId, 'hash-real-serial-1')!;
    const run2 = getLatestTestRequestRun(projectId, 'hash-real-serial-2')!;

    // Fired without awaiting between them — both settle "within the same
    // tick" from the caller's perspective, exactly like two runs completing
    // back-to-back in executeTestRequestRun's fire-and-forget dispatch.
    await Promise.all([ingestTestRunResults(run1), ingestTestRunResults(run2)]);

    expect(runHasExtractedReport('run-real-serial-1')).toBe(true);
    expect(runHasExtractedReport('run-real-serial-2')).toBe(true);

    const row = fileDb
      .prepare(
        `SELECT recent_outcomes FROM test_perf_baselines WHERE test_id = ?`,
      )
      .get('shared-test') as { recent_outcomes: string };
    const outcomes = JSON.parse(row.recent_outcomes) as {
      o: 'P' | 'F';
      t: number;
    }[];

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].o).toBe('P');
    expect(outcomes[1].o).toBe('F');
    expect(outcomes[1].t).toBeGreaterThan(outcomes[0].t);
  }, 60000);
});
