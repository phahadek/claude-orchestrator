import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  const db = setupTestDb();
  return { db };
});

import {
  insertTestRequestRun,
  completeTestRequestRun,
  getLatestTestRequestRun,
  deleteTestRequestRunsForContentHash,
  ingestTestRunResultsTx,
  getTestRequestRunOutput,
  cancelQueuedTestRequestRun,
} from '../db/queries.js';
import { db } from '../db/db.js';
import Database from 'better-sqlite3';
import {
  runMigrations,
  countRunOutputMismatches,
  dropInlineRunOutputColumn,
} from '../db/schema.js';

// ── test_request_runs — F2's shared content-hash cache ───────────────────────
//
// F2 (the orchestrator-run test gate) now reads/writes the same
// (project_id, content_hash)-keyed table the test.request lane
// (orchestration/testRequestLane.ts) uses — insertTestRequestRun /
// completeTestRequestRun are the lane's own write path; getLatestTestRequestRun
// / deleteTestRequestRunsForContentHash are the read/invalidate path F2 adds.

let seq = 0;
function nextRunId(): string {
  seq += 1;
  return `run-${seq}`;
}

describe('test_request_runs — F2 shared-cache read/invalidate', () => {
  it('returns undefined for a content hash with no prior run', () => {
    expect(getLatestTestRequestRun('proj-1', 'hash-a')).toBeUndefined();
  });

  it('a completed write from one caller is visible to a different caller reading the same key — the "shared cache" property', () => {
    // Simulates ReviewOrchestrator.runTestPipeline (via runProjectTestRequest)
    // writing the result...
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-a', null, Date.now());
    completeTestRequestRun(id, 'passed', 'all tests passed');

    // ...and PreReviewPipeline.buildTestsStage (or PRMergeWatcher's
    // merge-gate read) independently reading it back by the same key.
    const result = getLatestTestRequestRun('proj-1', 'hash-a');
    expect(result).toMatchObject({
      project_id: 'proj-1',
      content_hash: 'hash-a',
      state: 'passed',
    });
  });

  it('excludes still-running runs — a run in flight is not a cache hit', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-running', null, Date.now());
    expect(getLatestTestRequestRun('proj-1', 'hash-running')).toBeUndefined();
  });

  it('scopes by project_id — a hit in one project is not visible to another project with the same content hash', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'shared-hash', null, Date.now());
    completeTestRequestRun(id, 'passed', 'ok');
    expect(getLatestTestRequestRun('proj-2', 'shared-hash')).toBeUndefined();
  });

  it('returns the most recent completed run when several exist for the same key', () => {
    const first = nextRunId();
    insertTestRequestRun(first, 'proj-1', 'hash-b', null, Date.now());
    completeTestRequestRun(
      first,
      'failed',
      'flaky failure',
      'generic',
      JSON.stringify({
        format: 'junit-xml',
        suites: [],
        totals: { passed: 0, failed: 1, skipped: 0, errors: 0 },
        durationMsTotal: 5,
      }),
    );
    expect(getLatestTestRequestRun('proj-1', 'hash-b')?.state).toBe('failed');

    const second = nextRunId();
    insertTestRequestRun(second, 'proj-1', 'hash-b', null, Date.now());
    completeTestRequestRun(second, 'passed', 'passed on rerun');

    const result = getLatestTestRequestRun('proj-1', 'hash-b');
    expect(result?.state).toBe('passed');
    expect(getTestRequestRunOutput(result!.id)).toBe('passed on rerun');
  });

  it('delete removes every run for the key — the flaky.confirm invalidation path', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-c', null, Date.now());
    completeTestRequestRun(id, 'passed', 'ok');
    expect(getLatestTestRequestRun('proj-1', 'hash-c')).toBeDefined();

    deleteTestRequestRunsForContentHash('proj-1', 'hash-c');
    expect(getLatestTestRequestRun('proj-1', 'hash-c')).toBeUndefined();
  });

  it('a run recorded with a structured_result round-trips through the UPDATE/read path', () => {
    const id = nextRunId();
    const structured = JSON.stringify({
      format: 'junit-xml',
      suites: [],
      totals: { passed: 1, failed: 0, skipped: 0, errors: 0 },
      durationMsTotal: 12,
    });
    insertTestRequestRun(id, 'proj-1', 'hash-structured', null, Date.now());
    completeTestRequestRun(id, 'passed', 'ok', null, structured);

    const result = getLatestTestRequestRun('proj-1', 'hash-structured');
    expect(result?.structured_result).toBe(structured);
  });

  it('reads back null structured_result when none was provided — pre-existing rows keep working unchanged', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-no-structured', null, Date.now());
    completeTestRequestRun(id, 'passed', 'ok');

    const result = getLatestTestRequestRun('proj-1', 'hash-no-structured');
    expect(result?.structured_result).toBeNull();
  });

  it('a passed row in the post-sweep shape (structured_result NULL, test_report_acquisition_attempted=1, with a matching test_run_summaries row) is still a cache hit', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-post-sweep', null, Date.now());
    // The extraction drain (clearExtractedStructuredResultsBatch) durably
    // records the report via test_run_summaries, then nulls structured_result
    // on the run row itself — simulated here by completing with a null
    // structured_result but a durable summary row already present.
    completeTestRequestRun(id, 'passed', 'exited 0', null, null, false, true);
    ingestTestRunResultsTx(
      id,
      'proj-1',
      [
        {
          test_id: 'test-a',
          name: 'test-a',
          outcome: 'passed',
          duration_ms: 5,
        },
      ],
      null,
      false,
      false,
    );

    const result = getLatestTestRequestRun('proj-1', 'hash-post-sweep');
    expect(result?.id).toBe(id);
  });

  it('the same post-sweep shape with no test_run_summaries row stays excluded — the genuine passed-but-vacuous case', () => {
    const id = nextRunId();
    insertTestRequestRun(
      id,
      'proj-1',
      'hash-post-sweep-vacuous',
      null,
      Date.now(),
    );
    completeTestRequestRun(id, 'passed', 'exited 0', null, null, false, true);

    expect(
      getLatestTestRequestRun('proj-1', 'hash-post-sweep-vacuous'),
    ).toBeUndefined();
  });
});

