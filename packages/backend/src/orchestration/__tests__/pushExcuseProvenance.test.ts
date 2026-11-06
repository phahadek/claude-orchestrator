import { describe, it, expect } from 'vitest';
import { db } from '../../db/db';
import {
  insertTestRequestRun,
  ingestTestRunResultsTx,
  markTestResultExcused,
  countFailedRunsWithoutPerTestReport,
} from '../../db/queries';
import { hasNoPerTestReport } from '../testRequestLane';
import type { TestRequestRunRow } from '../../db/types';

function excusalOf(runId: string, testId: string) {
  return db
    .prepare(
      `SELECT excused_reason, excused_evidence_count FROM test_run_results
       WHERE test_request_run_id = ? AND test_id = ?`,
    )
    .get(runId, testId) as {
    excused_reason: string | null;
    excused_evidence_count: number | null;
  };
}

describe('push excuse provenance', () => {
  it('records a distinct source and the evidence count for a push excuse', () => {
    const id = 'run-push-excuse-1';
    insertTestRequestRun(id, 'proj-pe', 'hash-pe-1', null, Date.now());
    ingestTestRunResultsTx(
      id,
      'proj-pe',
      [
        { test_id: 'a', name: 'a', outcome: 'failed', duration_ms: 1 },
        { test_id: 'b', name: 'b', outcome: 'failed', duration_ms: 1 },
      ],
      null,
      false,
      false,
    );

    markTestResultExcused(id, 'a', 'push_reattribution', 3);
    markTestResultExcused(id, 'b', 'breadth_corpus');

    const push = excusalOf(id, 'a');
    const pull = excusalOf(id, 'b');
    expect(push.excused_reason).toBe('push_reattribution');
    expect(push.excused_evidence_count).toBe(3);
    expect(pull.excused_reason).not.toBe(push.excused_reason);
    expect(pull.excused_evidence_count).toBeNull();
  });

  it('counts failed runs with no per-test report by failure_reason', () => {
    const noReport = 'run-pe-noreport';
    const withReport = 'run-pe-report';
    insertTestRequestRun(noReport, 'proj-pe2', 'hash-pe-2', null, Date.now());
    insertTestRequestRun(withReport, 'proj-pe2', 'hash-pe-3', null, Date.now());
    ingestTestRunResultsTx(
      withReport,
      'proj-pe2',
      [{ test_id: 't', name: 't', outcome: 'failed', duration_ms: 1 }],
      null,
      false,
      false,
    );
    db.prepare(
      `UPDATE test_request_runs SET state = 'failed', failure_reason = 'timeout' WHERE id = ?`,
    ).run(noReport);
    db.prepare(
      `UPDATE test_request_runs SET state = 'failed', failure_reason = 'generic' WHERE id = ?`,
    ).run(withReport);

    const rows = countFailedRunsWithoutPerTestReport();
    expect(rows.find((r) => r.failure_reason === 'timeout')?.count).toBe(1);
    expect(rows.find((r) => r.failure_reason === 'generic')).toBeUndefined();

    const run = (id: string) =>
      db
        .prepare(`SELECT * FROM test_request_runs WHERE id = ?`)
        .get(id) as TestRequestRunRow;
    expect(hasNoPerTestReport(run(noReport))).toBe(true);
    expect(hasNoPerTestReport(run(withReport))).toBe(false);
  });
});
