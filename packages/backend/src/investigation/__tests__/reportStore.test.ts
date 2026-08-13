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
  listDispatchedSessions,
  isInFlight,
  isResolveEligible,
  blocksMilestoneConvergence,
} from '../reportStore.js';

function insertSession(sessionId: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, `report-batch:${sessionId}`, status, 1000);
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
});

describe('blocksMilestoneConvergence', () => {
  it('blocks in every state except resolved/abandoned', () => {
    expect(blocksMilestoneConvergence('draft')).toBe(true);
    expect(blocksMilestoneConvergence('committed')).toBe(true);
    expect(blocksMilestoneConvergence('resolved')).toBe(false);
    expect(blocksMilestoneConvergence('abandoned')).toBe(false);
  });
});
