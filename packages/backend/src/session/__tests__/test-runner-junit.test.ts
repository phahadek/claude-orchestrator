/**
 * JUnit-XML acquisition/parsing/normalization for the test.request lane —
 * kept in its own file (rather than test-runner.test.ts) because that file
 * globally mocks `fs`, while collectStructuredTestResult deliberately
 * exercises real filesystem glob-matching against a temp worktree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { minimatch } from 'minimatch';
import {
  parseJUnitXml,
  collectStructuredTestResult,
  clearReportFiles,
} from '../test-runner';
import { loadOrchestratorConfig } from '../orchestrator-config';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

let worktree: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-acq-'));
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(worktree, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/** Backdates a file's mtime, simulating a report left over from a previous run. */
function backdate(relPath: string, mtimeMs: number): void {
  const full = path.join(worktree, relPath);
  const t = mtimeMs / 1000;
  fs.utimesSync(full, t, t);
}

const PYTEST_REPORT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
<testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.123">
<testcase classname="tests.test_foo" name="test_pass" time="0.010"/>
<testcase classname="tests.test_foo" name="test_fail" time="0.020">
<failure message="AssertionError: boom">Traceback (most recent call last):
  File "test_foo.py", line 10, in test_fail
    assert False
AssertionError: boom</failure>
</testcase>
<testcase classname="tests.test_foo" name="test_skip" time="0.000">
<skipped message="not implemented" type="pytest.skip"/>
</testcase>
</testsuite>
</testsuites>`;

const VITEST_REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="1" time="0.045">
<testsuite name="src/foo.test.ts" tests="2" failures="0" errors="1" time="0.045">
<testcase classname="src/foo.test.ts" name="does the thing" time="0.030"/>
<testcase classname="src/foo.test.ts" name="blows up" time="0.015">
<error message="TypeError: x is not a function">at src/foo.ts:5:1</error>
</testcase>
</testsuite>
</testsuites>`;

describe('parseJUnitXml', () => {
  it('parses passed/failed/skipped testcases with duration, message, and trace excerpt', () => {
    const suites = parseJUnitXml(PYTEST_REPORT);
    expect(suites).toHaveLength(1);
    expect(suites[0].name).toBe('pytest');
    expect(suites[0].tests).toHaveLength(3);

    const [pass, fail, skip] = suites[0].tests;
    expect(pass).toMatchObject({
      id: 'tests.test_foo.test_pass',
      name: 'test_pass',
      outcome: 'passed',
      durationMs: 10,
    });
    expect(fail).toMatchObject({
      id: 'tests.test_foo.test_fail',
      name: 'test_fail',
      outcome: 'failed',
      durationMs: 20,
      failureMessage: 'AssertionError: boom',
    });
    expect(fail.failureTraceExcerpt).toContain('assert False');
    expect(skip).toMatchObject({
      id: 'tests.test_foo.test_skip',
      name: 'test_skip',
      outcome: 'skipped',
      durationMs: 0,
      failureMessage: 'not implemented',
    });
  });

  it('parses error testcases distinctly from failures', () => {
    const suites = parseJUnitXml(VITEST_REPORT);
    expect(suites).toHaveLength(1);
    const [ok, errored] = suites[0].tests;
    expect(ok.outcome).toBe('passed');
    expect(errored).toMatchObject({
      outcome: 'error',
      failureMessage: 'TypeError: x is not a function',
    });
  });
});