describe('test_request_run_output — dual-write, copy, readers', () => {
  const sideOutput = (id: string): string | undefined =>
    (
      db
        .prepare(`SELECT output FROM test_request_run_output WHERE run_id = ?`)
        .get(id) as { output: string } | undefined
    )?.output;

  it('writes the side row alongside the terminal state', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-o', 'hash-o1', null, Date.now());
    expect(sideOutput(id)).toBe('');
    completeTestRequestRun(id, 'failed', 'boom');
    expect(sideOutput(id)).toBe('boom');
    expect(getTestRequestRunOutput(id)).toBe('boom');
  });

  it('cancel writes the side row with the column absent', () => {
    const a = nextRunId();
    insertTestRequestRun(
      a,
      'proj-o',
      'hash-o3',
      null,
      Date.now(),
      null,
      undefined,
      null,
      'queued',
    );
    cancelQueuedTestRequestRun(a, 'cancelled by operator');
    expect(getTestRequestRunOutput(a)).toBe('cancelled by operator');
  });
});

describe('test_request_runs.output drop migration', () => {
  function legacyDb(): Database.Database {
    const d = new Database(':memory:');
    runMigrations(d);
    d.exec(
      `ALTER TABLE test_request_runs ADD COLUMN output TEXT NOT NULL DEFAULT ''`,
    );
    d.prepare(`DELETE FROM schema_backfills WHERE name = ?`).run(
      'test_request_runs_output_drop_v1',
    );
    return d;
  }
  const hasColumn = (d: Database.Database): boolean =>
    (
      d.prepare(`PRAGMA table_info(test_request_runs)`).all() as {
        name: string;
      }[]
    ).some((c) => c.name === 'output');
  const insertLegacy = (d: Database.Database, id: string, out: string): void => {
    d.prepare(
      `INSERT INTO test_request_runs (id, project_id, content_hash, state, output, started_at)
       VALUES (?, 'p', 'h', 'failed', ?, 1)`,
    ).run(id, out);
  };

  it('refuses to drop when a side row is missing or differs, and keeps retrying', () => {
    const d = legacyDb();
    insertLegacy(d, 'a', 'out-a');
    insertLegacy(d, 'b', 'out-b');
    d.prepare(
      `INSERT INTO test_request_run_output (run_id, output) VALUES ('b', 'DIFFERENT')`,
    ).run();
    expect(countRunOutputMismatches(d)).toBe(2);
    dropInlineRunOutputColumn(d);
    expect(hasColumn(d)).toBe(true);
    expect(
      d
        .prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`)
        .get('test_request_runs_output_drop_v1'),
    ).toBeUndefined();
    d.close();
  });

  it('drops the column and sets the marker once every side row is byte-equal', () => {
    const d = legacyDb();
    insertLegacy(d, 'a', 'out-a');
    insertLegacy(d, 'e', '');
    d.prepare(
      `INSERT INTO test_request_run_output (run_id, output) VALUES ('a', 'out-a')`,
    ).run();
    expect(countRunOutputMismatches(d)).toBe(0);
    dropInlineRunOutputColumn(d);
    expect(hasColumn(d)).toBe(false);
    expect(
      d
        .prepare(`SELECT 1 FROM schema_backfills WHERE name = ?`)
        .get('test_request_runs_output_drop_v1'),
    ).toBeDefined();
    expect(countRunOutputMismatches(d)).toBe(0);
    dropInlineRunOutputColumn(d);
    d.close();
  });
});
