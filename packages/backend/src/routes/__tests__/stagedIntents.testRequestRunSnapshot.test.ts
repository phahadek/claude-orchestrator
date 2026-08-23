/**
 * GET /api/test-request-runs is the on-load REST counterpart to the
 * test_request_run_status WS broadcast (testRequestLane.ts) — a client that
 * loads or reconnects mid-run needs a snapshot REST alone can answer,
 * mirroring the task_updated / staged_intent_changed REST-truth pattern.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertTestRequestRun, completeTestRequestRun } from '../../db/queries';
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
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('GET /api/test-request-runs', () => {
  it('rejects a request missing projectId or contentHash', async () => {
    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/test-request-runs')
      .query({ projectId: 'proj-1' });
    expect(res.status).toBe(400);
  });

  it('returns null when no run has ever recorded for the pair', async () => {
    const agent = supertest(makeApp());
    const res = await agent
      .get('/api/test-request-runs')
      .query({ projectId: 'proj-1', contentHash: 'hash-none' });
    expect(res.status).toBe(200);
    expect(res.body.run).toBeNull();
  });

  it('returns a running snapshot before completion', async () => {
    insertTestRequestRun('run-1', 'proj-1', 'hash-a');
    const agent = supertest(makeApp());

    const res = await agent
      .get('/api/test-request-runs')
      .query({ projectId: 'proj-1', contentHash: 'hash-a' });

    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({
      runId: 'run-1',
      projectId: 'proj-1',
      contentHash: 'hash-a',
      status: 'running',
    });
  });

  it('returns a failed-with-cause snapshot carrying the output once completed', async () => {
    insertTestRequestRun('run-2', 'proj-1', 'hash-b');
    completeTestRequestRun('run-2', 'failed', 'boom');
    const agent = supertest(makeApp());

    const res = await agent
      .get('/api/test-request-runs')
      .query({ projectId: 'proj-1', contentHash: 'hash-b' });

    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({
      runId: 'run-2',
      status: 'failed-with-cause',
      output: 'boom',
    });
  });

  it('returns a passed snapshot without an output field once completed', async () => {
    insertTestRequestRun('run-3', 'proj-1', 'hash-c');
    completeTestRequestRun('run-3', 'passed', 'ok');
    const agent = supertest(makeApp());

    const res = await agent
      .get('/api/test-request-runs')
      .query({ projectId: 'proj-1', contentHash: 'hash-c' });

    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({
      runId: 'run-3',
      status: 'passed',
    });
    expect(res.body.run.output).toBeUndefined();
  });
});
