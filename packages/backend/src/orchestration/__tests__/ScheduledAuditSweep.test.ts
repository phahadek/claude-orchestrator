/**
 * Tests for ScheduledAuditSweep.
 *
 * Verifies:
 * - Worktree provisioning and command execution never target the shared
 *   projectDir path directly — only a nested `.claude/worktrees/scheduled-audit/<id>`
 *   path is ever used for checkout/reset/clean and analyze-command invocations.
 * - The dep-bump task body template renders package name, current/fixed
 *   version, and advisory link for a parsed vulnerability finding.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

vi.mock('../../db/queries.js', () => ({
  getAuditFindingDedup: vi.fn(() => null),
  upsertAuditFindingDedup: vi.fn(),
}));

vi.mock('../../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

import {
  getAuditWorktreePath,
  ensureAuditWorktree,
  runAuditSweepForProject,
  parseAuditOutput,
  parseLicenseCheckerFindings,
  renderDepBumpTaskBody,
  findingIdentity,
  type AuditSweepDeps,
  type DependencyVulnerabilityFinding,
} from '../ScheduledAuditSweep.js';
import { getTaskBackend } from '../../tasks/TaskBackend.js';
import type { ProjectConfig } from '../../config.js';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const projectDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'scheduled-audit-sweep-test-'),
  );
  return {
    id: 'proj-1',
    name: 'Project One',
    projectDir,
    contextUrl: 'https://example.com',
    boardId: 'board-1',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    dataResidencyConfirmed: true,
    baseBranch: 'dev',
    nonMilestoneSourceConfig: { notionDatabaseId: 'db-nonmilestone' },
    ...overrides,
  };
}

describe('getAuditWorktreePath', () => {
  it('is nested at least one segment deeper than .claude/worktrees, never projectDir', () => {
    const project = makeProject();
    const wt = getAuditWorktreePath(project);
    expect(wt).not.toBe(project.projectDir);
    const worktreesRoot = path.join(project.projectDir, '.claude', 'worktrees');
    expect(wt.startsWith(worktreesRoot + path.sep)).toBe(true);
    // Not a direct child of .claude/worktrees/ — WorktreeReconciler only
    // force-removes an exact worktreesDir/<name> match.
    expect(path.dirname(wt)).not.toBe(worktreesRoot);
  });
});

describe('worktree provisioning and command execution isolation', () => {
  it('never runs a git checkout/reset/clean command or an analyze command with cwd=projectDir', async () => {
    const project = makeProject();
    const worktreePath = getAuditWorktreePath(project);
    const gitCwds: string[] = [];
    const analyzeCwds: string[] = [];

    const gitRunner = vi.fn(async (args: string[], cwd: string) => {
      gitCwds.push(cwd);
      // Simulate: worktree already exists, so ensureAuditWorktree takes the
      // reset/clean path (not the `worktree add` bootstrap path).
      return { stdout: '', stderr: '' };
    });

    // Force the "already exists" branch inside ensureAuditWorktree by
    // stubbing fs.promises.access via a real accessible path is awkward in
    // a unit test — instead call ensureAuditWorktree directly against a
    // scenario where the directory genuinely doesn't exist (CI tmp), which
    // exercises the `worktree add` bootstrap path (cwd=projectDir is
    // expected there — it's the git-worktree mechanism operating from the
    // main repo, not a "checkout" or "audit-command invocation"). We assert
    // that *no* call ever uses worktreePath's parent-most ancestor
    // (projectDir) as cwd for anything other than that one bootstrap call.
    await ensureAuditWorktree(project, worktreePath, gitRunner);

    const nonBootstrapGitCwds = gitCwds.filter((_, i) => {
      const call = gitRunner.mock.calls[i][0] as string[];
      return !(
        call[0] === 'fetch' ||
        (call[0] === 'worktree' && call[1] === 'add')
      );
    });
    for (const cwd of nonBootstrapGitCwds) {
      expect(cwd).not.toBe(project.projectDir);
      expect(cwd).toBe(worktreePath);
    }

    // Now materialize a real worktree dir with a config declaring analyze
    // commands, so runAuditSweepForProject takes the "already exists"
    // reset/clean path and actually invokes the analyze command list —
    // proving every analyze-command cwd is the nested worktree path, never
    // projectDir.
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(
      path.join(worktreePath, '.claude-orchestrator.yml'),
      'scheduled_audit:\n  - "npm audit --json"\n',
    );

    const analyzeDeps: AuditSweepDeps = {
      listProjects: () => [project],
      gitRunner: async (args, cwd) => {
        gitCwds.push(cwd);
        return { stdout: '', stderr: '' };
      },
      runAnalyzeCommand: async (cwd) => {
        analyzeCwds.push(cwd);
        return { passed: true, output: '{}' };
      },
      retryCap: 2,
      bootstrapInstall: async () => {},
    };

    (getTaskBackend as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      type: 'notion',
      createTask: vi.fn(),
      fetchTaskSummary: vi.fn(),
    });

    await runAuditSweepForProject(project, analyzeDeps);

    expect(analyzeCwds.length).toBeGreaterThan(0);
    for (const cwd of analyzeCwds) {
      expect(cwd).not.toBe(project.projectDir);
      expect(cwd).toBe(worktreePath);
    }

    fs.rmSync(project.projectDir, { recursive: true, force: true });
  });
});

describe('renderDepBumpTaskBody', () => {
  it('renders package name, current/fixed version, and advisory link for a vulnerability finding', () => {
    const finding: DependencyVulnerabilityFinding = {
      kind: 'vulnerability',
      advisoryId: '1234567',
      packageName: 'left-pad',
      currentRange: '<1.3.0',
      fixedVersion: '1.3.0',
      severity: 'high',
      advisoryUrl: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
    };

    const body = renderDepBumpTaskBody(finding);

    expect(body).toContain('left-pad');
    expect(body).toContain('<1.3.0');
    expect(body).toContain('1.3.0');
    expect(body).toContain('https://github.com/advisories/GHSA-xxxx-yyyy-zzzz');
  });

  it('renders package, version, and license for a license finding', () => {
    const body = renderDepBumpTaskBody({
      kind: 'license',
      packageName: 'some-gpl-pkg',
      version: '2.0.0',
      license: 'GPL-3.0',
    });

    expect(body).toContain('some-gpl-pkg');
    expect(body).toContain('2.0.0');
    expect(body).toContain('GPL-3.0');
  });
});

const parseAuditFindings = (output: string, disallowed: string[] = []) =>
  parseAuditOutput(output, disallowed).findings;

describe('sweep reads scheduled_audit, not analyze', () => {
  const advisoryReport = JSON.stringify({
    vulnerabilities: {
      'left-pad': {
        name: 'left-pad',
        severity: 'high',
        range: '<1.3.0',
        fixAvailable: { name: 'left-pad', version: '1.3.0' },
        via: [{ source: 1234567, url: 'https://x/GHSA', severity: 'high' }],
      },
    },
  });

  function setup(output: string, yml: string) {
    const project = makeProject();
    const worktreePath = getAuditWorktreePath(project);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.claude-orchestrator.yml'), yml);
    const createTask = vi.fn(async () => ({ id: 'task-1' }));
    (getTaskBackend as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      type: 'notion',
      createTask,
      fetchTaskSummary: vi.fn(),
    });
    const ran: string[] = [];
    const deps: AuditSweepDeps = {
      listProjects: () => [project],
      gitRunner: async () => ({ stdout: '', stderr: '' }),
      runAnalyzeCommand: async (_cwd, command) => {
        ran.push(command);
        return { passed: true, output };
      },
      retryCap: 0,
      bootstrapInstall: async () => {},
    };
    return { project, deps, createTask, ran };
  }

  it('files a task for an advisory from scheduled_audit and never runs analyze', async () => {
    const { project, deps, createTask, ran } = setup(
      advisoryReport,
      'analyze:\n  - "npm run lint"\nscheduled_audit:\n  - "npm audit --json"\n',
    );
    const result = await runAuditSweepForProject(project, deps);
    expect(ran).toEqual(['npm audit --json']);
    expect(result.findingsSeen).toBe(1);
    expect(createTask).toHaveBeenCalledTimes(1);
    fs.rmSync(project.projectDir, { recursive: true, force: true });
  });

  it('records exactly one unparsed event for plain-text output and files nothing', async () => {
    const { recordEvent } = await import('../../audit/AuditLog.js');
    const mockRecord = recordEvent as unknown as ReturnType<typeof vi.fn>;
    mockRecord.mockClear();
    const { project, deps, createTask } = setup(
      'no json here',
      'scheduled_audit:\n  - "npm run audit:licenses"\n',
    );
    await runAuditSweepForProject(project, deps);
    const unparsed = mockRecord.mock.calls.filter(
      (c) =>
        (c[0] as { event_type: string }).event_type ===
        'scheduled_audit_sweep_command_unparsed',
    );
    expect(unparsed).toHaveLength(1);
    expect(createTask).not.toHaveBeenCalled();
    fs.rmSync(project.projectDir, { recursive: true, force: true });
  });
});

describe('parseLicenseCheckerFindings deny filter', () => {
  const report = {
    'a@1.0.0': { licenses: 'MIT' },
    'b@1.0.0': { licenses: 'GPL-3.0' },
    'c@1.0.0': { licenses: 'ISC' },
    'd@1.0.0': { licenses: 'Apache-2.0' },
    'e@1.0.0': { licenses: 'BSD-3-Clause' },
  };

  it('returns only the package matching the disallowed list', () => {
    const findings = parseLicenseCheckerFindings(report, ['gpl']);
    expect(findings.map((f) => f.packageName)).toEqual(['b']);
  });

  it('returns none for an empty list', () => {
    expect(parseLicenseCheckerFindings(report, [])).toEqual([]);
  });
});

describe('parseAuditFindings', () => {
  it('parses an npm-audit-style vulnerability report', () => {
    const output = `$ npm audit --json\n${JSON.stringify({
      vulnerabilities: {
        'left-pad': {
          name: 'left-pad',
          severity: 'high',
          range: '<1.3.0',
          fixAvailable: { name: 'left-pad', version: '1.3.0' },
          via: [
            {
              source: 1234567,
              url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
              severity: 'high',
            },
          ],
        },
      },
    })}\n`;

    const findings = parseAuditFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'vulnerability',
      advisoryId: '1234567',
      packageName: 'left-pad',
      fixedVersion: '1.3.0',
    });
    expect(findingIdentity(findings[0])).toBe('vuln:1234567');
  });

  it('parses a license-checker-style report', () => {
    const output = JSON.stringify({
      'some-gpl-pkg@2.0.0': { licenses: 'GPL-3.0' },
    });

    const findings = parseAuditFindings(output, ['GPL']);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'license',
      packageName: 'some-gpl-pkg',
      version: '2.0.0',
      license: 'GPL-3.0',
    });
  });

  it('returns no findings for output that matches neither known shape', () => {
    const output = '$ eslint .\nAll good, no errors.';
    expect(parseAuditFindings(output)).toEqual([]);
  });
});
