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

const { mockRecordAndMaybeFileBaseHealthRemediation } = vi.hoisted(() => ({
  mockRecordAndMaybeFileBaseHealthRemediation: vi.fn(async () => ({
    filed: false,
  })),
}));

vi.mock('../../audit/baseHealthRemediationFiling.js', () => ({
  recordAndMaybeFileBaseHealthRemediation:
    mockRecordAndMaybeFileBaseHealthRemediation,
}));

import { db } from '../../db/db';
import {
  checkBaseBranchHealth,
  getBaseHealthWorktreePath,
} from '../baseHealthCheck';
import { filterBaseAttributableFailures } from '../baseAttributableFilter';
import { getAuditWorktreePath } from '../ScheduledAuditSweep';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  insertTestRunResults,
} from '../../db/queries';
import type { ProjectConfig } from '../../config';
import type { TestRequestRunRow } from '../../db/types';

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
  mockRecordAndMaybeFileBaseHealthRemediation.mockReset();
  mockRecordAndMaybeFileBaseHealthRemediation.mockResolvedValue({
    filed: false,
  });
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_run_results').run();
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

  it('does not treat another session\'s own test_request_runs row for the same content hash as a cached base-health confirmation', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-foreign-session');

    // A dispatched task session's own ordinary test.request retry — its
    // worktree happens to be content-hash-identical to the base branch —
    // lands in the same (project_id, content_hash) bucket. This row must
    // never be read back as baseHealthCheck.ts's own confirmation.
    insertTestRequestRun(
      'run-foreign-session',
      project.id,
      'hash-foreign-session',
      'some-task-session-id',
      Date.now(),
    );
    completeTestRequestRun(
      'run-foreign-session',
      'failed',
      'unrelated flaky failure',
      'generic',
      structuredResultWith(10, 1),
      false,
    );

    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-own',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun('run-own', 'passed', '');
      return { runId: 'run-own', joined: false, passed: true, output: '' };
    });

    const result = await checkBaseBranchHealth(project);
    // Must run its own dedicated check rather than reusing the foreign
    // session's row — a cache hit here would misreport that session's
    // flaky failure as a confirmed base-branch break.
    expect(mockRunProjectTestRequest).toHaveBeenCalledTimes(1);
    expect(result.cacheHit).toBe(false);
    expect(result.outcome).toBe('clean_pass');
    expect(result.run?.id).toBe('run-own');
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

  it('classifies a failed run whose acquisition was never attempted as partial_fail, not total_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-unattempted');
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-unattempted',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      // No test_report_glob configured — structured_result stays null, but
      // that null must not be read as a total_fail crash signal.
      completeTestRequestRun(
        'run-unattempted',
        'failed',
        'some tests failed',
        'generic',
        null,
        false,
        false,
      );
      return {
        runId: 'run-unattempted',
        joined: false,
        passed: false,
        output: 'some tests failed',
      };
    });

    const result = await checkBaseBranchHealth(project);
    expect(result.outcome).toBe('partial_fail');
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
      return {
        runId: 'run-concurrent',
        joined: false,
        passed: true,
        output: '',
      };
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

  it('reproduces the reported repeat-filing scenario: two flaky test_request_runs rows from another session, same content hash, disjoint failing tests, must not each independently trigger remediation filing', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-flaky-session');

    // Two of a task session's own ordinary test.request retries against a
    // worktree that happens to be content-hash-identical to the base
    // branch — same (project_id, content_hash), different session_id, each
    // with a disjoint set of failing tests (the reported flaky-retry
    // scenario). Neither must ever be read back as a base-health verdict.
    insertTestRequestRun(
      'run-flaky-1',
      project.id,
      'hash-flaky-session',
      'flaky-task-session-1',
      Date.now(),
    );
    completeTestRequestRun(
      'run-flaky-1',
      'failed',
      'some tests failed',
      'generic',
      JSON.stringify({
        format: 'junit-xml',
        suites: [],
        totals: { passed: 9, failed: 1, skipped: 0, errors: 0 },
        durationMsTotal: 1000,
      }),
      false,
    );
    insertTestRunResults(
      'run-flaky-1',
      project.id,
      [
        {
          test_id: 'suite.flakyA',
          name: 'flakyA',
          outcome: 'failed',
          duration_ms: 10,
        },
      ],
      null,
      false,
    );

    insertTestRequestRun(
      'run-flaky-2',
      project.id,
      'hash-flaky-session',
      'flaky-task-session-2',
      Date.now() + 1000,
    );
    completeTestRequestRun(
      'run-flaky-2',
      'failed',
      'some tests failed',
      'generic',
      JSON.stringify({
        format: 'junit-xml',
        suites: [],
        totals: { passed: 9, failed: 1, skipped: 0, errors: 0 },
        durationMsTotal: 1000,
      }),
      false,
    );
    insertTestRunResults(
      'run-flaky-2',
      project.id,
      [
        {
          test_id: 'suite.flakyB',
          name: 'flakyB',
          outcome: 'failed',
          duration_ms: 10,
        },
      ],
      null,
      false,
    );

    // baseHealthCheck.ts's own dedicated run for this content hash passes
    // cleanly — the base branch is actually healthy; the two rows above are
    // just an unrelated session's own flaky retries.
    mockRunProjectTestRequest.mockImplementation(async (spec) => {
      insertTestRequestRun(
        'run-own-dedicated',
        spec.projectId,
        spec.contentHash,
        null,
        Date.now(),
      );
      completeTestRequestRun('run-own-dedicated', 'passed', '');
      return {
        runId: 'run-own-dedicated',
        joined: false,
        passed: true,
        output: '',
      };
    });

    const sessionRun = (id: string): TestRequestRunRow => ({
      id,
      project_id: project.id,
      content_hash: 'hash-flaky-session',
      session_id: 'unrelated-session',
      state: 'failed',
      output: '',
      requested_at: null,
      started_at: 0,
      finished_at: null,
      structured_result: null,
      failure_reason: null,
      concurrent_run_count: null,
      oom_killed: 0,
    });

    // Simulate two of that same session's sequential test-request results
    // being routed through filterBaseAttributableFailures, each of which
    // internally calls checkBaseBranchHealth.
    await filterBaseAttributableFailures(
      project,
      sessionRun('run-flaky-1'),
      'triggering-task-1',
    );
    await filterBaseAttributableFailures(
      project,
      sessionRun('run-flaky-2'),
      'triggering-task-1',
    );

    // Since checkBaseBranchHealth's own cache read (session_id IS NULL)
    // never picks up either flaky-session row, both calls resolve to the
    // real clean_pass outcome and neither ever triggers remediation filing.
    expect(mockRecordAndMaybeFileBaseHealthRemediation).not.toHaveBeenCalled();
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
