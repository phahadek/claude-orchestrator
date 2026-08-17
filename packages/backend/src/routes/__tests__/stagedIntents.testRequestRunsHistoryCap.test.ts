/**
 * GET /api/test-request-runs/history must never let a single run's
 * `testResults` grow unbounded — see db/queries.ts's
 * TEST_RUN_RESULTS_PER_RUN_CAP. Before this fix, a run with thousands of
 * test_run_results rows was fetched and JSON-serialized in full inside one
 * synchronous request, blocking the event loop (see the task spec commit
 * range 37cde6c8..5b9e0cb1).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter } from '../stagedIntents';
import {
  insertSession,
  insertTestRequestRun,
  completeTestRequestRun,
  insertTestRunResults,
  TEST_RUN_RESULTS_PER_RUN_CAP,
} from '../../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

const PROJECT_ID = 'proj-history-cap';
const SESSION_ID = 'session-history-cap';

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_test_request_cycles').run();

  insertSession({
    session_id: SESSION_ID,
    task_id: 'task-1',
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: Date.now(),
  });
});

describe('GET /api/test-request-runs/history — per-run result cap', () => {
  it('caps testResults per run and reports truncation regardless of how many rows exist', async () => {
    const runId = 'run-1';
    insertTestRequestRun(runId, PROJECT_ID, 'hash-1', SESSION_ID, Date.now());
    const rowCount = TEST_RUN_RESULTS_PER_RUN_CAP + 300;
    const tests = Array.from({ length: rowCount }, (_, i) => ({
      test_id: `test-${i}`,
      name: `test-${i}`,
      outcome: 'passed',
      duration_ms: 5,
    }));
    insertTestRunResults(runId, tests, 0, false);
    completeTestRequestRun(runId, 'passed', 'ok');

    const app = buildApp();
    const res = await supertest(app)
      .get('/api/test-request-runs/history')
      .query({ projectId: PROJECT_ID, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    const run = res.body.runs[0];
    expect(run.testResults.length).toBe(TEST_RUN_RESULTS_PER_RUN_CAP);
    expect(run.totalTestResultCount).toBe(rowCount);
    expect(run.testResultsTruncated).toBe(true);
  });

  it('does not report truncation when a run has fewer rows than the cap', async () => {
    const runId = 'run-2';
    insertTestRequestRun(runId, PROJECT_ID, 'hash-2', SESSION_ID, Date.now());
    insertTestRunResults(
      runId,
      [
        {
          test_id: 'test-a',
          name: 'test-a',
          outcome: 'passed',
          duration_ms: 5,
        },
      ],
      0,
      false,
    );
    completeTestRequestRun(runId, 'passed', 'ok');

    const app = buildApp();
    const res = await supertest(app)
      .get('/api/test-request-runs/history')
      .query({ projectId: PROJECT_ID, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    const run = res.body.runs[0];
    expect(run.testResults.length).toBe(1);
    expect(run.totalTestResultCount).toBe(1);
    expect(run.testResultsTruncated).toBe(false);
  });
});
