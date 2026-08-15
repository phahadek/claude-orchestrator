/**
 * Tests for the on-demand base-branch health check:
 * - Cache hit/miss against test_request_runs, keyed by the base tree's own
 *   content hash.
 * - The four distinguishable outcomes (clean_pass / partial_fail /
 *   total_fail / unknown).
 * - Worktree namespacing distinct from ScheduledAuditSweep's own checkout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockEnsureAuditWorktree } = vi.hoisted(() => ({
  mockEnsureAuditWorktree: vi.fn(async () => {}),
}));

vi.mock('../ScheduledAuditSweep.js', async () => {
  const actual = await vi.importActual('../ScheduledAuditSweep.js');
  return {
    ...actual,
    ensureAuditWorktree: mockEnsureAuditWorktree,
  };
});

const { mockComputeWholeTreeContentHash } = vi.hoisted(() => ({
  mockComputeWholeTreeContentHash: vi.fn(),
}));

vi.mock('../../session/analyzeGating.js', () => ({
  computeWholeTreeContentHash: mockComputeWholeTreeContentHash,
}));

const { mockLoadOrchestratorConfig } = vi.hoisted(() => ({
  mockLoadOrchestratorConfig: vi.fn(),
}));

vi.mock('../../session/orchestrator-config.js', () => ({
  loadOrchestratorConfig: mockLoadOrchestratorConfig,
}));

const { mockRunProjectTestRequest } = vi.hoisted(() => ({
  mockRunProjectTestRequest: vi.fn(),
}));

vi.mock('../testRequestLane.js', () => ({
  runProjectTestRequest: mockRunProjectTestRequest,
}));

import { db } from '../../db/db';
import {
  checkBaseBranchHealth,
  getBaseHealthWorktreePath,
} from '../baseHealthCheck';
import { getAuditWorktreePath } from '../ScheduledAuditSweep';
import { insertTestRequestRun, completeTestRequestRun } from '../../db/queries';
import type { ProjectConfig } from '../../config';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Project One',
    projectDir: '/tmp/fake-project-dir',
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
  } as ProjectConfig;
}

const DEFAULT_CONFIG = {
  verify: [],
  autofix: [],
  analyze: [],
  ci_check_name: [],
  allowed_tools: [],
  bash_rules: [],
  bootstrap_script: '',
  test: ['npm test'],
  test_timeout_sec: 60,
  test_max_rss_mb: 0,
  test_fail_fast: true,
  test_report_glob: '',
};

function structuredResultWith(passed: number, failed: number): string {
  return JSON.stringify({
    format: 'junit-xml',
    suites: [],
    totals: { passed, failed, skipped: 0, errors: 0 },
    durationMsTotal: 1000,
  });
}

beforeEach(() => {
  mockEnsureAuditWorktree.mockReset();
  mockEnsureAuditWorktree.mockResolvedValue(undefined);
  mockComputeWholeTreeContentHash.mockReset();
  mockLoadOrchestratorConfig.mockReset();
  mockLoadOrchestratorConfig.mockReturnValue(DEFAULT_CONFIG);
  mockRunProjectTestRequest.mockReset();
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('checkBaseBranchHealth', () => {
  it('reuses the cached test_request_runs row on a second check against an unchanged content hash', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-unchanged');
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-1',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun('run-1', 'passed', '');
      return { runId: 'run-1', joined: false, passed: true, output: '' };
    });

    const first = await checkBaseBranchHealth(project);
    expect(first.outcome).toBe('clean_pass');
    expect(first.cacheHit).toBe(false);
    expect(mockRunProjectTestRequest).toHaveBeenCalledTimes(1);

    const second = await checkBaseBranchHealth(project);
    expect(second.outcome).toBe('clean_pass');
    expect(second.cacheHit).toBe(true);
    expect(second.run?.id).toBe('run-1');
    // No second execution — the cached row was reused.
    expect(mockRunProjectTestRequest).toHaveBeenCalledTimes(1);
  });

  it('triggers a fresh run once the base tree content hash changes', async () => {
    const project = makeProject();
    let runSeq = 0;
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      const runId = `run-${++runSeq}`;
      insertTestRequestRun(
        runId,
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun(runId, 'passed', '');
      return { runId, joined: false, passed: true, output: '' };
    });

    mockComputeWholeTreeContentHash.mockResolvedValue('hash-a');
    await checkBaseBranchHealth(project);
    expect(mockRunProjectTestRequest).toHaveBeenCalledTimes(1);

    mockComputeWholeTreeContentHash.mockResolvedValue('hash-b');
    const result = await checkBaseBranchHealth(project);
    expect(result.cacheHit).toBe(false);
    expect(mockRunProjectTestRequest).toHaveBeenCalledTimes(2);
  });

  it('classifies a passing base tree as clean_pass', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-clean');
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-clean',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun('run-clean', 'passed', '');
      return { runId: 'run-clean', joined: false, passed: true, output: '' };
    });

    const result = await checkBaseBranchHealth(project);
    expect(result.outcome).toBe('clean_pass');
  });

  it('classifies a failed run with a per-test breakdown as partial_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-partial');
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-partial',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun(
        'run-partial',
        'failed',
        'some tests failed',
        'generic',
        structuredResultWith(18, 2),
        false,
      );
      return {
        runId: 'run-partial',
        joined: false,
        passed: false,
        output: 'some tests failed',
      };
    });

    const result = await checkBaseBranchHealth(project);
    expect(result.outcome).toBe('partial_fail');
  });

  it('classifies a failed run with no per-test breakdown (e.g. OOM-kill) as total_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-total');
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-total',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun(
        'run-total',
        'failed',
        'killed',
        'oom_killed',
        null,
        true,
      );
      return {
        runId: 'run-total',
        joined: false,
        passed: false,
        output: 'killed',
      };
    });

    const result = await checkBaseBranchHealth(project);
    expect(result.outcome).toBe('total_fail');
  });

  it('returns unknown, distinct from total_fail, when worktree provisioning fails', async () => {
    const project = makeProject();
    mockEnsureAuditWorktree.mockRejectedValue(
      new Error('git worktree add failed'),
    );

    const result = await checkBaseBranchHealth(project);
    expect(result.outcome).toBe('unknown');
    expect(result.run).toBeNull();
    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
  });

  it('returns unknown when the content hash cannot be computed (empty tree)', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue(null);

    const result = await checkBaseBranchHealth(project);
    expect(result.outcome).toBe('unknown');
    expect(mockRunProjectTestRequest).not.toHaveBeenCalled();
  });

  it('returns unknown when the run produces no durable row', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-missing-row');
    mockRunProjectTestRequest.mockResolvedValue({
      runId: 'run-that-was-never-inserted',
      joined: false,
      passed: false,
      output: '',
    });

    const result = await checkBaseBranchHealth(project);
    expect(result.outcome).toBe('unknown');
  });

  it('serializes concurrent calls for the same project so worktree provisioning never overlaps', async () => {
    const project = makeProject();
    let concurrentCount = 0;
    let maxConcurrentSeen = 0;
    mockEnsureAuditWorktree.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrentCount--;
    });
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-concurrent');
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-concurrent',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun('run-concurrent', 'passed', '');
      return { runId: 'run-concurrent', joined: false, passed: true, output: '' };
    });

    const [first, second] = await Promise.all([
      checkBaseBranchHealth(project),
      checkBaseBranchHealth(project),
    ]);

    expect(maxConcurrentSeen).toBe(1);
    expect(first.outcome).toBe('clean_pass');
    expect(second.outcome).toBe('clean_pass');
    // The second call, serialized behind the first, resolves as a cache hit.
    expect([first.cacheHit, second.cacheHit].sort()).toEqual([false, true]);
  });
});

describe('getBaseHealthWorktreePath', () => {
  it("is namespaced outside ScheduledAuditSweep's own worktree and outside a bare worktreesDir/<sessionId> path", () => {
    const project = makeProject();
    const healthPath = getBaseHealthWorktreePath(project);
    const auditPath = getAuditWorktreePath(project);

    expect(healthPath).not.toBe(auditPath);

    const worktreesDir = path.join(project.projectDir, '.claude', 'worktrees');
    // Mirrors ScheduledAuditSweep's own namespacing: nested at least one
    // segment deeper than `worktreesDir/<name>` so WorktreeReconciler's
    // exact `worktreesDir/<sessionId>` match can never hit it.
    const relative = path.relative(worktreesDir, healthPath);
    expect(relative.split(path.sep).length).toBeGreaterThan(1);
    expect(healthPath.startsWith(path.join(worktreesDir, 'base-health'))).toBe(
      true,
    );
  });
});
