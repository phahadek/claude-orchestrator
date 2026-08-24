/**
 * GET /api/test-request-runs/project — the project-scope run-history feed
 * the 'tests' TopView destination (frontend follow-on task) consumes: every
 * test_request_runs row for a project, running/queued/finished alike,
 * newest-first, annotated with producer and per-outcome test counts where
 * extraction has already run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  ingestTestRunResultsTx,
} from '../../db/queries';
import {
  createStagedIntentsRouter,
  setStagedIntentBroadcast,
} from '../stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  setStagedIntentBroadcast(() => {});
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('GET /api/test-request-runs/project', () => {
  it('rejects a request missing projectId', async () => {
    const agent = supertest(makeApp());
    const res = await agent.get('/api/test-request-runs/project');
    expect(res.status).toBe(400);
  });

  it('returns running, queued, and finished runs for a project, newest-first, with producer and outcome-count fields populated where available', async () => {
    // Queued: inserted at admission, before its permit was acquired.
    insertTestRequestRun(
      'run-queued',
      'proj-1',
      'hash-queued',
      null,
      1000,
      null,
      null,
      'session_request',
      'queued',
    );
    // Running: currently executing.
    insertTestRequestRun(
      'run-running',
      'proj-1',
      'hash-running',
      'session-1',
      2000,
      0,
      'pr_pipeline',
      'pr_gate',
    );
    // Finished: passed, with an extracted per-outcome breakdown.
    insertTestRequestRun(
      'run-finished',
      'proj-1',
      'hash-finished',
      null,
      3000,
      0,
      'base_health_probe',
      'base_health',
    );
    completeTestRequestRun('run-finished', 'passed', 'ok');
    ingestTestRunResultsTx(
      'run-finished',
      'proj-1',
      [
        { test_id: 't-1', name: 'test one', outcome: 'passed', duration_ms: 5 },
        { test_id: 't-2', name: 'test two', outcome: 'failed', duration_ms: 7 },
      ],
      0,
      false,
      false,
    );
    // A different project's run must never appear in proj-1's feed.
    insertTestRequestRun(
      'run-other-project',
      'proj-2',
      'hash-other',
      null,
      500,
    );

    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/test-request-runs/project')
      .query({ projectId: 'proj-1' });

    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual([
      'run-finished',
      'run-running',
      'run-queued',
    ]);

    const queued = res.body.runs.find(
      (r: { id: string }) => r.id === 'run-queued',
    );
    expect(queued).toMatchObject({
      state: 'queued',
      producer: 'session_request',
      outcome: 'queued',
      outcomeCounts: null,
    });

    const running = res.body.runs.find(
      (r: { id: string }) => r.id === 'run-running',
    );
    expect(running).toMatchObject({
      state: 'running',
      producer: 'pr_gate',
      runOrigin: 'pr_pipeline',
      outcome: 'running',
      outcomeCounts: null,
    });

    const finished = res.body.runs.find(
      (r: { id: string }) => r.id === 'run-finished',
    );
    expect(finished).toMatchObject({
      state: 'passed',
      producer: 'base_health',
      runOrigin: 'base_health_probe',
      outcome: 'passed',
      outcomeCounts: {
        passed: 1,
        failed: 1,
        skipped: 0,
        error: 0,
        other: 0,
        total: 2,
      },
    });
  });
});
