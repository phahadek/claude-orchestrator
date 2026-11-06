/**
 * Tests for packages/backend/src/investigation/reportStore.ts.
 *
 * AC: investigation_report + investigation_report_dispatch are created by
 * migration; insert/get/list/update round-trip; dispatch recording and
 * listing works; isInFlight and isResolveEligible are derived-live reads
 * over the dispatch join table, not task_id string-matching; a report
 * blocks convergence unless resolved/abandoned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertReport,
  getReport,
  listReportsByMilestone,
  listReportsByProject,
  updateReportState,
  recordDispatch,
  recordBatchDispatch,
  reconcileOrphanedDispatches,
  listDispatchedSessions,
  getDispatchedSessionsForReport,
  getReportsForBatchTaskId,
  isInFlight,
  isResolveEligible,
  isDispatchEligible,
  dispatchReportBatchesUpTo,
  blocksMilestoneConvergence,
} from '../reportStore.js';

function insertSession(
  sessionId: string,
  status: string,
  metadata?: unknown,
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    `report-batch:${sessionId}`,
    status,
    1000,
    metadata === undefined ? null : JSON.stringify(metadata),
  );
}

function insertStagedIntent(
  id: string,
  sessionId: string,
  state: string,
): void {
  db.prepare(
    `INSERT INTO staged_intent
       (id, kind, payload, payload_hash, project_id, session_id, state, created_at, updated_at)
     VALUES (?, 'task.setStatus', '{}', 'hash', 'proj-1', ?, ?, 1000, 1000)`,
  ).run(id, sessionId, state);
}

beforeEach(() => {
  db.prepare('DELETE FROM investigation_report_dispatch').run();
  db.prepare('DELETE FROM investigation_report').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('investigation_report schema', () => {
  it('creates the two tables', () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('investigation_report', 'investigation_report_dispatch')`,
      )
      .all() as { name: string }[];
    expect(names.map((r) => r.name).sort()).toEqual([
      'investigation_report',
      'investigation_report_dispatch',
    ]);
  });
});

describe('insert/get/list/update', () => {
  it('round-trips a report starting in draft', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'Something is wrong',
      symptomText: 'Sessions crash on startup',
      createdAt: '2026-08-13T00:00:00Z',
    });
    expect(report.state).toBe('draft');
    expect(report.source).toBe('operator');
    expect(getReport(report.id)).toEqual(report);
  });

  it('lists by milestone and by project', () => {
    const r1 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const r2 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-2',
      title: 'B',
      symptomText: 'b',
      createdAt: '2026-08-13T00:00:01Z',
    });
    expect(
      listReportsByMilestone('proj-1', 'milestone-uuid-1').map((r) => r.id),
    ).toEqual([r1.id]);
    expect(
      listReportsByProject('proj-1')
        .map((r) => r.id)
        .sort(),
    ).toEqual([r1.id, r2.id].sort());
  });

  it('advances state', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const updated = updateReportState(
      report.id,
      'committed',
      '2026-08-13T00:01:00Z',
    );
    expect(updated.state).toBe('committed');
    expect(getReport(report.id)?.state).toBe('committed');
  });
});

describe('dispatch tracking', () => {
  it('records and lists a report’s full dispatch history', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'running');
    insertSession('sess-2', 'done');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    recordDispatch(report.id, 'sess-2', '2026-08-13T00:00:02Z');
    expect(listDispatchedSessions(report.id).map((d) => d.session_id)).toEqual([
      'sess-1',
      'sess-2',
    ]);
  });
});

describe('getDispatchedSessionsForReport', () => {
  it('carries session id and status for both an in-flight and a terminal session, most recent first', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'done');
    insertSession('sess-2', 'running');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    recordDispatch(report.id, 'sess-2', '2026-08-13T00:00:02Z');
    expect(getDispatchedSessionsForReport(report.id)).toEqual([
      {
        sessionId: 'sess-2',
        sessionStatus: 'running',
        dispatchedAt: '2026-08-13T00:00:02Z',
      },
      {
        sessionId: 'sess-1',
        sessionStatus: 'done',
        dispatchedAt: '2026-08-13T00:00:01Z',
      },
    ]);
  });

  it('is empty with no dispatch history', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    expect(getDispatchedSessionsForReport(report.id)).toEqual([]);
  });
});

describe('getReportsForBatchTaskId', () => {
  it("returns the single report dispatched to a batch's session", () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-single', 'running');
    recordDispatch(report.id, 'sess-single', '2026-08-13T00:00:01Z');

    expect(
      getReportsForBatchTaskId('report-batch:sess-single').map((r) => r.id),
    ).toEqual([report.id]);
  });

  it('returns every report dispatched to a multi-report batch', () => {
    const r1 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const r2 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'B',
      symptomText: 'b',
      createdAt: '2026-08-13T00:00:01Z',
    });
    insertSession('sess-multi', 'running');
    recordDispatch(r1.id, 'sess-multi', '2026-08-13T00:00:02Z');
    recordDispatch(r2.id, 'sess-multi', '2026-08-13T00:00:02Z');

    expect(
      getReportsForBatchTaskId('report-batch:sess-multi').map((r) => r.id),
    ).toEqual([r1.id, r2.id]);
  });

  it('is empty when no session matches the task_id', () => {
    expect(getReportsForBatchTaskId('report-batch:no-such-session')).toEqual(
      [],
    );
  });

  it('is empty when the session has no dispatch rows', () => {
    insertSession('sess-no-dispatch', 'running');
    expect(getReportsForBatchTaskId('report-batch:sess-no-dispatch')).toEqual(
      [],
    );
  });
});

describe('isInFlight', () => {
  it('is false with no dispatch history', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    expect(isInFlight(report.id)).toBe(false);
  });

  it('is true when any dispatched session is non-terminal', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'done');
    insertSession('sess-2', 'running');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    recordDispatch(report.id, 'sess-2', '2026-08-13T00:00:02Z');
    expect(isInFlight(report.id)).toBe(true);
  });

  it('is false when every dispatched session is terminal', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'done');
    insertSession('sess-2', 'killed');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    recordDispatch(report.id, 'sess-2', '2026-08-13T00:00:02Z');
    expect(isInFlight(report.id)).toBe(false);
  });
});

describe('isResolveEligible', () => {
  it('is false with no dispatch history at all', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    expect(isResolveEligible(report.id)).toBe(false);
  });

  it('is false when no dispatched session has reached a terminal status', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'running');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    expect(isResolveEligible(report.id)).toBe(false);
  });

  it('is true (vacuously) once a session ends having staged nothing', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'done');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    expect(isResolveEligible(report.id)).toBe(true);
  });

  it('is false when a session was killed before staging anything', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'killed');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    expect(isResolveEligible(report.id)).toBe(false);
  });

  it('is false when a session crashed (error) before staging anything', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'error');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    expect(isResolveEligible(report.id)).toBe(false);
  });

  it('resolves once a redispatch concludes cleanly, even though the first attempt was killed having staged nothing', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'killed');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    insertSession('sess-2', 'done');
    recordDispatch(report.id, 'sess-2', '2026-08-13T00:00:02Z');
    expect(isResolveEligible(report.id)).toBe(true);
  });

  it('is false when a tied staged_intent is still non-terminal', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'done');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    insertStagedIntent('intent-1', 'sess-1', 'staged');
    expect(isResolveEligible(report.id)).toBe(false);
  });

  it('is true once every tied staged_intent, across the whole dispatch history, is terminal', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'error');
    insertSession('sess-2', 'done');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    recordDispatch(report.id, 'sess-2', '2026-08-13T00:00:02Z');
    insertStagedIntent('intent-1', 'sess-1', 'rejected');
    insertStagedIntent('intent-2', 'sess-2', 'committed');
    expect(isResolveEligible(report.id)).toBe(true);
  });

  it('treats a withdrawn staged_intent as terminal, same as committed/rejected/superseded', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-1', 'done');
    recordDispatch(report.id, 'sess-1', '2026-08-13T00:00:01Z');
    insertStagedIntent('intent-1', 'sess-1', 'withdrawn');
    expect(isResolveEligible(report.id)).toBe(true);
  });
});

describe('blocksMilestoneConvergence', () => {
  it('blocks in every state except resolved/abandoned', () => {
    expect(blocksMilestoneConvergence('draft')).toBe(true);
    expect(blocksMilestoneConvergence('committed')).toBe(true);
    expect(blocksMilestoneConvergence('resolved')).toBe(false);
    expect(blocksMilestoneConvergence('abandoned')).toBe(false);
  });
});

describe('batch-aware resolution across multiple dispatches', () => {
  it('resolves once a batched session (multiple reports, one session) reaches terminal', () => {
    const r1 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const r2 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'B',
      symptomText: 'b',
      createdAt: '2026-08-13T00:00:01Z',
    });
    insertSession('sess-batch', 'running');
    recordDispatch(r1.id, 'sess-batch', '2026-08-13T00:00:02Z');
    recordDispatch(r2.id, 'sess-batch', '2026-08-13T00:00:02Z');
    expect(isResolveEligible(r1.id)).toBe(false);
    expect(isResolveEligible(r2.id)).toBe(false);

    db.prepare(`UPDATE sessions SET status = 'done' WHERE session_id = ?`).run(
      'sess-batch',
    );
    expect(isResolveEligible(r1.id)).toBe(true);
    expect(isResolveEligible(r2.id)).toBe(true);
  });

  it('aggregates staged-intent terminality across a report dispatched twice — once solo, once in a later batch', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    // First dispatch: solo session that died with a non-terminal staged intent.
    insertSession('sess-solo', 'error');
    recordDispatch(report.id, 'sess-solo', '2026-08-13T00:00:01Z');
    insertStagedIntent('intent-1', 'sess-solo', 'staged');
    expect(isResolveEligible(report.id)).toBe(false);

    // Second dispatch: a later batch (this report + another) that terminates cleanly.
    const other = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'B',
      symptomText: 'b',
      createdAt: '2026-08-13T00:00:02Z',
    });
    insertSession('sess-batch-2', 'done');
    recordDispatch(report.id, 'sess-batch-2', '2026-08-13T00:00:03Z');
    recordDispatch(other.id, 'sess-batch-2', '2026-08-13T00:00:03Z');
    insertStagedIntent('intent-2', 'sess-batch-2', 'committed');

    // Still ineligible: intent-1 from the first (solo) dispatch is still 'staged'.
    expect(isResolveEligible(report.id)).toBe(false);

    // Once the first dispatch's stale intent resolves, the whole history is terminal.
    db.prepare(`UPDATE staged_intent SET state = 'rejected' WHERE id = ?`).run(
      'intent-1',
    );
    expect(isResolveEligible(report.id)).toBe(true);
  });
});

describe('recordBatchDispatch', () => {
  it('writes the session insert and every dispatch row in one transaction', () => {
    const r1 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const r2 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'B',
      symptomText: 'b',
      createdAt: '2026-08-13T00:00:01Z',
    });

    recordBatchDispatch(
      () => insertSession('sess-atomic', 'running'),
      [r1.id, r2.id],
      'sess-atomic',
      '2026-08-13T00:00:02Z',
    );

    expect(
      db
        .prepare(`SELECT 1 FROM sessions WHERE session_id = ?`)
        .get('sess-atomic'),
    ).toBeTruthy();
    expect(listDispatchedSessions(r1.id).map((d) => d.session_id)).toEqual([
      'sess-atomic',
    ]);
    expect(listDispatchedSessions(r2.id).map((d) => d.session_id)).toEqual([
      'sess-atomic',
    ]);
  });

  it('rolls back the session insert if writing a dispatch row fails', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });

    expect(() =>
      recordBatchDispatch(
        () => insertSession('sess-fail', 'running'),
        // 'missing-report' violates investigation_report_dispatch's FK.
        [report.id, 'missing-report'],
        'sess-fail',
        '2026-08-13T00:00:01Z',
      ),
    ).toThrow();

    expect(
      db
        .prepare(`SELECT 1 FROM sessions WHERE session_id = ?`)
        .get('sess-fail'),
    ).toBeFalsy();
    expect(listDispatchedSessions(report.id)).toEqual([]);
  });
});

describe('reconcileOrphanedDispatches', () => {
  it('backfills dispatch rows for a session missing them, from sessions.metadata.reportIds', () => {
    const r1 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const r2 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'B',
      symptomText: 'b',
      createdAt: '2026-08-13T00:00:01Z',
    });
    // Session committed without its dispatch rows (the orphaned case).
    insertSession('sess-orphan', 'running', { reportIds: [r1.id, r2.id] });
    expect(listDispatchedSessions(r1.id)).toEqual([]);

    const inserted = reconcileOrphanedDispatches('2026-08-13T00:05:00Z');
    expect(inserted).toBe(2);
    expect(listDispatchedSessions(r1.id).map((d) => d.session_id)).toEqual([
      'sess-orphan',
    ]);
    expect(listDispatchedSessions(r2.id).map((d) => d.session_id)).toEqual([
      'sess-orphan',
    ]);
  });

  it('is idempotent — a second tick after backfill (or after a normal dispatch) inserts nothing new', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    insertSession('sess-orphan-2', 'running', { reportIds: [report.id] });

    expect(reconcileOrphanedDispatches('2026-08-13T00:05:00Z')).toBe(1);
    expect(reconcileOrphanedDispatches('2026-08-13T00:06:00Z')).toBe(0);
    expect(listDispatchedSessions(report.id)).toHaveLength(1);
  });

  it('leaves a session with no dispatch history and no metadata untouched', () => {
    insertSession('sess-no-metadata', 'running');
    expect(reconcileOrphanedDispatches('2026-08-13T00:05:00Z')).toBe(0);
  });
});

describe('isDispatchEligible / dispatchReportBatchesUpTo', () => {
  it('is eligible only when committed and not in flight', () => {
    const draft = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    expect(isDispatchEligible(draft.id)).toBe(false);

    const committed = updateReportState(
      draft.id,
      'committed',
      '2026-08-13T00:01:00Z',
    );
    expect(isDispatchEligible(committed.id)).toBe(true);

    insertSession('sess-live', 'running');
    recordDispatch(committed.id, 'sess-live', '2026-08-13T00:02:00Z');
    expect(isDispatchEligible(committed.id)).toBe(false);
  });

  it('revalidates immediately before dispatch and skips a report that became ineligible after the scan, without double-dispatching', () => {
    const report = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    updateReportState(report.id, 'committed', '2026-08-13T00:01:00Z');

    // Scan time: report is eligible, so it's selected as a candidate batch.
    expect(isDispatchEligible(report.id)).toBe(true);
    const candidateBatches = [[report.id]];

    // Between scan and dispatch, another dispatch lands for this report.
    insertSession('sess-raced', 'running');
    recordDispatch(report.id, 'sess-raced', '2026-08-13T00:01:30Z');

    const dispatchFn = vi.fn(() => true);
    const dispatchedCount = dispatchReportBatchesUpTo(
      candidateBatches,
      dispatchFn,
    );

    expect(dispatchedCount).toBe(0);
    expect(dispatchFn).not.toHaveBeenCalled();
    // Only the raced dispatch is on record — no double-dispatch happened.
    expect(listDispatchedSessions(report.id).map((d) => d.session_id)).toEqual([
      'sess-raced',
    ]);
  });

  it('dispatches a batch that is still eligible at launch time', () => {
    const r1 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'A',
      symptomText: 'a',
      createdAt: '2026-08-13T00:00:00Z',
    });
    const r2 = insertReport({
      projectId: 'proj-1',
      milestoneId: 'milestone-uuid-1',
      title: 'B',
      symptomText: 'b',
      createdAt: '2026-08-13T00:00:01Z',
    });
    updateReportState(r1.id, 'committed', '2026-08-13T00:01:00Z');
    updateReportState(r2.id, 'committed', '2026-08-13T00:01:01Z');

    const dispatchFn = vi.fn(() => true);
    const dispatchedCount = dispatchReportBatchesUpTo(
      [[r1.id, r2.id]],
      dispatchFn,
    );

    expect(dispatchedCount).toBe(1);
    expect(dispatchFn).toHaveBeenCalledWith([r1.id, r2.id]);
  });
});
