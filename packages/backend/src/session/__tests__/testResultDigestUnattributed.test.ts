import { describe, it, expect } from 'vitest';
import {
  buildTestResultDigestFromOutcomes,
  type UnattributedView,
} from '../testResultDigest';
import { renderBaseAttributableFilterDigest } from '../../orchestration/baseAttributableFilter';

function failing(n: number, mod = (i: number) => `pkg/m${i % 2}.test.ts`) {
  return Array.from({ length: n }, (_, i) => ({
    test_id: `${mod(i)}::t${i}`,
    name: `n${i}`,
    failure_message: i % 3 === 0 ? 'boom' : 'other',
  }));
}

function view(tests: { test_id: string }[], x = 20): UnattributedView {
  return {
    runId: 'run1',
    breadthN: 3,
    flipWindowW: 20,
    massBreakageThreshold: x,
    indicators: new Map(
      tests.length <= x
        ? tests.map((t) => [t.test_id, { breadth: 2, flips: 1 }])
        : [],
    ),
  };
}

function outcomes(tests: ReturnType<typeof failing>) {
  return {
    failingTests: tests,
    totals: {
      passed: 5,
      failed: tests.length,
      skipped: 0,
      errors: 0,
      total: 5 + tests.length,
    },
  };
}

describe('unattributed digest rendering', () => {
  it('renders one indicator line per test at or below the threshold', () => {
    const tests = failing(3);
    const d = buildTestResultDigestFromOutcomes(outcomes(tests), {
      unattributed: { view: view(tests), knownCount: 0 },
    })!;
    const lines = d.split('\n').filter((l) => l.startsWith('- `'));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).toContain('breadth 2/3');
      expect(l).toContain('flips 1/20');
      expect(l).not.toContain('getTestTrace');
    }
    expect(d).not.toContain('Mass breakage');
    expect(d.match(/testHealth_getTestTrace/g)).toHaveLength(1);
    expect(d).toContain(
      '_Failure detail: call mcp__orchestrator__testHealth_getTestTrace with { runId: "run1", testId: "<a test id above>" }',
    );
    expect(d).not.toContain('testHealth.getTestTrace(');
  });

  it('emits no pointer when no listed failure has stored detail', () => {
    const tests = failing(3).map((t) => ({ ...t, failure_message: null }));
    const d = buildTestResultDigestFromOutcomes(outcomes(tests), {
      unattributed: { view: view(tests), knownCount: 0 },
    })!;
    expect(d).not.toContain('getTestTrace');
  });

  it('emits one pointer on the grouped, plain and base-filter renderings', () => {
    const many = failing(25);
    const grouped = buildTestResultDigestFromOutcomes(outcomes(many), {
      unattributed: { view: view(many), knownCount: 0 },
    })!;
    expect(grouped.match(/testHealth_getTestTrace/g)).toHaveLength(1);

    const tests = failing(3);
    const plain = buildTestResultDigestFromOutcomes(outcomes(tests), {
      runId: 'run9',
    })!;
    expect(plain.match(/testHealth_getTestTrace/g)).toHaveLength(1);
    expect(plain).toContain('runId: "run9"');
    expect(buildTestResultDigestFromOutcomes(outcomes(tests))!).not.toContain(
      'getTestTrace',
    );

    const result = {
      outcome: 'filtered_partial' as const,
      passed: false,
      excludedTests: [],
      flakyExcludedTests: [],
      remainingTests: tests,
      baseRun: null,
    };
    const plainFilter = renderBaseAttributableFilterDigest(
      result,
      [],
      undefined,
      'run7',
    );
    expect(plainFilter.match(/testHealth_getTestTrace/g)).toHaveLength(1);
    expect(plainFilter).toContain('runId: "run7"');
    const unattrFilter = renderBaseAttributableFilterDigest(
      result,
      [],
      view(tests),
    );
    expect(unattrFilter.match(/testHealth_getTestTrace/g)).toHaveLength(1);
  });

  it('renders grouped output above the threshold with no per-test lines', () => {
    const tests = failing(25);
    const d = buildTestResultDigestFromOutcomes(outcomes(tests), {
      unattributed: { view: view(tests), knownCount: 0 },
    })!;
    expect(d).toContain('Mass breakage');
    expect(d).toContain('`pkg/m0.test.ts` — 13 failing');
    expect(d).toContain('most common: other');
    expect(d).not.toContain('breadth ');
    expect(d.split('\n').some((l) => l.includes('::t1`'))).toBe(false);
  });

  it('groups dotted pytest ids by module above the threshold', () => {
    const tests = Array.from({ length: 50 }, (_, i) => ({
      test_id: `tests.daemons.analysis.test_${i < 30 ? 'a' : 'b'}.TestX.test_y${i}`,
      name: `n${i}`,
      failure_message: 'boom',
    }));
    const d = buildTestResultDigestFromOutcomes(outcomes(tests), {
      unattributed: { view: view(tests), knownCount: 0 },
    })!;
    const lines = d.split('\n').filter((l) => l.startsWith('- `'));
    expect(lines).toHaveLength(2);
    expect(d).toContain('`tests.daemons.analysis.test_a` — 30 failing');
    expect(d).toContain('`tests.daemons.analysis.test_b` — 20 failing');
  });

  it('keeps the whole id for dotted ids without a test_ segment', () => {
    const tests = Array.from({ length: 25 }, (_, i) => ({
      test_id: `pkg.mod.Case${i}`,
      name: `n${i}`,
    }));
    const d = buildTestResultDigestFromOutcomes(outcomes(tests), {
      unattributed: { view: view(tests), knownCount: 0 },
    })!;
    expect(d).toContain('`pkg.mod.Case0` — 1 failing');
  });

  it('collapses already-attributed tests into +N known failures in both modes', () => {
    for (const n of [3, 25]) {
      const tests = failing(n);
      const d = renderBaseAttributableFilterDigest(
        {
          outcome: 'filtered_partial',
          passed: false,
          excludedTests: [
            { test_id: 'a', name: 'a' },
            { test_id: 'b', name: 'b' },
          ],
          flakyExcludedTests: [{ test_id: 'c', name: 'c' }],
          remainingTests: tests,
          baseRun: null,
        },
        [],
        view(tests),
      );
      expect(d).toContain('+3 known failures');
      expect(d.includes('Mass breakage')).toBe(n > 20);
    }
  });
});
