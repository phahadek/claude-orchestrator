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
} from '../db/queries.js';

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
    insertTestRequestRun(id, 'proj-1', 'hash-a');
    completeTestRequestRun(id, 'passed', 'all tests passed');

    // ...and PreReviewPipeline.buildTestsStage (or PRMergeWatcher's
    // merge-gate read) independently reading it back by the same key.
    const result = getLatestTestRequestRun('proj-1', 'hash-a');
    expect(result).toMatchObject({
      project_id: 'proj-1',
      content_hash: 'hash-a',
      state: 'passed',
      output: 'all tests passed',
    });
  });

  it('excludes still-running runs — a run in flight is not a cache hit', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-running');
    expect(getLatestTestRequestRun('proj-1', 'hash-running')).toBeUndefined();
  });

  it('scopes by project_id — a hit in one project is not visible to another project with the same content hash', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'shared-hash');
    completeTestRequestRun(id, 'passed', 'ok');
    expect(getLatestTestRequestRun('proj-2', 'shared-hash')).toBeUndefined();
  });

  it('returns the most recent completed run when several exist for the same key', () => {
    const first = nextRunId();
    insertTestRequestRun(first, 'proj-1', 'hash-b');
    completeTestRequestRun(first, 'failed', 'flaky failure');
    expect(getLatestTestRequestRun('proj-1', 'hash-b')?.state).toBe('failed');

    const second = nextRunId();
    insertTestRequestRun(second, 'proj-1', 'hash-b');
    completeTestRequestRun(second, 'passed', 'passed on rerun');

    const result = getLatestTestRequestRun('proj-1', 'hash-b');
    expect(result?.state).toBe('passed');
    expect(result?.output).toBe('passed on rerun');
  });

  it('delete removes every run for the key — the flaky.confirm invalidation path', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-c');
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
    insertTestRequestRun(id, 'proj-1', 'hash-structured');
    completeTestRequestRun(id, 'passed', 'ok', structured);

    const result = getLatestTestRequestRun('proj-1', 'hash-structured');
    expect(result?.structured_result).toBe(structured);
  });

  it('reads back null structured_result when none was provided — pre-existing rows keep working unchanged', () => {
    const id = nextRunId();
    insertTestRequestRun(id, 'proj-1', 'hash-no-structured');
    completeTestRequestRun(id, 'passed', 'ok');

    const result = getLatestTestRequestRun('proj-1', 'hash-no-structured');
    expect(result?.structured_result).toBeNull();
  });
});
