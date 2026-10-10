import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../session/test-runner', () => ({
  runTestCommands: vi.fn(),
  collectStructuredTestResultOffMainThread: vi.fn(() => null),
  clearReportFiles: vi.fn(),
}));

vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn(() => ({ test_report_glob: '' })),
}));

const { mockTreeHash } = vi.hoisted(() => ({ mockTreeHash: { value: '' } }));
vi.mock('../../session/analyzeGating', () => ({
  computeWholeTreeContentHash: vi.fn(async () => mockTreeHash.value),
}));

vi.mock('../memoryAdmission', () => ({
  hasTestRequestAdmission: vi.fn(() => true),
}));

import { db } from '../../db/db';
import {
  insertProject,
  insertTestRequestRun,
  completeTestRequestRun,
} from '../../db/queries';
import {
  runProjectTestRequest,
  setTestRequestRunnerExecutor,
  __resetProjectSemaphoresForTest,
} from '../testRequestLane';
import {
  sweepRunnerUnreachability,
  RUNNER_UNREACHABLE_GRACE_MS,
} from '../runnerUnreachabilityReconciler';
import type { RunnerResultPackage } from '../runnerResultPackage';

const NOW = 10_000_000_000;
const STALE = NOW - RUNNER_UNREACHABLE_GRACE_MS - 1_000;

function getRow(id: string) {
  return db
    .prepare(
      'SELECT state, failure_reason, finished_at FROM test_request_runs WHERE id = ?',
    )
    .get(id) as {
    state: string;
    failure_reason: string | null;
    finished_at: number | null;
  };
}

function seed(
  id: string,
  state: 'queued' | 'running',
  startedAt: number,
  runnerExecuted: boolean,
) {
  insertTestRequestRun(
    id,
    'proj-1',
    `hash-${id}`,
    null,
    startedAt,
    null,
    null,
    'session_request',
    state,
    'full',
    null,
    null,
    null,
    runnerExecuted,
  );
  db.prepare('UPDATE test_request_runs SET started_at = ? WHERE id = ?').run(
    startedAt,
    id,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM projects').run();
  insertProject({
    id: 'proj-1',
    name: 'P',
    project_dir: '/tmp/p',
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
  __resetProjectSemaphoresForTest();
});

afterEach(() => setTestRequestRunnerExecutor(null));

describe('sweepRunnerUnreachability', () => {
  it('settles stale queued and running runner-executed rows as runner_unreachable, leaving local rows untouched', () => {
    seed('rq', 'queued', STALE, true);
    seed('rr', 'running', STALE, true);
    seed('lq', 'queued', STALE, false);
    seed('lr', 'running', STALE, false);
    seed('fresh', 'running', NOW - 1_000, true);

    expect(sweepRunnerUnreachability(NOW)).toBe(2);

    for (const id of ['rq', 'rr']) {
      const r = getRow(id);
      expect(r.state).toBe('failed');
      expect(r.failure_reason).toBe('runner_unreachable');
      expect(r.finished_at).not.toBeNull();
    }
    expect(getRow('lq')).toMatchObject({
      state: 'queued',
      failure_reason: null,
    });
    expect(getRow('lr')).toMatchObject({
      state: 'running',
      failure_reason: null,
    });
    expect(getRow('fresh').state).toBe('running');
  });

  it('never overwrites a result that settled the row at the grace deadline', () => {
    seed('raced', 'running', STALE, true);
    completeTestRequestRun('raced', 'passed', 'genuine result');

    expect(sweepRunnerUnreachability(NOW)).toBe(0);

    expect(getRow('raced')).toMatchObject({
      state: 'passed',
      failure_reason: null,
    });
  });
});

describe('settled-run replay guard', () => {
  function seedSettledFailed(
    id: string,
    hash: string,
    reason: 'runner_unreachable' | 'generic',
  ) {
    insertTestRequestRun(id, 'proj-1', hash, null, 1000);
    completeTestRequestRun(
      id,
      'failed',
      'old',
      reason,
      JSON.stringify({
        format: 'junit-xml',
        suites: [],
        totals: { passed: 0, failed: 1, skipped: 0, errors: 0 },
        durationMsTotal: 0,
      }),
    );
  }

  const spec = (contentHash: string) => ({
    projectId: 'proj-1',
    contentHash,
    worktreePath: '/tmp/wt',
    commands: ['npm test'],
    timeoutSec: 60,
    maxRssMb: 0,
    sessionId: null,
    runOrigin: null,
    producer: 'session_request' as const,
  });

  const okPkg: RunnerResultPackage = {
    passed: true,
    output: 'fresh',
    commandResults: [{ command: 'npm test', passed: true }],
    oomKilled: false,
    startedAt: 1000,
    finishedAt: 2000,
    runnerConcurrentRunCount: 0,
    structuredResult: null,
  };

  it('does not replay a runner_unreachable run, but does replay an ordinary failed one', async () => {
    seedSettledFailed('u1', 'h-unreach', 'runner_unreachable');
    seedSettledFailed('g1', 'h-generic', 'generic');
    const executor = vi.fn(async () => okPkg);
    setTestRequestRunnerExecutor(executor);

    await runProjectTestRequest(spec('h-generic'));
    expect(executor).not.toHaveBeenCalled();

    mockTreeHash.value = 'h-unreach';
    await runProjectTestRequest(spec('h-unreach'));
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
