/**
 * Tests for runTestOutcomes.ts — the single accessor for per-test outcomes
 * that survives test_request_runs.structured_result being cleared — plus the
 * guard that keeps new code from reading `.structured_result` directly.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { mockBreadthFlagged } = vi.hoisted(() => ({
  mockBreadthFlagged: new Set<string>(),
}));
vi.mock('../../db/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/queries')>()),
  computeTestFailureBreadthFlag: (testId: string) => ({
    testId,
    distinctContentHashCount: mockBreadthFlagged.has(testId) ? 3 : 0,
    flagged: mockBreadthFlagged.has(testId),
  }),
}));

import {
  getRunTestOutcomes,
  readRunTestOutcomes,
  trackRunIngestion,
} from '../runTestOutcomes';
import { filterVerifyFailureByBaseHealth } from '../baseAttributableFilter';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  ingestTestRunResultsTx,
  clearExtractedStructuredResultsBatch,
  getTestRequestRunById,
} from '../../db/queries';
import type { ProjectConfig } from '../../config';
import type { StructuredTestResult } from '../../db/types';

const PROJECT = { id: 'proj-outcomes', projectDir: '/tmp/x' } as ProjectConfig;

const structured: StructuredTestResult = {
  format: 'junit-xml',
  suites: [
    {
      name: 'suite-a',
      tests: [
        { id: 't.pass', name: 'pass', outcome: 'passed', durationMs: 1 },
        { id: 't.fail', name: 'fail', outcome: 'failed', durationMs: 1 },
        { id: 't.err', name: 'err', outcome: 'error', durationMs: 1 },
      ],
    },
  ],
  totals: { passed: 1, failed: 1, skipped: 0, errors: 1 },
  durationMsTotal: 3,
} as unknown as StructuredTestResult;

/** Inserts a settled run with `structured` extracted into test_run_results/summaries. */
function seedExtractedRun(id: string, hash: string, state: 'failed' | 'passed') {
  insertTestRequestRun(id, PROJECT.id, hash, null, Date.now());
  completeTestRequestRun(
    id,
    state,
    '',
    null,
    JSON.stringify(structured),
    false,
    true,
  );
  ingestTestRunResultsTx(
    id,
    PROJECT.id,
    structured.suites.flatMap((s) =>
      s.tests.map((t) => ({
        test_id: t.id,
        name: t.name,
        outcome: t.outcome,
        duration_ms: 1,
      })),
    ),
    null,
    false,
    false,
  );
}

describe('readRunTestOutcomes', () => {
  it('reads the raw structured_result while present (source: structured)', () => {
    seedExtractedRun('run-out-structured', 'hash-out-1', 'failed');
    const run = getTestRequestRunById('run-out-structured')!;
    expect(run.structured_result).not.toBeNull();

    const out = readRunTestOutcomes(run);

    expect(out.source).toBe('structured');
    expect(out.failingTests.map((t) => t.test_id).sort()).toEqual([
      't.err',
      't.fail',
    ]);
    expect(out.totals).toEqual({
      passed: 1,
      failed: 1,
      skipped: 0,
      errors: 1,
      total: 3,
    });
    expect(out.suiteNames).toEqual(['suite-a']);
  });

  it('falls back to test_run_summaries + test_run_results once structured_result is cleared, with the same failing set and totals', () => {
    seedExtractedRun('run-out-cleared', 'hash-out-2', 'failed');
    const before = readRunTestOutcomes(getTestRequestRunById('run-out-cleared')!);

    clearExtractedStructuredResultsBatch();
    const cleared = getTestRequestRunById('run-out-cleared')!;
    expect(cleared.structured_result).toBeNull();
    const after = readRunTestOutcomes(cleared);

    expect(after.source).toBe('extracted');
    expect(after.failingTests.map((t) => t.test_id).sort()).toEqual(
      before.failingTests.map((t) => t.test_id).sort(),
    );
    expect(after.totals).toEqual(before.totals);
    expect(after.incomplete).toBe(before.incomplete);
  });

  it('reports source none for a run with neither a structured_result nor an extracted summary', () => {
    insertTestRequestRun('run-out-none', PROJECT.id, 'hash-out-3', null, 1);
    completeTestRequestRun('run-out-none', 'failed', '', null, null);

    const out = readRunTestOutcomes(getTestRequestRunById('run-out-none')!);

    expect(out.source).toBe('none');
    expect(out.failingTests).toEqual([]);
    expect(out.parseFailed).toBe(false);
  });

  it('flags parseFailed for an unparsable structured_result with no extracted fallback', () => {
    insertTestRequestRun('run-out-bad', PROJECT.id, 'hash-out-4', null, 1);
    completeTestRequestRun('run-out-bad', 'failed', '', null, '{not json');

    const out = readRunTestOutcomes(getTestRequestRunById('run-out-bad')!);

    expect(out.source).toBe('none');
    expect(out.parseFailed).toBe(true);
  });
});

