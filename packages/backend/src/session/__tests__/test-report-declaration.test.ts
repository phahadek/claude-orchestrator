/**
 * Declaration contract for the nothing-exercised marker: root-level JUnit
 * properties on a command's own report. Real-filesystem, like
 * test-runner-junit.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectTestReportDeclaration } from '../testReportCollector';

let worktree: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-decl-'));
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = path.join(worktree, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

const GLOB = '**/.test-reports/*.xml';

describe('collectTestReportDeclaration', () => {
  it('declares with no claims for a report carrying orchestrator.declares only', () => {
    write(
      'packages/a/.test-reports/a.xml',
      '<testsuites tests="0"><properties><property name="orchestrator.declares" value="1"/></properties></testsuites>',
    );
    expect(collectTestReportDeclaration(worktree, GLOB, 1)).toEqual({
      allDeclared: true,
      claimedPaths: [],
    });
  });

  it('collects claimed paths from a report that ran tests', () => {
    write(
      'packages/a/.test-reports/a.xml',
      '<testsuites><properties><property name="orchestrator.declares" value="1"/>' +
        '<property name="orchestrator.claimed_path" value="packages/a/x.ts"/>' +
        '<property name="orchestrator.claimed_path" value="packages/a/y &amp; z.ts"/>' +
        '</properties><testsuite name="s"><testcase name="t" classname="c"/></testsuite></testsuites>',
    );
    expect(collectTestReportDeclaration(worktree, GLOB, 1)).toEqual({
      allDeclared: true,
      claimedPaths: ['packages/a/x.ts', 'packages/a/y & z.ts'],
    });
  });

  it('yields no declaration for a plain empty report', () => {
    write(
      'packages/a/.test-reports/a.xml',
      '<testsuites tests="0" failures="0"></testsuites>',
    );
    expect(collectTestReportDeclaration(worktree, GLOB, 1).allDeclared).toBe(
      false,
    );
  });

  it('ignores a testcase-level property named like the declaration', () => {
    write(
      'packages/a/.test-reports/a.xml',
      '<testsuites><testsuite name="s"><testcase name="t"><properties><property name="orchestrator.declares" value="1"/></properties></testcase></testsuite></testsuites>',
    );
    expect(collectTestReportDeclaration(worktree, GLOB, 1).allDeclared).toBe(
      false,
    );
  });

  it('is not allDeclared when one of two commands did not declare or report', () => {
    write(
      'packages/a/.test-reports/a.xml',
      '<testsuites><properties><property name="orchestrator.declares" value="1"/></properties></testsuites>',
    );
    expect(collectTestReportDeclaration(worktree, GLOB, 2).allDeclared).toBe(
      false,
    );
    write('packages/b/.test-reports/b.xml', '<testsuites></testsuites>');
    expect(collectTestReportDeclaration(worktree, GLOB, 2).allDeclared).toBe(
      false,
    );
  });
});
