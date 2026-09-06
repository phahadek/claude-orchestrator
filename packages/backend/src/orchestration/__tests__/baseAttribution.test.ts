/**
 * Regression + unit tests for the retirement of whole-tree base-health
 * attribution:
 *  - baseHealthCheck.ts and baseAttribution.ts are deleted outright — no
 *    module provisions a base-health worktree, and getBaseHealthWorktreePath/
 *    isBaseTotalFail/isProjectBaseHealthy/hasBaseTotalFailSince no longer
 *    exist anywhere in the tree.
 *  - their replacement, db/queries.ts's isRunFailureBreadthAttributable, is a
 *    per-run breadth-attributability check: a run's failures are
 *    attributable only when EVERY one of them is flagged across
 *    flip_rate_breadth_n+ distinct content hashes within the lookback
 *    window — never when a failure is unique to that run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { isRunFailureBreadthAttributable } from '../../db/queries';

let seq = 0;

function insertRunWithFailure(opts: {
  testId: string;
  contentHash: string;
  createdAt: number;
}): string {
  seq += 1;
  const runId = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
     VALUES (@id, 'proj-1', @content_hash, NULL, 'failed', '', 0, 0, 0)`,
  ).run({ id: runId, content_hash: opts.contentHash });
  db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (@run_id, 'proj-1', @test_id, @test_id, 'failed', 1, 0, 0, @created_at)`,
  ).run({ run_id: runId, test_id: opts.testId, created_at: opts.createdAt });
  return runId;
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  seq = 0;
});

describe('base-health module deletion', () => {
  it('deletes baseHealthCheck.ts and baseAttribution.ts entirely', () => {
    expect(
      fs.existsSync(path.join(__dirname, '../baseHealthCheck.ts')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(__dirname, '../baseAttribution.ts')),
    ).toBe(false);
  });

  it('no source file declares isBaseTotalFail/isProjectBaseHealthy/hasBaseTotalFailSince', () => {
    const searchDirs = [
      '../../orchestration',
      '../../github',
      '../../audit',
      '../../routes',
      '../../db',
    ];
    const retiredNames =
      /\b(isBaseTotalFail|isProjectBaseHealthy|hasBaseTotalFailSince)\b/;
    for (const dir of searchDirs) {
      const abs = path.join(__dirname, dir);
      for (const file of fs.readdirSync(abs)) {
        const filePath = path.join(abs, file);
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
        if (fs.statSync(filePath).isDirectory()) continue;
        const src = fs.readFileSync(filePath, 'utf8');
        expect(src).not.toMatch(retiredNames);
      }
    }
  });

  it('no module in the tree provisions a base-health worktree', () => {
    const searchDirs = ['../../orchestration', '../../github', '../../audit'];
    for (const dir of searchDirs) {
      const abs = path.join(__dirname, dir);
      for (const file of fs.readdirSync(abs)) {
        const filePath = path.join(abs, file);
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
        if (fs.statSync(filePath).isDirectory()) continue;
        const src = fs.readFileSync(filePath, 'utf8');
        expect(src).not.toMatch(/getBaseHealthWorktreePath/);
      }
    }
  });
});

describe('isRunFailureBreadthAttributable', () => {
  it('attributes a run whose only failing test is breadth-flagged across enough distinct trees', () => {
    // The run under test, plus enough other trees failing the same test id
    // within the window to clear breadthN=3.
    const runId = insertRunWithFailure({
      testId: 'test-a',
      contentHash: 'hash-this-run',
      createdAt: 1000,
    });
    insertRunWithFailure({
      testId: 'test-a',
      contentHash: 'hash-2',
      createdAt: 900,
    });
    insertRunWithFailure({
      testId: 'test-a',
      contentHash: 'hash-3',
      createdAt: 800,
    });

    expect(isRunFailureBreadthAttributable(runId, 3, 24, 2000)).toBe(true);
  });

  it('does not attribute a run whose failure is unique to it (not seen on any other tree)', () => {
    const runId = insertRunWithFailure({
      testId: 'test-b',
      contentHash: 'hash-this-run',
      createdAt: 1000,
    });

    expect(isRunFailureBreadthAttributable(runId, 3, 24, 2000)).toBe(false);
  });

  it('does not attribute a run with no failing tests', () => {
    seq += 1;
    const runId = `run-${seq}`;
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
       VALUES (@id, 'proj-1', 'hash-clean', NULL, 'passed', '', 0, 0, 0)`,
    ).run({ id: runId });

    expect(isRunFailureBreadthAttributable(runId, 3, 24, 2000)).toBe(false);
  });

  it('requires every failing test to clear the breadth bar — one unflagged failure blocks attribution', () => {
    seq += 1;
    const runId = `run-${seq}`;
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
       VALUES (@id, 'proj-1', 'hash-mixed', NULL, 'failed', '', 0, 0, 0)`,
    ).run({ id: runId });
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES (@run_id, 'proj-1', 'test-flagged', 'test-flagged', 'failed', 1, 0, 0, 1000),
              (@run_id, 'proj-1', 'test-unique', 'test-unique', 'failed', 1, 0, 0, 1000)`,
    ).run({ run_id: runId });
    // test-flagged also fails on two other trees — clears breadthN=3
    // (this run + 2 others). test-unique fails nowhere else.
    insertRunWithFailure({
      testId: 'test-flagged',
      contentHash: 'hash-2',
      createdAt: 900,
    });
    insertRunWithFailure({
      testId: 'test-flagged',
      contentHash: 'hash-3',
      createdAt: 800,
    });

    expect(isRunFailureBreadthAttributable(runId, 3, 24, 2000)).toBe(false);
  });
});
