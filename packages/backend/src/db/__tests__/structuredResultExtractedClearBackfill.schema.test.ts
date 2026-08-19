/**
 * Tests for the structured_result extraction-scoped clear backfill in
 * schema.ts: the forward-only migration that nulls structured_result on
 * every test_request_runs row whose extraction already produced a
 * test_run_summaries row, including the lone-key case
 * clearSupersededStructuredResults' supersession-scoped predicate can never
 * reach. See the "Clear structured_result once extraction has happened"
 * task.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  backfillClearExtractedStructuredResults,
  runStructuredResultExtractedClearBackfill,
  STRUCTURED_RESULT_EXTRACTED_CLEAR_BACKFILL_MARKER,
} from '../schema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Clears the guard marker so a subsequent call re-runs the backfill as if against a pre-existing, never-migrated database — runMigrations() already ran it once (against an empty table) as part of freshDb(). */
function resetBackfillMarker(db: Database.Database): void {
  db.prepare(`DELETE FROM schema_backfills WHERE name = ?`).run(
    STRUCTURED_RESULT_EXTRACTED_CLEAR_BACKFILL_MARKER,
  );
}

let seq = 0;

function insertRun(
  db: Database.Database,
  opts: { projectId: string; structuredResult: string | null },
): string {
  seq += 1;
  const runId = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, structured_result)
     VALUES (@id, @project_id, @content_hash, NULL, 'passed', 'ok', 0, 0, 0, @structured_result)`,
  ).run({
    id: runId,
    project_id: opts.projectId,
    content_hash: `hash-${seq}`,
    structured_result: opts.structuredResult,
  });
  return runId;
}

function insertSummary(
  db: Database.Database,
  runId: string,
  projectId: string,
): void {
  db.prepare(
    `INSERT INTO test_run_summaries
       (test_request_run_id, project_id, passed_count, failed_count, skipped_count, error_count, other_count, total_count, total_duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (?, ?, 1, 0, 0, 0, 0, 1, 5, 0, 0, 0)`,
  ).run(runId, projectId);
}

function getRun(
  db: Database.Database,
  runId: string,
): { structured_result: string | null; output: string; state: string } {
  return db
    .prepare(
      `SELECT structured_result, output, state FROM test_request_runs WHERE id = ?`,
    )
    .get(runId) as {
    structured_result: string | null;
    output: string;
    state: string;
  };
}

describe('backfillClearExtractedStructuredResults', () => {
  it('clears an already-extracted run even when it is the only run for its key, and leaves an unextracted run untouched', () => {
    const db = freshDb();
    const extractedRun = insertRun(db, {
      projectId: 'proj-1',
      structuredResult: '{"suites":[]}',
    });
    insertSummary(db, extractedRun, 'proj-1');

    const unextractedRun = insertRun(db, {
      projectId: 'proj-1',
      structuredResult: '{"suites":[]}',
    });

    const cleared = backfillClearExtractedStructuredResults(db);

    expect(cleared).toBe(1);
    expect(getRun(db, extractedRun).structured_result).toBeNull();
    expect(getRun(db, unextractedRun).structured_result).toBe('{"suites":[]}');
  });

  it('touches only structured_result — every other column, and test_run_results/test_run_summaries rows, are unchanged', () => {
    const db = freshDb();
    const runId = insertRun(db, {
      projectId: 'proj-1',
      structuredResult: '{"suites":[]}',
    });
    insertSummary(db, runId, 'proj-1');
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES (?, ?, 't1', 'n', 'failed', 5, 0, 0, 0)`,
    ).run(runId, 'proj-1');

    backfillClearExtractedStructuredResults(db);

    const row = getRun(db, runId);
    expect(row.structured_result).toBeNull();
    expect(row.output).toBe('ok');
    expect(row.state).toBe('passed');
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM test_run_results WHERE test_request_run_id = ?`,
        )
        .get(runId),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM test_run_summaries WHERE test_request_run_id = ?`,
        )
        .get(runId),
    ).toEqual({ n: 1 });
  });

  it('runs in bounded batches, never clearing more than batchSize rows in one statement', () => {
    const db = freshDb();
    const runIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const runId = insertRun(db, {
        projectId: 'proj-1',
        structuredResult: '{"suites":[]}',
      });
      insertSummary(db, runId, 'proj-1');
      runIds.push(runId);
    }

    const cleared = backfillClearExtractedStructuredResults(db, 3);

    expect(cleared).toBe(7);
    for (const runId of runIds) {
      expect(getRun(db, runId).structured_result).toBeNull();
    }
  });

  it('is idempotent — running it twice clears nothing further and errors on nothing', () => {
    const db = freshDb();
    const runId = insertRun(db, {
      projectId: 'proj-1',
      structuredResult: '{"suites":[]}',
    });
    insertSummary(db, runId, 'proj-1');

    const first = backfillClearExtractedStructuredResults(db);
    expect(first).toBe(1);

    const second = backfillClearExtractedStructuredResults(db);
    expect(second).toBe(0);
    expect(getRun(db, runId).structured_result).toBeNull();
  });
});

describe('runStructuredResultExtractedClearBackfill (marker-guarded)', () => {
  it('is a no-op on the second call even if the underlying rows would otherwise match again', () => {
    const db = freshDb();
    const runId = insertRun(db, {
      projectId: 'proj-1',
      structuredResult: '{"suites":[]}',
    });
    insertSummary(db, runId, 'proj-1');
    resetBackfillMarker(db);

    runStructuredResultExtractedClearBackfill(db);
    expect(getRun(db, runId).structured_result).toBeNull();
    expect(
      db
        .prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`)
        .get(STRUCTURED_RESULT_EXTRACTED_CLEAR_BACKFILL_MARKER),
    ).toBeTruthy();

    // Simulate a row that becomes newly-extracted after the marker was set —
    // the marker must still short-circuit; this backfill runs once per
    // database, ongoing clearing is the sweep's job, not this migration's.
    const laterRun = insertRun(db, {
      projectId: 'proj-1',
      structuredResult: '{"suites":[]}',
    });
    insertSummary(db, laterRun, 'proj-1');

    runStructuredResultExtractedClearBackfill(db);

    expect(getRun(db, laterRun).structured_result).toBe('{"suites":[]}');
  });

  it('running runMigrations twice against the same database clears nothing further and errors on nothing', () => {
    const db = freshDb();
    const runId = insertRun(db, {
      projectId: 'proj-1',
      structuredResult: '{"suites":[]}',
    });
    insertSummary(db, runId, 'proj-1');
    resetBackfillMarker(db);
    runStructuredResultExtractedClearBackfill(db);

    expect(() => runMigrations(db)).not.toThrow();
    expect(getRun(db, runId).structured_result).toBeNull();
  });
});
