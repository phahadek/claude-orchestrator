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
  collectStructuredTestResultOffMainThread: vi.fn(() => null),
  clearReportFiles: vi.fn(),
}));

vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn(() => ({ test_report_glob: '' })),
}));

vi.mock('../../session/analyzeGating', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../session/analyzeGating')>();
  return {
    ...actual,
    computeWholeTreeContentHash: vi.fn(async () => 'hash-x'),
  };
});

vi.mock('../memoryAdmission', () => ({
  hasMemoryHeadroom: vi.fn(() => ({ allowed: false })),
}));

import { db } from '../../db/db';
import {
  setTaskExecuteNow,
  getTaskExecutionFlags,
  clearTaskExecuteNow,
  sweepExpiredExecuteNow,
  EXECUTE_NOW_TTL_MS,
  updateSessionStatus,
  insertSession,
} from '../../db/queries';
import { loadExecutionRanks } from '../executionPriority';
import {
  admitTestRequest,
  __resetProjectSemaphoresForTest,
} from '../testRequestLane';
import type { NotionTask } from '../../notion/types';

function auditRows(type: string) {
  return db
    .prepare(
      `SELECT task_id, payload FROM audit_log WHERE event_type = ? ORDER BY id`,
    )
    .all(type) as { task_id: string; payload: string }[];
}

beforeEach(() => {
  db.prepare('DELETE FROM task_execution_flags').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM test_request_runs').run();
  __resetProjectSemaphoresForTest();
  mockRunTestCommands.mockReset();
  mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
});

describe('Execute Now set', () => {
  it('writes one audit row per set and refreshes set time without a second flag row', () => {
    setTaskExecuteNow('t1', 'p1', 'merge_conflict');
    const first = getTaskExecutionFlags('t1')!.execute_now_set_at!;
    db.prepare(
      `UPDATE task_execution_flags SET execute_now_set_at = ? WHERE task_id = 'notion:t1'`,
    ).run(first - 1000);
    setTaskExecuteNow('t1', 'p1', 'merge_conflict');

    expect(getTaskExecutionFlags('t1')!.execute_now_set_at).toBeGreaterThan(
      first - 1000,
    );
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM task_execution_flags`)
          .get() as { n: number }
      ).n,
    ).toBe(1);
    const rows = auditRows('task_execute_now_set');
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].payload)).toEqual({ reason: 'merge_conflict' });
  });
});

describe('Execute Now consume at lane grant', () => {
  it.each(['session_request', 'pr_gate'] as const)(
    'clears the flag and audits "consumed" when a %s run is granted a permit',
    async (producer) => {
      setTaskExecuteNow('t2', 'p2', 'merge_conflict');
      const admission = admitTestRequest({
        projectId: 'p2',
        contentHash: 'hash-x',
        worktreePath: '/tmp/wt-exec-now',
        commands: ['npm test'],
        timeoutSec: 60,
        maxRssMb: 0,
        sessionId: null,
        runOrigin: null,
        producer,
        taskId: 't2',
      });
      await admission.result;

      expect(getTaskExecutionFlags('t2')!.execute_now_reason).toBeNull();
      const cleared = auditRows('task_execute_now_cleared');
      expect(cleared).toHaveLength(1);
      expect(JSON.parse(cleared[0].payload).cause).toBe('consumed');
    },
  );

  it('does not consume a flag set after the permit was granted', () => {
    setTaskExecuteNow('t3', 'p3', 'merge_conflict');
    const setAt = getTaskExecutionFlags('t3')!.execute_now_set_at!;
    expect(clearTaskExecuteNow('t3', 'consumed', setAt - 1)).toBe(false);
    expect(getTaskExecutionFlags('t3')!.execute_now_reason).toBe(
      'merge_conflict',
    );
    expect(auditRows('task_execute_now_cleared')).toHaveLength(0);
  });
});

describe('PR merged / closed clearing', () => {
  it.each(['pr_merged', 'pr_closed'] as const)('clears with cause %s', (cause) => {
    setTaskExecuteNow('t4', 'p4', 'merge_conflict');
    expect(clearTaskExecuteNow('t4', cause)).toBe(true);
    expect(getTaskExecutionFlags('t4')!.execute_now_set_at).toBeNull();
    expect(JSON.parse(auditRows('task_execute_now_cleared')[0].payload).cause).toBe(
      cause,
    );
  });
});

describe('Execute Now TTL', () => {
  const task = (id: string): NotionTask =>
    ({
      id,
      status: '🗂️ Ready',
      dependsOn: [],
      priority: undefined,
    }) as unknown as NotionTask;

  it('is ignored by the rank loader and cleared by the sweep with cause expired', () => {
    setTaskExecuteNow('t5', 'p5', 'merge_conflict');
    expect(loadExecutionRanks('p5', [task('t5')]).get('notion:t5')?.group).toBe(
      'execute_now',
    );

    db.prepare(
      `UPDATE task_execution_flags SET execute_now_set_at = ? WHERE task_id = 'notion:t5'`,
    ).run(Date.now() - EXECUTE_NOW_TTL_MS - 1000);

    expect(loadExecutionRanks('p5', [task('t5')]).get('notion:t5')?.group).not.toBe(
      'execute_now',
    );
    expect(sweepExpiredExecuteNow()).toBe(1);
    expect(getTaskExecutionFlags('t5')!.execute_now_set_at).toBeNull();
    expect(JSON.parse(auditRows('task_execute_now_cleared')[0].payload).cause).toBe(
      'expired',
    );
  });
});

describe('terminal session', () => {
  it('leaves the flag set', () => {
    setTaskExecuteNow('t6', 'p6', 'merge_conflict');
    insertSession({
      session_id: 's6',
      task_id: 't6',
      task_url: null,
      project_context_url: null,
      project_id: 'p6',
      status: 'running',
      started_at: new Date().toISOString(),
    } as Parameters<typeof insertSession>[0]);
    updateSessionStatus('s6', 'done');
    expect(getTaskExecutionFlags('t6')!.execute_now_reason).toBe(
      'merge_conflict',
    );
  });
});
