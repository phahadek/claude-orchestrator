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

const { mockRunTestCommands, mockHasAdmission } = vi.hoisted(() => ({
  mockRunTestCommands: vi.fn(),
  mockHasAdmission: vi.fn(() => true),
}));

vi.mock('../../session/test-runner', () => ({
  runTestCommands: mockRunTestCommands,
}));

// Host memory headroom is real-machine-dependent and irrelevant to most of
// this suite (coalescing + crash recovery) — defaults to always-admit, but
// individual tests can override mockHasAdmission to exercise the wait loop.
vi.mock('../memoryAdmission', () => ({
  hasTestRequestAdmission: mockHasAdmission,
}));

import { db } from '../../db/db';
import {
  runProjectTestRequest,
  recoverInterruptedTestRequestRuns,
} from '../testRequestLane';
import {
  insertTestRequestRun,
  listRunningTestRequestRuns,
} from '../../db/queries';

beforeEach(() => {
  mockRunTestCommands.mockReset();
  mockHasAdmission.mockReset();
  mockHasAdmission.mockReturnValue(true);
  db.prepare('DELETE FROM test_request_runs').run();
});

function baseSpec(
  overrides: Partial<Parameters<typeof runProjectTestRequest>[0]> = {},
) {
  return {
    projectId: 'proj-1',
    contentHash: 'hash-a',
    worktreePath: '/tmp/wt',
    commands: ['npm test'],
    timeoutSec: 60,
    maxRssMb: 0,
    failFast: true,
    sessionId: null,
    ...overrides,
  };
}

describe('runProjectTestRequest — coalescing', () => {
  it('two concurrent requests for the same (project, content-hash) share one execution; the joiner reports joined=true and the shared runId', async () => {
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
    expect(r1.passed).toBe(true);
    expect(r1.joined).toBe(false);
    expect(r2.joined).toBe(true);
    expect(r2.runId).toBe(r1.runId);
  });

  it('a different content-hash starts an independent execution', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-a' }));
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-b' }));

    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
  });

  it('records a completed run in test_request_runs, linked to the originating session', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'boom' });

    await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-c', sessionId: 'session-1' }),
    );

    const row = db
      .prepare(
        `SELECT state, output, session_id, failure_reason FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
      )
      .get('proj-1', 'hash-c') as {
      state: string;
      output: string;
      session_id: string | null;
      failure_reason: string | null;
    };
    expect(row.state).toBe('failed');
    expect(row.output).toBe('boom');
    expect(row.session_id).toBe('session-1');
    expect(row.failure_reason).toBe('generic');
  });

  it('captures requested_at before the admission wait resolves, not after', async () => {
    vi.useFakeTimers();
    try {
      // First admission check fails, forcing waitForMemoryAdmission's poll
      // loop to sleep once before granting — requested_at must reflect the
      // moment of the call, not the moment admission was eventually granted.
      mockHasAdmission.mockReturnValueOnce(false).mockReturnValue(true);
      mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

      const before = Date.now();
      const run = runProjectTestRequest(baseSpec({ contentHash: 'hash-d' }));

      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      const row = db
        .prepare(
          `SELECT requested_at, started_at FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
        )
        .get('proj-1', 'hash-d') as {
        requested_at: number;
        started_at: number;
      };
      expect(row.requested_at).toBe(before);
      expect(row.started_at).toBeGreaterThan(row.requested_at);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes timeout, oom-kill, and generic failure sub-reasons', async () => {
    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'timed out',
      timedOut: true,
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-timeout' }));

    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'oom',
      oomKilled: true,
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-oom' }));

    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'nonzero exit',
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-generic' }));

    const reasonFor = (contentHash: string) =>
      (
        db
          .prepare(
            `SELECT failure_reason FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
          )
          .get('proj-1', contentHash) as { failure_reason: string }
      ).failure_reason;

    expect(reasonFor('hash-timeout')).toBe('timeout');
    expect(reasonFor('hash-oom')).toBe('oom_killed');
    expect(reasonFor('hash-generic')).toBe('generic');
  });
});

describe('recoverInterruptedTestRequestRuns', () => {
  it('marks a leftover running row as failed', () => {
    insertTestRequestRun('run-1', 'proj-1', 'hash-x', null, Date.now());
    expect(listRunningTestRequestRuns()).toHaveLength(1);

    recoverInterruptedTestRequestRuns();

    expect(listRunningTestRequestRuns()).toHaveLength(0);
    const row = db
      .prepare(`SELECT state FROM test_request_runs WHERE id = ?`)
      .get('run-1') as { state: string };
    expect(row.state).toBe('failed');
  });
});
