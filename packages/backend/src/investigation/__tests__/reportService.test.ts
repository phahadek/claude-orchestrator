/**
 * Tests for packages/backend/src/investigation/reportService.ts — the
 * state-machine guards routes/reportState.ts's routes rely on.
 *
 * AC: create rejects a request missing required core fields; commit
 * requires milestone_id set and a draft-state report; abandon works from
 * any non-terminal state and rejects terminal ones; list/get expose
 * derived inFlight + resolveEligible fields alongside project/milestone/
 * state filtering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  createReport,
  updateDraftReport,
  commitReport,
  abandonReport,
  getReportWithDerived,
  listReports,
} from '../reportService.js';

beforeEach(() => {
  db.prepare('DELETE FROM investigation_report_dispatch').run();
  db.prepare('DELETE FROM investigation_report').run();
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
      milestoneId: 'm-1',
      title: 't',
      symptomText: 's',
    });
    const committed = commitReport(report.id);
    expect(committed.state).toBe('committed');
  });

  it('rejects committing a report already past draft', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'm-1',
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
      milestoneId: 'm-1',
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
  it('updates fields while still draft', () => {
    const report = createReport({
      projectId: 'proj-1',
      title: 't',
      symptomText: 's',
    });
    const updated = updateDraftReport(report.id, { milestoneId: 'm-2' });
    expect(updated.milestone_id).toBe('m-2');
  });

  it('rejects updating a non-draft report', () => {
    const report = createReport({
      projectId: 'proj-1',
      milestoneId: 'm-1',
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
    createReport({ projectId: 'proj-1', milestoneId: 'm-1', title: 'a', symptomText: 's' });
    const other = createReport({
      projectId: 'proj-1',
      milestoneId: 'm-2',
      title: 'b',
      symptomText: 's',
    });
    commitReport(other.id);
    createReport({ projectId: 'proj-2', milestoneId: 'm-1', title: 'c', symptomText: 's' });

    const result = listReports({ project: 'proj-1', milestone: 'm-2' });
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
});
