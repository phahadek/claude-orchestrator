/**
 * routeStageTimeBlock's planning.noOp auto-resolve hook for an
 * investigate-dispatched session (maybeAutoResolveInvestigateNoOp): a
 * session whose task_id is the synthetic `report-batch:<batchId>` form
 * (see sessionPredicates.ts#isInvestigateSession) can stage a standalone
 * planning.noOp naming one of its own dispatched reports as having no
 * actionable finding. It auto-commits at stage time, resolves the named
 * report via updateReportState (never applyResolvedNoOp — there is no real
 * task backend for a synthetic batch id), and records the noOp's reason on
 * the resulting investigation_report_state_changed audit row. A noOp naming
 * a report outside this session's own dispatched batch is rejected at
 * stage time.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

const { mockRecordEvent } = vi.hoisted(() => ({
  mockRecordEvent: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertSession, getStagedIntent, getSession } from '../../db/queries';
import { stageIntent, routeStageTimeBlock } from '../stagedIntents';
import {
  insertReport,
  recordDispatch,
  getReport,
} from '../../investigation/reportStore';
import { SessionTaskBindingError } from '../stagedIntents';

function seedInvestigateSession(sessionId: string, batchId: string) {
  insertSession({
    session_id: sessionId,
    task_id: `report-batch:${batchId}`,
    task_url: null,
    project_context_url: null,
    status: 'idle',
    started_at: 0,
    session_type: 'ops' as never,
  });
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM investigation_report_dispatch').run();
  db.prepare('DELETE FROM investigation_report').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('planning.noOp auto-resolve for an investigate-dispatched session', () => {
  it('auto-commits and resolves the named report with the noOp reason recorded', async () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'flaky-looking spike',
      symptomText: 'error rate spike at 03:00',
      createdAt: '2026-08-13T00:00:00Z',
    });
    seedInvestigateSession('sess-inv-1', 'batch-1');
    recordDispatch(report.id, 'sess-inv-1', '2026-08-13T00:00:01Z');

    const intent = stageIntent(
      'planning.noOp',
      {
        taskId: report.id,
        reason: 'already fixed by commit 95507034; not reproducible on dev',
      },
      'proj-1',
      null,
      'sess-inv-1',
    );

    const result = await routeStageTimeBlock(intent, undefined);

    expect(result.state).toBe('committed');
    expect(getStagedIntent(intent.id)?.state).toBe('committed');
    expect(mockGetTaskBackend).not.toHaveBeenCalled();

    const updated = getReport(report.id);
    expect(updated?.state).toBe('resolved');

    const session = getSession('sess-inv-1');
    expect(session?.status).toBe('done');
    expect(session?.terminal_completion_reason).toBe('no_op_resolved');

    const stateChangeCall = mockRecordEvent.mock.calls.find(
      (call) => call[0]?.event_type === 'investigation_report_state_changed',
    );
    expect(stateChangeCall?.[0]?.payload).toMatchObject({
      reportId: report.id,
      from: 'draft',
      to: 'resolved',
      reason: 'already fixed by commit 95507034; not reproducible on dev',
    });
  });

  it('rejects a planning.noOp naming a report outside this session own dispatched batch', () => {
    const inBatch = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'in batch',
      symptomText: 'x',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const outOfBatch = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'out of batch',
      symptomText: 'y',
      createdAt: '2026-08-13T00:00:01Z',
    });
    seedInvestigateSession('sess-inv-2', 'batch-2');
    recordDispatch(inBatch.id, 'sess-inv-2', '2026-08-13T00:00:02Z');

    expect(() =>
      stageIntent(
        'planning.noOp',
        { taskId: outOfBatch.id, reason: 'not my report' },
        'proj-1',
        null,
        'sess-inv-2',
      ),
    ).toThrow(SessionTaskBindingError);
  });
});
