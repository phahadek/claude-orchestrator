/**
 * Unit tests for classifyTestRunOutcome's Tests-tab outcome taxonomy — a
 * pure function over TestRequestRunRow, no DB required.
 */

import { describe, it, expect } from 'vitest';
import { classifyTestRunOutcome } from '../baseHealthCheck';
import type { TestRequestRunRow } from '../../db/types';

function makeRun(
  overrides: Partial<TestRequestRunRow> = {},
): TestRequestRunRow {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    content_hash: 'hash-1',
    session_id: 'session-1',
    state: 'passed',
    output: '',
    requested_at: 1000,
    started_at: 1000,
    finished_at: 2000,
    structured_result: null,
    failure_reason: null,
    concurrent_run_count: 0,
    oom_killed: 0,
    ...overrides,
  };
}

const structuredWithTests = JSON.stringify({
  format: 'junit-xml',
  suites: [],
  totals: { passed: 1, failed: 1, skipped: 0, errors: 0 },
  durationMsTotal: 100,
});

describe('classifyTestRunOutcome', () => {
  it('classifies a running run', () => {
    const result = classifyTestRunOutcome(makeRun({ state: 'running' }));
    expect(result.outcome).toBe('running');
    expect(result.nextAction).toBeTruthy();
  });

  it('classifies a passed run', () => {
    const result = classifyTestRunOutcome(makeRun({ state: 'passed' }));
    expect(result.outcome).toBe('passed');
  });

  it('classifies a passed scoped run as passed-scoped, never passed', () => {
    const result = classifyTestRunOutcome(
      makeRun({ state: 'passed', run_kind: 'scoped' }),
    );
    expect(result.outcome).toBe('passed-scoped');
    expect(result.outcome).not.toBe('passed');
  });

  it('classifies a failed run with a per-test breakdown as failed-with-named-tests', () => {
    const result = classifyTestRunOutcome(
      makeRun({ state: 'failed', structured_result: structuredWithTests }),
    );
    expect(result.outcome).toBe('failed-with-named-tests');
  });

  it('classifies a failed run with null structured_result and failure_reason=generic as failed-with-no-report-acquired', () => {
    const result = classifyTestRunOutcome(
      makeRun({
        state: 'failed',
        structured_result: null,
        failure_reason: 'generic',
      }),
    );
    expect(result.outcome).toBe('failed-with-no-report-acquired');
  });

  it('classifies a failed run with oom_killed=1 as crashed-oom', () => {
    const result = classifyTestRunOutcome(
      makeRun({
        state: 'failed',
        structured_result: null,
        failure_reason: 'generic',
        oom_killed: 1,
      }),
    );
    expect(result.outcome).toBe('crashed-oom');
  });

  it('classifies a failed run with failure_reason=timeout as timed-out', () => {
    const result = classifyTestRunOutcome(
      makeRun({
        state: 'failed',
        structured_result: null,
        failure_reason: 'timeout',
      }),
    );
    expect(result.outcome).toBe('timed-out');
  });

  it('every outcome has a distinct next-action string', () => {
    const outcomes = [
      classifyTestRunOutcome(makeRun({ state: 'running' })).outcome,
      classifyTestRunOutcome(makeRun({ state: 'passed' })).outcome,
      classifyTestRunOutcome(
        makeRun({ state: 'passed', run_kind: 'scoped' }),
      ).outcome,
      classifyTestRunOutcome(
        makeRun({ state: 'failed', structured_result: structuredWithTests }),
      ).outcome,
      classifyTestRunOutcome(
        makeRun({
          state: 'failed',
          structured_result: null,
          failure_reason: 'generic',
        }),
      ).outcome,
      classifyTestRunOutcome(
        makeRun({ state: 'failed', oom_killed: 1, failure_reason: 'generic' }),
      ).outcome,
      classifyTestRunOutcome(
        makeRun({ state: 'failed', failure_reason: 'timeout' }),
      ).outcome,
    ];
    expect(new Set(outcomes).size).toBe(7);
  });
});
