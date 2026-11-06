/**
 * Mechanical stash/revert check — kept in its own file (like
 * test-runner-junit.test.ts) since it exercises a real temp git repo and
 * spawns real `node` subprocesses, rather than test-runner.test.ts's
 * globally-mocked `fs`/`child_process`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { runStashRevertCheck, isLikelyTestFile } from '../test-runner';

let worktree: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-revert-'));
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: worktree,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(worktree, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

/** A harness script (committed at baseRef, never part of the diff under check) that runs implementation.js's add() against a fixed case and writes a JUnit report reflecting pass/fail. */
const TEST_RUNNER_SCRIPT = `
const fs = require('fs');
const { add } = require('./implementation.js');
const result = add(2, 3);
const pass = result === 5;
const testcase = pass
  ? '<testcase classname="math" name="adds numbers" time="0.01"/>'
  : '<testcase classname="math" name="adds numbers" time="0.01"><failure message="expected 5 got ' + result + '"/></testcase>';
fs.writeFileSync('junit.xml', '<testsuite name="suite" tests="1">' + testcase + '</testsuite>');
process.exit(pass ? 0 : 1);
`;

function commitAll(message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: worktree });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: worktree });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree })
    .toString()
    .trim();
}

describe('isLikelyTestFile', () => {
  it('matches common test-file conventions', () => {
    expect(isLikelyTestFile('src/math.test.ts')).toBe(true);
    expect(isLikelyTestFile('src/math.spec.js')).toBe(true);
    expect(isLikelyTestFile('src/__tests__/math.ts')).toBe(true);
    expect(isLikelyTestFile('tests/test_math.py')).toBe(true);
    expect(isLikelyTestFile('tests/math_test.py')).toBe(true);
    expect(isLikelyTestFile('src/implementation.js')).toBe(false);
  });
});

