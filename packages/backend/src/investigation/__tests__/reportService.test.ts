/**
 * Tests for packages/backend/src/investigation/reportService.ts — the
 * state-machine guards routes/reportState.ts's routes rely on.
 *
 * AC: create rejects a request missing required core fields; commit
 * requires milestone_id set and a draft-state report; abandon works from
 * any non-terminal state and rejects terminal ones; list/get expose
 * derived inFlight + resolveEligible fields alongside project/milestone/
 * state filtering. Also: milestone_id is normalized to the milestones.id
 * UUID key space at write time (createReport, updateDraftReport, and the
 * listReports milestone filter) regardless of which form (display name,
 * full board name, UUID) the caller passes in — an unresolvable milestone
 * raises rather than persisting/matching an unresolved value.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { ProjectService } from '../../projects/ProjectService.js';
import {
  createReport,
  updateDraftReport,
  commitReport,
  abandonReport,
  getReportWithDerived,
  listReports,
} from '../reportService.js';
import { recordDispatch } from '../reportStore.js';

function insertSession(sessionId: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, `report-batch:${sessionId}`, status, 1000);
}

let m1Id: string;
let m2Id: string;

beforeAll(() => {
  ProjectService.create({
    id: 'proj-1',
    name: 'Project One',
    projectDir: '/tmp/proj-1',
  });
  ProjectService.create({
    id: 'proj-2',
    name: 'Project Two',
    projectDir: '/tmp/proj-2',
  });
  m1Id = ProjectService.createMilestone({
    id: 'ms-uuid-m1',
    projectId: 'proj-1',
    name: 'Milestone One Board',
    canonicalShortId: 'M1',
  }).id;
  m2Id = ProjectService.createMilestone({
    id: 'ms-uuid-m2',
    projectId: 'proj-1',
    name: 'Milestone Two Board',
    canonicalShortId: 'M2',
  }).id;
  ProjectService.createMilestone({
    id: 'ms-uuid-m1-p2',
    projectId: 'proj-2',
    name: 'Milestone One Board',
    canonicalShortId: 'M1',
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM investigation_report_dispatch').run();
  db.prepare('DELETE FROM investigation_report').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('createReport', () => {
  it('creates a draft report with a defaulted empty milestone_id', () => {
    const report = createReport({
      projectId: 'proj-1',
      title: 'symptom title',
      symptomText: 'things are broken',
    });
    expect(report.state).toBe('draft');
    expect(report.milestone_id).toBe('');
    expect(report.inFlight).toBe(false);
    expect(report.resolveEligible).toBe(false);
  });

  it.each([
    [{ title: 't', symptomText: 's' }, /projectId/],
    [{ projectId: 'p', symptomText: 's' }, /title/],
    [{ projectId: 'p', title: 't' }, /symptomText/],
  ])('rejects a request missing a required core field', (input, msg) => {
    expect(() => createReport(input as never)).toThrow(msg);
  });

  it.each([
    ['a canonical short id (display name)', 'M1'],
    ['a full board name', 'Milestone One Board'],
    ['an already-canonical UUID', 'ms-uuid-m1'],
  ])('resolves %s to the milestone UUID', (_label, milestoneRef) => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: milestoneRef,
      title: 't',
      symptomText: 's',
    });
    expect(report.milestone_id).toBe('ms-uuid-m1');
  });

  it('raises for an unresolvable milestone rather than storing it verbatim', () => {
    expect(() =>
      createReport({
        projectId: 'proj-1',
        milestoneId: 'not-a-real-milestone',
        title: 't',
        symptomText: 's',
      }),
    ).toThrow(/not a known milestone/);
  });
});

describe('commitReport', () => {
  it('rejects committing without milestone_id set', () => {
    const report = createReport({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    expect(() => commitReport(report.id)).toThrow(/milestone_id/);
  });

  it('commits a draft report once milestone_id is set', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'M1',
      title: 't',
      symptomText: 's',
    });
    const committed = commitReport(report.id);
    expect(committed.state).toBe('committed');
  });

  it('rejects committing a report already past draft', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'M1',
      title: 't',
      symptomText: 's',
    });
    commitReport(report.id);
    expect(() => commitReport(report.id)).toThrow(/not draft/);
  });
});

describe('abandonReport', () => {
  it('abandons a draft report', () => {
    const report = createReport({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    const abandoned = abandonReport(report.id);
    expect(abandoned.state).toBe('abandoned');
  });

  it('abandons a committed report', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'M1',
      title: 't',
      symptomText: 's',
    });
    commitReport(report.id);
    const abandoned = abandonReport(report.id);
    expect(abandoned.state).toBe('abandoned');
  });

  it('rejects abandoning an already-terminal report', () => {
    const report = createReport({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    abandonReport(report.id);
    expect(() => abandonReport(report.id)).toThrow(/already abandoned/);
  });
});

describe('updateDraftReport', () => {
  it('updates fields while still draft, resolving milestoneId through the same helper', () => {
    const report = createReport({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    const updated = updateDraftReport(report.id, { milestoneId: 'M2' });
    expect(updated.milestone_id).toBe('ms-uuid-m2');
  });

  it('raises for an unresolvable milestone on update', () => {
    const report = createReport({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    expect(() =>
      updateDraftReport(report.id, { milestoneId: 'not-a-real-milestone' }),
    ).toThrow(/not a known milestone/);
  });

  it('rejects updating a non-draft report', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'M1',
      title: 't',
      symptomText: 's',
    });
    commitReport(report.id);
    expect(() => updateDraftReport(report.id, { title: 'new' })).toThrow(
      /not draft/,
    );
  });
});

describe('listReports / getReportWithDerived', () => {
  it('filters by project/milestone/state and includes derived fields', () => {
    createReport({
      projectId: 'proj-1',
      milestoneId: 'M1',
      title: 'a',
      symptomText: 's',
    });
    const other = createReport({
      projectId: 'proj-1',
      milestoneId: 'M2',
      title: 'b',
      symptomText: 's',
    });
    commitReport(other.id);
    createReport({
      projectId: 'proj-2',
      milestoneId: 'M1',
      title: 'c',
      symptomText: 's',
    });

    const result = listReports({ project: 'proj-1', milestone: 'M2' });
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe(other.id);
    expect(result.items[0]).toHaveProperty('inFlight');
    expect(result.items[0]).toHaveProperty('resolveEligible');

    const byState = listReports({ project: 'proj-1', state: 'committed' });
    expect(byState.total).toBe(1);
    expect(byState.items[0].id).toBe(other.id);
  });

  it('returns undefined for a missing report', () => {
    expect(getReportWithDerived('nope')).toBeUndefined();
  });

  it('carries dispatched session id and status for both an in-flight and a terminal session', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'M1',
      title: 'a',
      symptomText: 's',
    });
    insertSession('sess-running', 'running');
    insertSession('sess-done', 'done');
    recordDispatch(report.id, 'sess-done', '2026-08-13T00:00:01Z');
    recordDispatch(report.id, 'sess-running', '2026-08-13T00:00:02Z');

    const withSessions = getReportWithDerived(report.id);
    expect(withSessions?.dispatchedSessions).toEqual([
      {
        sessionId: 'sess-running',
        sessionStatus: 'running',
        dispatchedAt: '2026-08-13T00:00:02Z',
      },
      {
        sessionId: 'sess-done',
        sessionStatus: 'done',
        dispatchedAt: '2026-08-13T00:00:01Z',
      },
    ]);
  });

  it('returns the same set for a display-name and a UUID milestone filter', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'M1',
      title: 'a',
      symptomText: 's',
    });

    const byDisplayName = listReports({ project: 'proj-1', milestone: 'M1' });
    const byUuid = listReports({ project: 'proj-1', milestone: m1Id });

    expect(byDisplayName.items.map((r) => r.id)).toEqual([report.id]);
    expect(byUuid.items.map((r) => r.id)).toEqual([report.id]);
  });

  it('resolves a milestone filter across projects when no project is given', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'M2',
      title: 'a',
      symptomText: 's',
    });

    const result = listReports({ milestone: m2Id });
    expect(result.items.map((r) => r.id)).toEqual([report.id]);
  });
});