describe('getRunTestOutcomes', () => {
  it("awaits the run's pending ingestion before reading", async () => {
    insertTestRequestRun('run-out-pending', PROJECT.id, 'hash-out-5', null, 1);
    completeTestRequestRun('run-out-pending', 'failed', '', null, null);
    const pending = Promise.resolve().then(() => {
      ingestTestRunResultsTx(
        'run-out-pending',
        PROJECT.id,
        [{ test_id: 't.late', name: 'late', outcome: 'failed', duration_ms: 1 }],
        null,
        false,
        false,
      );
    });
    trackRunIngestion('run-out-pending', pending);

    const out = await getRunTestOutcomes('run-out-pending');

    expect(out.source).toBe('extracted');
    expect(out.failingTests.map((t) => t.test_id)).toEqual(['t.late']);
  });
});

describe('verify gate regression — structured_result cleared between runs on the same content hash', () => {
  it('a verify run passes with base-attributable exclusions, and the next verify on the same content hash (structured_result nulled) passes with the same exclusions', async () => {
    mockBreadthFlagged.clear();
    mockBreadthFlagged.add('t.fail');
    mockBreadthFlagged.add('t.err');
    const hash = 'hash-verify-regression';

    seedExtractedRun('run-verify-fresh', hash, 'failed');
    const fresh = await filterVerifyFailureByBaseHealth(
      PROJECT,
      'run-verify-fresh',
      null,
    );
    expect(fresh?.outcome).toBe('filtered_pass');
    expect(fresh?.passed).toBe(true);

    expect(clearExtractedStructuredResultsBatch()).toBeGreaterThan(0);
    expect(
      getTestRequestRunById('run-verify-fresh')!.structured_result,
    ).toBeNull();

    // Replay of the settled row on the unchanged content hash.
    const replayed = await filterVerifyFailureByBaseHealth(
      PROJECT,
      'run-verify-fresh',
      null,
    );

    expect(replayed?.outcome).toBe('filtered_pass');
    expect(replayed?.passed).toBe(true);
    expect(replayed?.excludedTests.map((t) => t.test_id).sort()).toEqual(
      fresh?.excludedTests.map((t) => t.test_id).sort(),
    );
  });
});

describe('guard: per-test outcomes are read only through runTestOutcomes.ts', () => {
  const SRC_ROOT = path.resolve(__dirname, '../..');
  const ALLOWED = new Set([
    'orchestration/runTestOutcomes.ts',
    'orchestration/testRequestLane.ts',
    'db/queries.ts',
  ]);

  function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') {
          continue;
        }
        listSourceFiles(full, out);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(full);
      }
    }
    return out;
  }

  it('no file outside the accessor, the extraction producer, and db/queries.ts reads .structured_result', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        const code = line.replace(/\/\/.*$/, '');
        if (/\.structured_result\b/.test(code)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `Read per-test outcomes via getRunTestOutcomes/readRunTestOutcomes (orchestration/runTestOutcomes.ts), not .structured_result:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
