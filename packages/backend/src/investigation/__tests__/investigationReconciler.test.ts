/**
 * Tests for the investigate reconciler
 * (packages/backend/src/investigation/investigationReconciler.ts).
 *
 * AC: the reconciler tick dispatches a committed, eligible report exactly
 * once per tick and skips a report with a live non-terminal session
 * recorded in investigation_report_dispatch; max_concurrent_investigate_sessions
 * bounds how many reports the reconciler dispatches per tick, without
 * raising the shared max_concurrent_planning_sessions ceiling.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

// launchInvestigateBatch (via investigateDispatcher.ts) resolves the
// project through config.ts's getProjectById, which lazy-requires
// ProjectService via a CJS `require()` that doesn't resolve under vitest's
// ESM transform — override just that export, mirroring
// investigateDispatcher.test.ts's own mock, while keeping the rest of the
// real module (normalizePath etc., used by ProjectService.create below).
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
import { upsertArm } from '../../db/queries.js';
import { typedSetSetting } from '../../config/settings.js';
import { ProjectService } from '../../projects/ProjectService.js';
import {
  insertReport,
  updateReportState,
  listDispatchedSessions,
} from '../reportStore.js';
import { runInvestigationReconcilerTick } from '../investigationReconciler.js';

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
  db.prepare('DELETE FROM flow_arm').run();
  db.prepare('DELETE FROM sessions').run();
  upsertArm(milestoneId, 'investigate', true, 1);
  typedSetSetting('max_concurrent_planning_sessions', 5);
  typedSetSetting('max_concurrent_investigate_sessions', 5);
  typedSetSetting('human_reserve', 0);
});

/** Inserts a report and, by default, commits it — the reconciler's dispatch-eligible state. */
function makeReport(
  overrides: Partial<Parameters<typeof insertReport>[0]> = {},
  { committed = true }: { committed?: boolean } = {},
) {
  const report = insertReport({
    projectId: 'proj-a',
    milestoneId,
    title: 'sessions erroring after deploy',
    symptomText: 'several sessions errored right after the last deploy',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  });
  return committed
    ? updateReportState(report.id, 'committed', new Date(0).toISOString())
    : report;
}

/**
 * A fake SessionManager whose start() inserts a real, live (status
 * 'running') sessions row — isInFlight (reportStore.ts) reads session
 * status straight from the sessions table, so a mock that doesn't insert
 * one would make every report look eligible again on the very next tick.
 */
function makeSessionManager() {
  let counter = 0;
  return {
    start: vi.fn().mockImplementation((taskId: string) => {
      counter += 1;
      const sessionId = `sess-${counter}`;
      db.prepare(
        `INSERT INTO sessions (session_id, task_id, project_id, session_type, status, started_at, archived)
         VALUES (?, ?, 'proj-a', 'ops', 'running', ?, 0)`,
      ).run(sessionId, taskId, Date.now());
      return Promise.resolve(sessionId);
    }),
  };
}

describe('runInvestigationReconcilerTick', () => {
  it('dispatches a committed, eligible report exactly once per tick', async () => {
    const report = makeReport();
    const sessionManager = makeSessionManager();

    const result = await runInvestigationReconcilerTick(
      sessionManager as never,
    );

    expect(result.dispatched).toEqual([report.id]);
    expect(sessionManager.start).toHaveBeenCalledTimes(1);
    expect(listDispatchedSessions(report.id)).toHaveLength(1);
  });

  it('skips a report with a live non-terminal session recorded in investigation_report_dispatch', async () => {
    const report = makeReport();
    const sessionManager = makeSessionManager();

    const first = await runInvestigationReconcilerTick(sessionManager as never);
    expect(first.dispatched).toEqual([report.id]);

    const second = await runInvestigationReconcilerTick(sessionManager as never);
    expect(second.dispatched).toEqual([]);
    expect(sessionManager.start).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a report whose milestone has the investigate arm disarmed', async () => {
    upsertArm(milestoneId, 'investigate', false, 2);
    makeReport();
    const sessionManager = makeSessionManager();

    const result = await runInvestigationReconcilerTick(sessionManager as never);

    expect(result.dispatched).toEqual([]);
    expect(sessionManager.start).not.toHaveBeenCalled();
  });

  it('does not dispatch a draft (uncommitted) report', async () => {
    makeReport({}, { committed: false });
    const sessionManager = makeSessionManager();

    const result = await runInvestigationReconcilerTick(sessionManager as never);

    expect(result.dispatched).toEqual([]);
  });

  it('max_concurrent_investigate_sessions bounds dispatches per tick without raising the shared planning ceiling', async () => {
    typedSetSetting('max_concurrent_planning_sessions', 10);
    typedSetSetting('max_concurrent_investigate_sessions', 1);
    const reportA = makeReport({ title: 'A' });
    const reportB = makeReport({ title: 'B' });
    const sessionManager = makeSessionManager();

    const result = await runInvestigationReconcilerTick(sessionManager as never);

    expect(result.dispatched).toHaveLength(1);
    expect(result.skippedForBudget).toBe(1);
    expect(sessionManager.start).toHaveBeenCalledTimes(1);
    expect([reportA.id, reportB.id]).toContain(result.dispatched[0]);
  });

  it('does not exceed the shared max_concurrent_planning_sessions ceiling even with a high investigate sub-limit', async () => {
    typedSetSetting('max_concurrent_planning_sessions', 1);
    typedSetSetting('max_concurrent_investigate_sessions', 10);
    typedSetSetting('human_reserve', 0);
    // Occupy the sole planning slot with a live planning-type session.
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, project_id, session_type, status, started_at, archived)
       VALUES ('live-groom', 'notion:task-1', 'proj-a', 'groom', 'running', ?, 0)`,
    ).run(Date.now());
    makeReport();
    const sessionManager = makeSessionManager();

    const result = await runInvestigationReconcilerTick(sessionManager as never);

    expect(result.dispatched).toEqual([]);
    expect(result.skippedForBudget).toBe(1);
  });
});
