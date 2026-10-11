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

const { hashState } = vi.hoisted(() => ({ hashState: { current: '' } }));

vi.mock('../../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/analyzeGating')>();
  return {
    ...actual,
    computeWholeTreeContentHash: vi.fn(async () => hashState.current),
  };
});

vi.mock('../memoryAdmission', () => ({
  hasTestRequestAdmission: vi.fn(() => true),
}));

vi.mock('../testSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../testSnapshot')>();
  return { ...actual, packTestSnapshot: vi.fn() };
});

vi.mock('../runnerJobQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runnerJobQueue')>();
  return {
    ...actual,
    enqueueRunnerJob: (input: Parameters<typeof actual.enqueueRunnerJob>[0]) =>
      actual.enqueueRunnerJob(input, 400),
  };
});

import { db } from '../../db/db';
import { insertProject } from '../../db/queries';
import {
  runProjectTestRequest,
  setTestRequestRunnerExecutor,
  __resetProjectSemaphoresForTest,
} from '../testRequestLane';
import { runTestCommands } from '../../session/test-runner';
import { createLaneRunnerExecutor } from '../laneRunnerExecutor';
import { packTestSnapshot, SnapshotTooLargeError } from '../testSnapshot';
import {
  claimRunnerJob,
  submitRunnerResult,
  _resetRunnerJobQueueForTests,
} from '../runnerJobQueue';

function spec(contentHash: string) {
  hashState.current = contentHash;
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
      `SELECT state, output, failure_reason FROM test_request_runs WHERE content_hash = ?`,
    )
    .get(contentHash) as Record<string, unknown>;
}

const snapshot = {
  manifest: { entries: [], totalBytes: 1 },
  archive: Buffer.from('x'),
};

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
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
  _resetRunnerJobQueueForTests();
  vi.mocked(packTestSnapshot).mockResolvedValue(snapshot as never);
  vi.mocked(runTestCommands).mockReset();
});

afterEach(() => setTestRequestRunnerExecutor(null));

describe('LaneRunnerExecutor', () => {
  it('with no executor registered, the lane runs locally', async () => {
    vi.mocked(runTestCommands).mockResolvedValue({
      passed: true,
      output: 'local ok',
    } as never);
    const res = await runProjectTestRequest(spec('local1'));
    expect(res.passed).toBe(true);
    expect(runTestCommands).toHaveBeenCalled();
    expect(packTestSnapshot).not.toHaveBeenCalled();
  });

  it('with the executor registered, the runner result is consumed', async () => {
    setTestRequestRunnerExecutor(createLaneRunnerExecutor());
    const p = runProjectTestRequest(spec('remote1'));
    let runId: string | undefined;
    await vi.waitFor(() => {
      const r = db
        .prepare(`SELECT id FROM test_request_runs WHERE content_hash = ?`)
        .get('remote1') as { id: string } | undefined;
      runId = r?.id;
      expect(claimRunnerJob(runId ?? '', 'dev1')).toBeTruthy();
    });
    submitRunnerResult(runId!, 'dev1', {
      passed: true,
      output: 'remote ok',
      commandResults: [{ command: 'npm test', passed: true }],
      oomKilled: false,
      startedAt: 1,
      finishedAt: 2,
      runnerConcurrentRunCount: 1,
      structuredResult: null,
    } as never);
    const res = await p;
    expect(res.passed).toBe(true);
    expect(row('remote1').output).toBe('remote ok');
    expect(runTestCommands).not.toHaveBeenCalled();
  });

  it('a runner that never returns settles failed/runner_unreachable', async () => {
    setTestRequestRunnerExecutor(createLaneRunnerExecutor());
    const res = await runProjectTestRequest(spec('silent1'));
    expect(res.passed).toBe(false);
    const r = row('silent1');
    expect(r.state).toBe('failed');
    expect(r.failure_reason).toBe('runner_unreachable');
  });

  it('an oversized snapshot settles runner_unreachable', async () => {
    vi.mocked(packTestSnapshot).mockRejectedValue(
      new SnapshotTooLargeError(10, 5, []),
    );
    setTestRequestRunnerExecutor(createLaneRunnerExecutor());
    await runProjectTestRequest(spec('big1'));
    expect(row('big1').failure_reason).toBe('runner_unreachable');
  });
});

const PRODUCERS = [
  {
    name: 'session_request',
    producer: 'session_request' as const,
    runOrigin: null,
    runKind: undefined,
  },
  {
    name: 'pr_gate-tests',
    producer: 'pr_gate' as const,
    runOrigin: 'pr_pipeline' as const,
    runKind: undefined,
  },
  {
    name: 'pr_gate-verify',
    producer: 'pr_gate' as const,
    runOrigin: 'pr_pipeline' as const,
    runKind: 'verify' as const,
  },
  {
    name: 'base_health',
    producer: 'base_health' as const,
    runOrigin: 'base_health_probe' as const,
    runKind: 'verify' as const,
  },
];

describe.each(PRODUCERS)(
  'producer routing: $name',
  ({ name, producer, runOrigin, runKind }) => {
    const hash = `route-${name}`;
    const producerSpec = () => ({
      ...spec(hash),
      producer,
      runOrigin,
      ...(runKind ? { runKind } : {}),
    });

    it('is executed by the remote executor when one is configured', async () => {
      setTestRequestRunnerExecutor(createLaneRunnerExecutor());
      const p = runProjectTestRequest(producerSpec());
      let runId: string | undefined;
      await vi.waitFor(() => {
        const r = db
          .prepare(
            `SELECT id, producer FROM test_request_runs WHERE content_hash = ?`,
          )
          .get(hash) as { id: string; producer: string } | undefined;
        runId = r?.id;
        expect(r?.producer).toBe(producer);
        expect(claimRunnerJob(runId ?? '', 'dev1')).toBeTruthy();
      });
      submitRunnerResult(runId!, 'dev1', {
        passed: true,
        output: 'remote ok',
        commandResults: [{ command: 'npm test', passed: true }],
        oomKilled: false,
        startedAt: 1,
        finishedAt: 2,
        runnerConcurrentRunCount: 1,
        structuredResult: null,
      } as never);
      const res = await p;
      expect(res.passed).toBe(true);
      expect(row(hash).output).toBe('remote ok');
      expect(runTestCommands).not.toHaveBeenCalled();
    });

    it('runs locally with identical results when no remote executor is configured', async () => {
      vi.mocked(runTestCommands).mockResolvedValue({
        passed: true,
        output: 'local ok',
      } as never);
      const res = await runProjectTestRequest(producerSpec());
      expect(res.passed).toBe(true);
      expect(row(hash).state).toBe('passed');
      expect(runTestCommands).toHaveBeenCalled();
      expect(packTestSnapshot).not.toHaveBeenCalled();
    });
  },
);
