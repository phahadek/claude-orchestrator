/**
 * Tests for the resolve-eligibility watcher
 * (packages/backend/src/investigation/investigationReconciler.ts's
 * runReportResolveWatcherTick) — the Half A closure the design locked but
 * no code path previously drove: a committed report whose full dispatch
 * history has settled (isResolveEligible) must advance to 'resolved'
 * automatically.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    getProjectById: vi
      .fn()
      .mockReturnValue({ contextUrl: 'https://notion.so/proj-a' }),
  };
});

import { db } from '../../db/db.js';
import { ProjectService } from '../../projects/ProjectService.js';
import {
  insertReport,
  updateReportState,
  recordDispatch,
  getReport,
} from '../reportStore.js';
import { runReportResolveWatcherTick } from '../investigationReconciler.js';

let milestoneId: string;

beforeAll(() => {
  ProjectService.create({
    id: 'proj-a',
    name: 'Project A',
    projectDir: '/tmp/proj-a',
  });
  milestoneId = ProjectService.createMilestone({
    id: 'ms-uuid-m1',
    projectId: 'proj-a',
    name: 'M1',
    canonicalShortId: 'M1',
  }).id;
});

beforeEach(() => {
  db.prepare('DELETE FROM investigation_report_dispatch').run();
  db.prepare('DELETE FROM investigation_report').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM audit_log').run();
});

function makeReport(
  overrides: Partial<Parameters<typeof insertReport>[0]> = {},
) {
  const report = insertReport({
    projectId: 'proj-a',
    milestoneId,
    title: 'sessions erroring after deploy',
    symptomText: 'several sessions errored right after the last deploy',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  });
  return updateReportState(report.id, 'committed', new Date(0).toISOString());
}

function insertSession(
  sessionId: string,
  status: string,
  overrides: Partial<{ taskId: string }> = {},
) {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, project_id, session_type, status, started_at, archived)
     VALUES (?, ?, 'proj-a', 'ops', ?, ?, 0)`,
  ).run(sessionId, overrides.taskId ?? 'report-batch:b1', status, Date.now());
}

function insertIntent(id: string, sessionId: string, state: string) {
  db.prepare(
    `INSERT INTO staged_intent (id, kind, payload, payload_hash, task_id, project_id, session_id, state, created_at, updated_at)
     VALUES (?, 'task.create', '{}', 'hash', 'report-batch:b1', 'proj-a', ?, ?, ?, ?)`,
  ).run(id, sessionId, state, Date.now(), Date.now());
}

describe('runReportResolveWatcherTick', () => {
  it('advances a committed report to resolved once its only dispatched session is terminal and every staged intent settled, emitting a state-change audit row', () => {
    const report = makeReport();
    insertSession('sess-1', 'done');
    recordDispatch(report.id, 'sess-1', new Date(0).toISOString());
    insertIntent('intent-1', 'sess-1', 'committed');

    const result = runReportResolveWatcherTick();

    expect(result.resolved).toEqual([report.id]);
    expect(getReport(report.id)?.state).toBe('resolved');

    const auditRow = db
      .prepare(
        `SELECT payload FROM audit_log WHERE event_type = 'investigation_report_state_changed' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { payload: string };
    const payload = JSON.parse(auditRow.payload);
    expect(payload).toMatchObject({
      reportId: report.id,
      from: 'committed',
      to: 'resolved',
    });
  });

  it('resolves a report whose dispatched session staged zero intents (the vacuous case)', () => {
    const report = makeReport();
    insertSession('sess-1', 'killed');
    recordDispatch(report.id, 'sess-1', new Date(0).toISOString());

    const result = runReportResolveWatcherTick();

    expect(result.resolved).toEqual([report.id]);
    expect(getReport(report.id)?.state).toBe('resolved');
  });

  it('does not resolve a report carrying a second, still-live dispatch even in a batched (one session, N reports) dispatch', () => {
    const reportA = makeReport({ title: 'A' });
    const reportB = makeReport({ title: 'B' });
    // Batched dispatch: one session covers both reports.
    insertSession('sess-batch', 'done');
    recordDispatch(reportA.id, 'sess-batch', new Date(0).toISOString());
    recordDispatch(reportB.id, 'sess-batch', new Date(0).toISOString());
    // reportB gets a second, still-live dispatch of its own.
    insertSession('sess-live', 'running', { taskId: 'report-batch:b2' });
    recordDispatch(reportB.id, 'sess-live', new Date(0).toISOString());

    const result = runReportResolveWatcherTick();

    expect(result.resolved).toEqual([reportA.id]);
    expect(getReport(reportA.id)?.state).toBe('resolved');
    expect(getReport(reportB.id)?.state).toBe('committed');
  });

  it('never advances an abandoned report, and is idempotent across repeated ticks', () => {
    const abandoned = makeReport({ title: 'abandoned one' });
    updateReportState(abandoned.id, 'abandoned', new Date(0).toISOString());
    insertSession('sess-1', 'done');
    recordDispatch(abandoned.id, 'sess-1', new Date(0).toISOString());

    const resolvedReport = makeReport({ title: 'resolves cleanly' });
    insertSession('sess-2', 'done');
    recordDispatch(resolvedReport.id, 'sess-2', new Date(0).toISOString());

    const first = runReportResolveWatcherTick();
    expect(first.resolved).toEqual([resolvedReport.id]);
    expect(getReport(abandoned.id)?.state).toBe('abandoned');

    const auditCountAfterFirst = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM audit_log WHERE event_type = 'investigation_report_state_changed'`,
        )
        .get() as { c: number }
    ).c;

    const second = runReportResolveWatcherTick();
    expect(second.resolved).toEqual([]);
    expect(getReport(abandoned.id)?.state).toBe('abandoned');

    const auditCountAfterSecond = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM audit_log WHERE event_type = 'investigation_report_state_changed'`,
        )
        .get() as { c: number }
    ).c;
    expect(auditCountAfterSecond).toBe(auditCountAfterFirst);
  });

  it('does not resolve a committed report with no dispatch history at all', () => {
    const report = makeReport();

    const result = runReportResolveWatcherTick();

    expect(result.resolved).toEqual([]);
    expect(getReport(report.id)?.state).toBe('committed');
  });
});
