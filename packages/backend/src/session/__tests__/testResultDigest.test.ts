import { describe, it, expect } from 'vitest';
import {
  appendAwaitingDispositionInstruction,
  buildTestResultDigest,
  buildTestResultDigestFromOutcomes,
} from '../testResultDigest';

function outcomes(failed: number, incomplete: boolean) {
  return {
    incomplete,
    failingTests: Array.from({ length: failed }, (_, i) => ({
      test_id: `t${i}`,
      name: `n${i}`,
    })),
    totals: { passed: 10, failed, skipped: 0, errors: 0, total: 10 + failed },
  };
}
const runFailure = {
  failedCommand: 'uv run task test-static',
  outputTail: 'FAILED tests/test_mock_boundary_audit.py::x',
};

describe('buildTestResultDigestFromOutcomes runFailure', () => {
  it('renders command and tail when incomplete with 0 failed', () => {
    const d = buildTestResultDigestFromOutcomes(outcomes(0, true), {
      runFailure,
    });
    expect(d).toContain('uv run task test-static');
    expect(d).toContain('FAILED tests/test_mock_boundary_audit.py::x');
  });

  it('renders the block when complete with 0 failed', () => {
    const d = buildTestResultDigestFromOutcomes(outcomes(0, false), {
      runFailure,
    });
    expect(d).toContain('Failure outside the structured report');
  });

  it('is unchanged when failures are attributed and report is complete', () => {
    const base = buildTestResultDigestFromOutcomes(outcomes(2, false));
    expect(
      buildTestResultDigestFromOutcomes(outcomes(2, false), { runFailure }),
    ).toBe(base);
  });

  it('is unchanged without runFailure', () => {
    expect(buildTestResultDigestFromOutcomes(outcomes(0, true))).not.toContain(
      'Failure outside',
    );
  });
});

describe('appendAwaitingDispositionInstruction', () => {
  it('appends the wait instruction only when the marker is present', () => {
    const withMarker = appendAwaitingDispositionInstruction('digest', true);
    expect(withMarker).toContain('digest');
    expect(withMarker).toContain('outside your diff');
    expect(withMarker).toContain('woken at most once');
    expect(withMarker).toContain('flaky_confirm');
    expect(appendAwaitingDispositionInstruction('digest', false)).toBe(
      'digest',
    );
  });
});

function structuredResult(
  tests: { id: string; name: string; outcome: string; durationMs: number }[],
): string {
  return JSON.stringify({ suites: [{ tests }] });
}

describe('buildTestResultDigest', () => {
  it('renders pass/fail counts and failing test ids/names', () => {
    const json = structuredResult([
      { id: 't1', name: 'adds numbers', outcome: 'passed', durationMs: 5 },
      { id: 't2', name: 'subtracts numbers', outcome: 'failed', durationMs: 7 },
    ]);
    const digest = buildTestResultDigest(json);
    expect(digest).toContain('1 passed, 1 failed');
    expect(digest).toContain('`t2`');
    expect(digest).toContain('subtracts numbers');
  });

  it('caps and elides when failure count exceeds the display threshold', () => {
    const tests = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`,
      name: `test ${i}`,
      outcome: 'failed',
      durationMs: 1,
    }));
    const digest = buildTestResultDigest(structuredResult(tests), {
      maxFailuresShown: 20,
    });
    expect(digest).toContain('25 failed');
    expect(digest).toContain('`t0`');
    expect(digest).not.toContain('`t20`');
    expect(digest).toContain('...5 more failing tests elided.');
  });

  it('returns null for unparseable structured_result', () => {
    expect(buildTestResultDigest('not json')).toBeNull();
  });

  it('returns null when there are no tests to render', () => {
    expect(buildTestResultDigest(JSON.stringify({ suites: [] }))).toBeNull();
  });
});
