import { describe, it, expect } from 'vitest';
import { buildTestResultDigest } from '../testResultDigest';

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