describe('collectStructuredTestResult', () => {
  it('produces a normalized structured_result matching a single report file', () => {
    write('reports/junit.xml', PYTEST_REPORT);

    const result = collectStructuredTestResult(worktree, 'reports/*.xml');

    expect(result).not.toBeNull();
    expect(result!.format).toBe('junit-xml');
    expect(result!.suites).toHaveLength(1);
    expect(result!.suites[0].tests).toHaveLength(3);
    expect(result!.totals).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      errors: 0,
    });
    expect(result!.durationMsTotal).toBe(30);
  });

  it('merges multiple report files matched by one glob into a single result, losing no suites or tests', () => {
    write('reports/pytest.xml', PYTEST_REPORT);
    write('reports/vitest.xml', VITEST_REPORT);

    const result = collectStructuredTestResult(worktree, 'reports/*.xml');

    expect(result).not.toBeNull();
    expect(result!.suites.map((s) => s.name).sort()).toEqual(
      ['pytest', 'src/foo.test.ts'].sort(),
    );
    const allTests = result!.suites.flatMap((s) => s.tests);
    expect(allTests).toHaveLength(5);
    expect(result!.totals).toEqual({
      passed: 2,
      failed: 1,
      skipped: 1,
      errors: 1,
    });
  });

  it('returns null when the glob matches nothing', () => {
    write('other/file.txt', 'not a report');

    const result = collectStructuredTestResult(worktree, 'reports/*.xml');

    expect(result).toBeNull();
  });

  it('matches reports nested under packages/<pkg>/.test-reports (the shape the test: scripts actually produce)', () => {
    write('packages/frontend/.test-reports/frontend.xml', VITEST_REPORT);
    write('packages/backend/.test-reports/backend.xml', PYTEST_REPORT);

    const config = loadOrchestratorConfig(REPO_ROOT);
    const result = collectStructuredTestResult(
      worktree,
      config.test_report_glob,
    );

    expect(result).not.toBeNull();
    expect(result!.suites.map((s) => s.name).sort()).toEqual(
      ['pytest', 'src/foo.test.ts'].sort(),
    );
  });

  it('still matches a root-level report path (no regression for projects that write to the repo root)', () => {
    write('.test-reports/report.xml', PYTEST_REPORT);

    const result = collectStructuredTestResult(
      worktree,
      '**/.test-reports/*.xml',
    );

    expect(result).not.toBeNull();
    expect(result!.suites).toHaveLength(1);
  });

  it('marks the result incomplete when fewer report files are found than commands were run (e.g. a second suite crashed before writing its report)', () => {
    write('reports/frontend.xml', VITEST_REPORT);
    // backend.xml never written — its command crashed before teardown.

    const result = collectStructuredTestResult(worktree, 'reports/*.xml', 2);

    expect(result).not.toBeNull();
    expect(result!.incomplete).toBe(true);
    // The suite that DID produce a report must still be preserved, not
    // discarded — only the missing-suite signal is new.
    expect(result!.suites).toHaveLength(1);
  });

  it('does not mark the result incomplete when every expected report file is present', () => {
    write('reports/frontend.xml', VITEST_REPORT);
    write('reports/backend.xml', PYTEST_REPORT);

    const result = collectStructuredTestResult(worktree, 'reports/*.xml', 2);

    expect(result).not.toBeNull();
    expect(result!.incomplete).toBeUndefined();
  });

  it('defaults expectedReportCount to 1, so a single-command project is unaffected', () => {
    write('reports/junit.xml', PYTEST_REPORT);

    const result = collectStructuredTestResult(worktree, 'reports/*.xml');

    expect(result).not.toBeNull();
    expect(result!.incomplete).toBeUndefined();
  });

  describe('startedAt freshness guard', () => {
    it('does not ingest a stale report left over from a previous run when this run wrote nothing (single-command / polimarket shape)', () => {
      // Simulates: a prior run wrote reports/junit.xml; this run's command
      // crashed before its own teardown, so the file on disk is untouched
      // since before this run started.
      write('reports/junit.xml', PYTEST_REPORT);
      backdate('reports/junit.xml', Date.now() - 60_000);
      const startedAt = Date.now();

      const result = collectStructuredTestResult(
        worktree,
        'reports/*.xml',
        1,
        startedAt,
      );

      // Must fail against the pre-fix implementation, which ingests the
      // stale file's contents on existence alone.
      expect(result).toBeNull();
    });

    it('still ingests full per-test detail when a suite fails but writes a fresh report', () => {
      const startedAt = Date.now() - 1_000;
      write('reports/junit.xml', PYTEST_REPORT);

      const result = collectStructuredTestResult(
        worktree,
        'reports/*.xml',
        1,
        startedAt,
      );

      expect(result).not.toBeNull();
      expect(result!.suites).toHaveLength(1);
      expect(result!.suites[0].tests).toHaveLength(3);
      expect(result!.incomplete).toBeUndefined();
    });

    it('marks a multi-command run incomplete, and excludes the stale report, when one report is fresh and the other is stale', () => {
      const startedAt = Date.now() - 1_000;
      write('reports/frontend.xml', VITEST_REPORT);
      // backend.xml is left over from a previous run — its command crashed
      // before rewriting it this time.
      write('reports/backend.xml', PYTEST_REPORT);
      backdate('reports/backend.xml', startedAt - 120_000);

      const result = collectStructuredTestResult(
        worktree,
        'reports/*.xml',
        2,
        startedAt,
      );

      expect(result).not.toBeNull();
      expect(result!.incomplete).toBe(true);
      expect(result!.suites.map((s) => s.name)).toEqual(['src/foo.test.ts']);
    });

    it('single-command project still acquires normally with a fresh report and no expectedReportCount override', () => {
      const startedAt = Date.now() - 1_000;
      write('reports/junit.xml', PYTEST_REPORT);

      const result = collectStructuredTestResult(
        worktree,
        'reports/*.xml',
        1,
        startedAt,
      );

      expect(result).not.toBeNull();
      expect(result!.incomplete).toBeUndefined();
      expect(result!.totals).toEqual({
        passed: 1,
        failed: 1,
        skipped: 1,
        errors: 0,
      });
    });
  });
});