describe('runStashRevertCheck', () => {
  it('detects the test fails without the implementation diff and passes with it restored', async () => {
    write('test-runner.js', TEST_RUNNER_SCRIPT);
    write('implementation.js', 'module.exports.add = (a, b) => a - b;\n');
    const baseRef = commitAll('base: buggy implementation');

    // The diff under check: fix the implementation and add a test file for it.
    write('implementation.js', 'module.exports.add = (a, b) => a + b;\n');
    write('math.test.js', '// covers add() — see test-runner.js harness\n');

    const result = await runStashRevertCheck({
      worktreePath: worktree,
      changedFiles: ['implementation.js', 'math.test.js'],
      baseRef,
      testCommands: ['node test-runner.js'],
      reportGlob: 'junit.xml',
    });

    expect(result.verdict).toBe('confirmed');
    expect(result.withoutDiff?.passed).toBe(false);
    expect(result.withDiff?.passed).toBe(true);

    // The implementation file must be restored to its pre-check (diff-applied) content.
    expect(
      fs.readFileSync(path.join(worktree, 'implementation.js'), 'utf8'),
    ).toBe('module.exports.add = (a, b) => a + b;\n');
  });

  it('flags test_did_not_fail_without_diff when the test still passes with the implementation reverted', async () => {
    write('test-runner.js', TEST_RUNNER_SCRIPT);
    write('implementation.js', 'module.exports.add = (a, b) => a + b;\n');
    const baseRef = commitAll('base: implementation already correct');

    write('math.test.js', '// covers add()\n');

    const result = await runStashRevertCheck({
      worktreePath: worktree,
      changedFiles: ['implementation.js', 'math.test.js'],
      baseRef,
      testCommands: ['node test-runner.js'],
      reportGlob: 'junit.xml',
    });

    expect(result.verdict).toBe('test_did_not_fail_without_diff');
  });

  it('flags a vacuous result when the report shows zero executed assertions', async () => {
    const vacuousScript = `
const fs = require('fs');
fs.writeFileSync('junit.xml', '<testsuite name="suite" tests="1"><testcase classname="math" name="adds numbers" time="0.01"><skipped message="not implemented yet"/></testcase></testsuite>');
process.exit(1);
`;
    write('test-runner.js', vacuousScript);
    write('implementation.js', 'module.exports.add = (a, b) => a - b;\n');
    const baseRef = commitAll('base: buggy implementation');

    write('implementation.js', 'module.exports.add = (a, b) => a + b;\n');
    write('math.test.js', '// covers add() but is entirely skipped\n');

    const result = await runStashRevertCheck({
      worktreePath: worktree,
      changedFiles: ['implementation.js', 'math.test.js'],
      baseRef,
      testCommands: ['node test-runner.js'],
      reportGlob: 'junit.xml',
    });

    expect(result.verdict).toBe('vacuous_result');
  });

  it('flags a vacuous result when no report is collected at all (zero executed assertions)', async () => {
    const noReportScript = `process.exit(0);`;
    write('test-runner.js', noReportScript);
    write('implementation.js', 'module.exports.add = (a, b) => a - b;\n');
    const baseRef = commitAll('base: buggy implementation');

    write('implementation.js', 'module.exports.add = (a, b) => a + b;\n');
    write('math.test.js', '// no report ever written\n');

    const result = await runStashRevertCheck({
      worktreePath: worktree,
      changedFiles: ['implementation.js', 'math.test.js'],
      baseRef,
      testCommands: ['node test-runner.js'],
      reportGlob: 'junit.xml',
    });

    expect(result.verdict).toBe('vacuous_result');
  });

  it('returns no_test_files_changed when the diff touches no test files', async () => {
    write('implementation.js', 'module.exports.add = (a, b) => a - b;\n');
    const baseRef = commitAll('base');
    write('implementation.js', 'module.exports.add = (a, b) => a + b;\n');

    const result = await runStashRevertCheck({
      worktreePath: worktree,
      changedFiles: ['implementation.js'],
      baseRef,
      testCommands: ['node test-runner.js'],
      reportGlob: 'junit.xml',
    });

    expect(result.verdict).toBe('no_test_files_changed');
  });

  it('returns no_implementation_files_changed when the diff touches only test files', async () => {
    write('implementation.js', 'module.exports.add = (a, b) => a - b;\n');
    const baseRef = commitAll('base');
    write('math.test.js', '// new test only\n');

    const result = await runStashRevertCheck({
      worktreePath: worktree,
      changedFiles: ['math.test.js'],
      baseRef,
      testCommands: ['node test-runner.js'],
      reportGlob: 'junit.xml',
    });

    expect(result.verdict).toBe('no_implementation_files_changed');
  });

  it('restores already-reverted implementation files if the revert loop itself fails partway', async () => {
    write('test-runner.js', TEST_RUNNER_SCRIPT);
    write('implementation.js', 'module.exports.add = (a, b) => a - b;\n');
    write('sub/missing.js', '// present at baseRef\n');
    const baseRef = commitAll('base: buggy implementation');

    // The diff under check: fix the implementation, add a test, and delete
    // the "sub" directory entirely so reverting sub/missing.js to its
    // baseRef content throws ENOENT (no parent directory to write into) --
    // simulating a mid-loop revert failure after implementation.js has
    // already been successfully reverted.
    fs.rmSync(path.join(worktree, 'sub'), { recursive: true, force: true });
    write('implementation.js', 'module.exports.add = (a, b) => a + b;\n');
    write('math.test.js', '// covers add()\n');

    const result = await runStashRevertCheck({
      worktreePath: worktree,
      changedFiles: ['implementation.js', 'sub/missing.js', 'math.test.js'],
      baseRef,
      testCommands: ['node test-runner.js'],
      reportGlob: 'junit.xml',
    });

    expect(result.verdict).toBe('error');
    // implementation.js was reverted before the failure -- it must be
    // restored to its pre-check (diff-applied) content, not left at baseRef.
    expect(
      fs.readFileSync(path.join(worktree, 'implementation.js'), 'utf8'),
    ).toBe('module.exports.add = (a, b) => a + b;\n');
  });
});
