/**
 * The test.request lane's own concerns, independent of the staged-intent
 * auto-grant wiring: coalescing two concurrent requests for the same
 * (project, content-hash) into one execution, and crash-recovery marking a
 * leftover `running` row as `failed` at boot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockRunTestCommands } = vi.hoisted(() => ({
  mockRunTestCommands: vi.fn(),
}));

vi.mock('../../session/test-runner', () => ({
  runTestCommands: mockRunTestCommands,
}));

// Host memory headroom is real-machine-dependent and irrelevant to what this
// suite tests (coalescing + crash recovery) — always admit.
vi.mock('../memoryAdmission', () => ({
  hasTestRequestAdmission: () => true,
}));

import { db } from '../../db/db';
import {
  runProjectTestRequest,
  recoverInterruptedTestRequestRuns,
} from '../testRequestLane';
import { insertTestRequestRun, listRunningTestRequestRuns } from '../../db/queries';

beforeEach(() => {
  mockRunTestCommands.mockReset();
  db.prepare('DELETE FROM test_request_runs').run();
});

function baseSpec(overrides: Partial<Parameters<typeof runProjectTestRequest>[0]> = {}) {
  return {
    projectId: 'proj-1',
    contentHash: 'hash-a',
    worktreePath: '/tmp/wt',
    commands: ['npm test'],
    timeoutSec: 60,
    maxRssMb: 0,
    failFast: true,
    ...overrides,
  };
}

describe('runProjectTestRequest — coalescing', () => {
  it('two concurrent requests for the same (project, content-hash) share one execution', async () => {
    let resolveRun: (v: { passed: boolean; output: string }) => void;
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const spec = baseSpec();
    const p1 = runProjectTestRequest(spec);
    const p2 = runProjectTestRequest(spec);

    await vi.waitFor(() => expect(mockRunTestCommands).toHaveBeenCalled());
    resolveRun!({ passed: true, output: 'ok' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
    expect(r1.passed).toBe(true);
  });

  it('a different content-hash starts an independent execution', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-a' }));
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-b' }));

    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
  });

  it('records a completed run in test_request_runs', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'boom' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-c' }));

    const row = db
      .prepare(
        `SELECT state, output FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
      )
      .get('proj-1', 'hash-c') as { state: string; output: string };
    expect(row.state).toBe('failed');
    expect(row.output).toBe('boom');
  });
});

describe('recoverInterruptedTestRequestRuns', () => {
  it('marks a leftover running row as failed', () => {
    insertTestRequestRun('run-1', 'proj-1', 'hash-x');
    expect(listRunningTestRequestRuns()).toHaveLength(1);

    recoverInterruptedTestRequestRuns();

    expect(listRunningTestRequestRuns()).toHaveLength(0);
    const row = db
      .prepare(`SELECT state FROM test_request_runs WHERE id = ?`)
      .get('run-1') as { state: string };
    expect(row.state).toBe('failed');
  });
});
