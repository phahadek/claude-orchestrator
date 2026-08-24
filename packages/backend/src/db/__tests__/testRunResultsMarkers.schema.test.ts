/**
 * Migration test for the additive `markers` column on test_run_results and
 * test_perf_baselines (capture-pytest-marker-metadata task): both gain a
 * nullable TEXT column holding a JSON array of marker/tag strings, with no
 * backfill for pre-existing rows.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe('test_run_results.markers / test_perf_baselines.markers migration', () => {
  it('adds a nullable markers column to test_run_results', () => {
    const db = freshDb();
    expect(columnNames(db, 'test_run_results')).toContain('markers');
    db.close();
  });

  it('adds a nullable markers column to test_perf_baselines', () => {
    const db = freshDb();
    expect(columnNames(db, 'test_perf_baselines')).toContain('markers');
    db.close();
  });

  it('reads back as NULL for rows inserted before the column existed, with no backfill', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
       VALUES ('run-1', 'proj', 'hash-1', NULL, 'passed', '', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, project_id, test_id, name, outcome, duration_ms, created_at)
       VALUES ('run-1', 'proj', 'tests.test_foo', 'test_foo', 'failed', 10, 0)`,
    ).run();
    const row = db
      .prepare(`SELECT markers FROM test_run_results WHERE test_request_run_id = 'run-1'`)
      .get() as { markers: string | null };
    expect(row.markers).toBeNull();

    db.prepare(
      `INSERT INTO test_perf_baselines
         (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
       VALUES ('tests.test_foo', 'proj', 'test_foo', 10, 0, 1, 10, 0, 0)`,
    ).run();
    const baseline = db
      .prepare(`SELECT markers FROM test_perf_baselines WHERE test_id = 'tests.test_foo'`)
      .get() as { markers: string | null };
    expect(baseline.markers).toBeNull();
    db.close();
  });

  it('running migrations again on an already-migrated db is a no-op (idempotent)', () => {
    const db = freshDb();
    expect(() => runMigrations(db)).not.toThrow();
    expect(columnNames(db, 'test_run_results')).toContain('markers');
    expect(columnNames(db, 'test_perf_baselines')).toContain('markers');
    db.close();
  });
});
