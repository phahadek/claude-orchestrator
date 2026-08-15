/**
 * Integration test: a report filed through the operator intake (reportService's
 * createReport, the write path InvestigationReportSection.tsx posts through)
 * must be visible to convergenceService's investigationReport axis, which
 * reads listReportsByMilestone(projectId, milestoneRow.id) — the milestones.id
 * UUID key space. Exercises the real write path (createReport) and the real
 * read path (getMilestoneConvergence) against a real db, rather than mocking
 * reportStore/ProjectService as convergenceService.test.ts does — the bug this
 * task fixes was a false-green precisely because those two sides disagreed on
 * key space, so this test must not mock either of them away.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { ProjectService } from '../../projects/ProjectService.js';
import {
  createReport,
  commitReport,
} from '../../investigation/reportService.js';
import { getMilestoneConvergence } from '../convergenceService.js';

beforeAll(() => {
  ProjectService.create({
    id: 'proj-a',
    name: 'Project A',
    projectDir: '/tmp/proj-a',
  });
  ProjectService.createMilestone({
    id: 'ms-uuid-m15',
    projectId: 'proj-a',
    name: 'M15 full name',
    canonicalShortId: 'M15',
  });
});

describe('getMilestoneConvergence investigationReport axis — operator-intake write path', () => {
  it('reports blocked with blockingCount 1 for a committed report filed via the display-name form', () => {
    const report = createReport({
      projectId: 'proj-a',
      milestoneId: 'M15',
      title: 'sessions erroring after deploy',
      symptomText: 'several sessions errored right after the last deploy',
    });
    commitReport(report.id);

    const convergence = getMilestoneConvergence('proj-a', 'M15');

    expect(convergence.axes.investigationReport.status).toBe('blocked');
    expect(convergence.axes.investigationReport.blockingCount).toBe(1);
  });
});
