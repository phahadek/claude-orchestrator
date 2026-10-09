/**
 * executeTestRequestRun consumes a RunnerResultPackage from an injectable
 * executor and records it exactly as the local path would.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockLoadOrchestratorConfig } = vi.hoisted(() => ({
  mockLoadOrchestratorConfig: vi.fn(() => ({ test_report_glob: '' })),
}));

vi.mock('../../session/test-runner', () => ({
  runTestCommands: vi.fn(),
  collectStructuredTestResultOffMainThread: vi.fn(() => null),
  clearReportFiles: vi.fn(),
}));

vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: mockLoadOrchestratorConfig,
}));

vi.mock('../memoryAdmission', () => ({
  hasTestRequestAdmission: vi.fn(() => true),
}));

import { db } from '../../db/db';
import {
  runProjectTestRequest,
  setTestRequestRunnerExecutor,
  getRunIngestionPromise,
  __resetProjectSemaphoresForTest,
} from '../testRequestLane';
import { validateRunnerResultPackage } from '../runnerResultPackage';
import type { RunnerResultPackage } from '../runnerResultPackage';
import type { StructuredTestResult } from '../../db/types';

const structured: StructuredTestResult = {
  format: 'junit-xml',
  suites: [
    {
      name: 's',
      tests: [
        { id: 't::a', name: 'a', outcome: 'passed', durationMs: 5 },
        {
          id: 't::b',
          name: 'b',
          outcome: 'failed',
          durationMs: 7,
          failureMessage: 'nope',
        },
      ],
    },
  ],
  totals: { passed: 1, failed: 1, skipped: 0, errors: 0 },
  durationMsTotal: 12,
};

function pkg(over: Partial<RunnerResultPackage> = {}): RunnerResultPackage {
  return {
    passed: false,
    output: 'runner output',
    commandResults: [{ command: 'npm test', passed: false }],
    failedCommand: 'npm test',
    oomKilled: false,
    startedAt: 1000,
    finishedAt: 2000,
    runnerConcurrentRunCount: 3,
    structuredResult: structured,
    ...over,
  };
}

function spec(contentHash: string) {
  return {
    projectId: 'proj-1',
    contentHash,
    worktreePath: '/tmp/wt',
    commands: ['npm test'],
    timeoutSec: 60,
    maxRssMb: 0,
    sessionId: null,
    runOrigin: null,
    producer: 'session_request' as const,
  };
}

function row(contentHash: string) {
  return db
    .prepare(
      `SELECT state, output, failed_command, concurrent_run_count, oom_killed, structured_result, test_report_acquisition_attempted FROM test_request_runs WHERE content_hash = ?`,
    )
    .get(contentHash) as Record<string, unknown>;
}

beforeEach(() => {
  mockLoadOrchestratorConfig.mockReturnValue({ test_report_glob: 'r/*.xml' });
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir) VALUES ('proj-1','p','/tmp/p')`,
  ).run();
  __resetProjectSemaphoresForTest();
});

afterEach(() => setTestRequestRunnerExecutor(null));

describe('executeTestRequestRun with a runner result package', () => {
  it('populates test_request_runs and test_run_results from the package', async () => {
    setTestRequestRunnerExecutor(async () => pkg());
    const res = await runProjectTestRequest(spec('h1'));
    expect(res.passed).toBe(false);
    const r = row('h1');
    expect(r.state).toBe('failed');
    expect(r.output).toBe('runner output');
    expect(r.failed_command).toBe('npm test');
    // The runner's own snapshot, not the admission-side semaphore's 0.
    expect(r.concurrent_run_count).toBe(3);
    expect(r.structured_result).toBe(JSON.stringify(structured));
    expect(r.test_report_acquisition_attempted).toBe(1);
    await getRunIngestionPromise(res.runId);
    const rows = db
      .prepare(
        `SELECT test_id, outcome, concurrent_run_count FROM test_run_results WHERE test_request_run_id = ? ORDER BY test_id`,
      )
      .all(res.runId) as Array<Record<string, unknown>>;
    expect(rows.map((x) => [x.test_id, x.outcome, x.concurrent_run_count])).toEqual([
      ['t::a', 'passed', 3],
      ['t::b', 'failed', 3],
    ]);
  });

  it('records a null structuredResult (acquisition failed / no report) without results rows', async () => {
    setTestRequestRunnerExecutor(async () =>
      pkg({ structuredResult: null, runnerConcurrentRunCount: 0 }),
    );
    const res = await runProjectTestRequest(spec('h2'));
    const r = row('h2');
    expect(r.state).toBe('failed');
    expect(r.structured_result).toBeNull();
    expect(r.concurrent_run_count).toBe(0);
    await getRunIngestionPromise(res.runId);
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM test_run_results WHERE test_request_run_id = ?`,
      )
      .get(res.runId) as { n: number };
    expect(n.n).toBe(0);
  });

  it('settles a malformed package as a failed run', async () => {
    setTestRequestRunnerExecutor(
      async () => ({ passed: true }) as unknown as RunnerResultPackage,
    );
    const res = await runProjectTestRequest(spec('h3'));
    expect(res.passed).toBe(false);
    expect(row('h3').state).toBe('failed');
    expect(String(row('h3').output)).toContain('invalid runner result package');
  });
});

describe('validateRunnerResultPackage', () => {
  it('accepts a well-formed package and rejects a bad one', () => {
    expect(validateRunnerResultPackage(pkg())).toEqual([]);
    expect(
      validateRunnerResultPackage(pkg({ runnerConcurrentRunCount: -1 })).length,
    ).toBeGreaterThan(0);
    expect(validateRunnerResultPackage(null).length).toBeGreaterThan(0);
  });
});
