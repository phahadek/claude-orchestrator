/**
 * Integration test for POST /api/milestones/:project/flaky-investigation
 * (packages/backend/src/routes/milestones.ts), exercised against a real DB.
 *
 * AC: firing a grouped investigation for two flaky tests creates exactly one
 * Investigation task at Backlog with both tests listed in its body, links
 * both tracking rows with open=1, and marking that task Done (via the real
 * AuditingTaskBackend.updateStatus) clears both rows.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../tasks/TaskBackend', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../tasks/TaskBackend')>();
  return { ...actual, getTaskBackend: vi.fn() };
});

import { db } from '../../db/db.js';
import { createMilestonesRouter } from '../milestones.js';
import { insertProject, insertMilestone } from '../../db/queries.js';
import { getTaskBackend, AuditingTaskBackend } from '../../tasks/TaskBackend';
import type { TaskBackend, NewTaskFields } from '../../tasks/TaskBackend';

const PROJECT = 'flaky-investigation-route-proj';
const MILESTONE_ID = 'flaky-investigation-route-proj:board-m1';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createMilestonesRouter());
  return app;
}

/** Minimal in-memory fake standing in for a real Notion/Jira/GitHub backend. */
function makeFakeInnerBackend(filedFieldsOut: {
  current?: NewTaskFields;
}): TaskBackend {
  let nextId = 1;
  return {
    type: 'notion',
    fetchReadyTasks: async () => [],
    attachPR: async () => {},
    updateStatus: async () => {},
    fetchTaskPage: async () => '',
    fetchTaskSummary: async () => null,
    fetchNonMilestoneReadyTasks: async () => [],
    updateNotes: async () => {},
    appendImplementationNote: async () => {},
    listTasksByStatus: async () => [],
    createTask: async (fields: NewTaskFields) => {
      filedFieldsOut.current = fields;
      return `notion:filed-investigation-${nextId++}`;
    },
  } as TaskBackend;
}

function insertRollupRow(testId: string, name: string): void {
  db.prepare(
    `INSERT INTO flagged_flaky_tests_rollup
       (project_id, test_id, name, sample_count, transition_count, computed_at)
     VALUES (@project_id, @test_id, @name, @sample_count, @transition_count, @computed_at)`,
  ).run({
    project_id: PROJECT,
    test_id: testId,
    name,
    sample_count: 12,
    transition_count: 5,
    computed_at: 1700000000000,
  });
}

let backend: AuditingTaskBackend;
let filedFields: { current?: NewTaskFields };

beforeEach(() => {
  db.prepare('DELETE FROM flaky_remediation_tracking').run();
  db.prepare('DELETE FROM flagged_flaky_tests_rollup').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM milestones').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM task_status_writes').run();
  db.prepare('DELETE FROM task_cache').run();

  insertProject({
    id: PROJECT,
    name: 'Flaky Investigation Route Project',
    project_dir: '/tmp/flaky-investigation-route-proj',
    context_url: null,
    github_repo: null,
    task_source: 'notion',
  });
  insertMilestone({
    id: MILESTONE_ID,
    project_id: PROJECT,
    name: 'M1',
    source_id: 'notion-db-m1',
    canonical_short_id: 'M1',
    display_order: 0,
  });

  filedFields = {};
  backend = new AuditingTaskBackend(makeFakeInnerBackend(filedFields), PROJECT);
  vi.mocked(getTaskBackend).mockReturnValue(backend);
});

describe('POST /api/milestones/:project/flaky-investigation', () => {
  it('creates exactly one Investigation task at Backlog covering both tests, links both tracking rows, and clears both on Done', async () => {
    insertRollupRow('tests.unit.test_a', 'test_a');
    insertRollupRow('tests.unit.test_b', 'test_b');

    const res = await request(makeApp())
      .post(`/api/milestones/${PROJECT}/flaky-investigation`)
      .send({
        testIds: ['tests.unit.test_a', 'tests.unit.test_b'],
        milestoneId: MILESTONE_ID,
      });

    expect(res.status).toBe(200);
    const taskId = res.body.taskId as string;
    expect(taskId).toMatch(/^notion:filed-investigation-/);

    expect(filedFields.current?.body).toContain('tests.unit.test_a');
    expect(filedFields.current?.body).toContain('tests.unit.test_b');
    expect(filedFields.current?.type).toBe('🔎 Investigation');

    const trackingRows = db
      .prepare(`SELECT * FROM flaky_remediation_tracking ORDER BY test_id`)
      .all() as Array<{
      test_id: string;
      remediation_task_id: string;
      remediation_task_open: number;
    }>;
    expect(trackingRows).toHaveLength(2);
    for (const row of trackingRows) {
      expect(row.remediation_task_id).toBe(taskId);
      expect(row.remediation_task_open).toBe(1);
    }

    // Marking the filed task Done via the real AuditingTaskBackend.updateStatus
    // must clear both linked tracking rows — no PR-merge event exists for a
    // PR-less Investigation task, so this generic wiring is the only path.
    await backend.updateStatus(taskId, '✅ Done');

    const closedRows = db
      .prepare(`SELECT * FROM flaky_remediation_tracking ORDER BY test_id`)
      .all() as Array<{ remediation_task_open: number }>;
    expect(closedRows).toHaveLength(2);
    for (const row of closedRows) {
      expect(row.remediation_task_open).toBe(0);
    }
  });

  it('rejects a test_id not currently flagged flaky with 409, filing nothing', async () => {
    insertRollupRow('tests.unit.test_a', 'test_a');

    const res = await request(makeApp())
      .post(`/api/milestones/${PROJECT}/flaky-investigation`)
      .send({
        testIds: ['tests.unit.test_a', 'tests.unit.test_not_flagged'],
        milestoneId: MILESTONE_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('not-flagged-flaky');

    const trackingRows = db
      .prepare(`SELECT * FROM flaky_remediation_tracking`)
      .all();
    expect(trackingRows).toHaveLength(0);
  });

  it('rejects an empty testIds array with 400', async () => {
    const res = await request(makeApp())
      .post(`/api/milestones/${PROJECT}/flaky-investigation`)
      .send({ testIds: [], milestoneId: MILESTONE_ID });

    expect(res.status).toBe(400);
  });
});