describe('clearReportFiles', () => {
  it('deletes every file matching the glob, leaving unrelated files untouched', () => {
    write('reports/frontend.xml', VITEST_REPORT);
    write('reports/backend.xml', PYTEST_REPORT);
    write('reports/notes.txt', 'keep me');

    clearReportFiles(worktree, 'reports/*.xml');

    expect(fs.existsSync(path.join(worktree, 'reports/frontend.xml'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(worktree, 'reports/backend.xml'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(worktree, 'reports/notes.txt'))).toBe(true);
  });

  it('is a no-op when nothing matches the glob', () => {
    write('other/file.txt', 'not a report');

    expect(() => clearReportFiles(worktree, 'reports/*.xml')).not.toThrow();
    expect(fs.existsSync(path.join(worktree, 'other/file.txt'))).toBe(true);
  });

  it('composes with collectStructuredTestResult so a cleared-then-rewritten report is ingested fresh, and a cleared-but-not-rewritten command is caught by the completeness check without stale content leaking in', () => {
    // Round 1: a normal run writes both reports.
    write('reports/frontend.xml', VITEST_REPORT);
    write('reports/backend.xml', PYTEST_REPORT);

    // Round 2 begins: cleanup runs before the new commands.
    clearReportFiles(worktree, 'reports/*.xml');
    const startedAt = Date.now() - 1_000;
    // Only the frontend command rewrites its report this time; backend
    // crashed before teardown.
    write('reports/frontend.xml', VITEST_REPORT);

    const result = collectStructuredTestResult(
      worktree,
      'reports/*.xml',
      2,
      startedAt,
    );

    expect(result).not.toBeNull();
    expect(result!.incomplete).toBe(true);
    expect(result!.suites.map((s) => s.name)).toEqual(['src/foo.test.ts']);
  });
});

describe("this repo's configured test_report_glob", () => {
  it('matches both packages/frontend/.test-reports/frontend.xml and packages/backend/.test-reports/backend.xml, so config and the test: scripts cannot drift apart', () => {
    const config = loadOrchestratorConfig(REPO_ROOT);

    expect(
      minimatch(
        'packages/frontend/.test-reports/frontend.xml',
        config.test_report_glob,
        {
          dot: true,
        },
      ),
    ).toBe(true);
    expect(
      minimatch(
        'packages/backend/.test-reports/backend.xml',
        config.test_report_glob,
        {
          dot: true,
        },
      ),
    ).toBe(true);
  });
});
