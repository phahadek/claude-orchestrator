import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/queries.js', () => ({
  insertSchedulerAudit: vi.fn(),
}));

import {
  createDiagnosticsRouter,
  setScheduler,
} from '../routes/diagnostics.js';
import { Scheduler } from '../orchestration/Scheduler.js';

function makeApp(scheduler: Scheduler) {
  setScheduler(scheduler);
  const app = express();
  app.use(express.json());
  app.use('/api/diagnostics', createDiagnosticsRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/diagnostics/scheduler', () => {
  it('returns 200 with job status array', async () => {
    const scheduler = new Scheduler();
    scheduler.register({
      name: 'test_job',
      intervalMs: 1000,
      run: async () => {},
    });
    const app = makeApp(scheduler);
    const res = await request(app).get('/api/diagnostics/scheduler');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({
      name: 'test_job',
      running: false,
      lastRunAt: null,
      lastStatus: null,
    });
  });

  it('returns empty array when no jobs registered', async () => {
    const scheduler = new Scheduler();
    const app = makeApp(scheduler);
    const res = await request(app).get('/api/diagnostics/scheduler');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/diagnostics/scheduler/:name/trigger', () => {
  it('returns 202 with trigger receipt and fires job', async () => {
    const scheduler = new Scheduler();
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({ name: 'pilot_job', intervalMs: 60_000, run: runFn });
    const app = makeApp(scheduler);

    const res = await request(app).post(
      '/api/diagnostics/scheduler/pilot_job/trigger',
    );
    expect(res.status).toBe(202);
    expect(res.body.job).toBe('pilot_job');
    expect(typeof res.body.triggered_at).toBe('string');

    // Allow the triggered job to run
    await new Promise((r) => setTimeout(r, 20));
    expect(runFn).toHaveBeenCalledOnce();
  });

  it('returns 202 even for unknown job name (fire-and-forget, errors logged)', async () => {
    const scheduler = new Scheduler();
    const app = makeApp(scheduler);

    const res = await request(app).post(
      '/api/diagnostics/scheduler/does_not_exist/trigger',
    );
    // The trigger is fire-and-forget; the route returns 202 before the error resolves
    expect(res.status).toBe(202);
  });
});
