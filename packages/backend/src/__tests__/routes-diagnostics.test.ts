import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/queries.js', () => ({
  insertSchedulerAudit: vi.fn(),
  getSchedulerAuditStats: vi.fn(() => []),
}));

import {
  createDiagnosticsRouter,
  setScheduler,
} from '../routes/diagnostics.js';
import { Scheduler } from '../orchestration/Scheduler.js';
import { getSchedulerAuditStats } from '../db/queries.js';

const mockGetAuditStats = vi.mocked(getSchedulerAuditStats);

function makeApp(scheduler: Scheduler) {
  setScheduler(scheduler);
  const app = express();
  app.use(express.json());
  app.use('/api/diagnostics', createDiagnosticsRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuditStats.mockReturnValue([]);
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

  it('backfills lastDurationMs, runCount24h, errorCount24h from audit stats', async () => {
    mockGetAuditStats.mockReturnValue([
      { job: 'test_job', lastDurationMs: 1234, runCount24h: 5, errorCount24h: 1 },
    ]);
    const scheduler = new Scheduler();
    scheduler.register({ name: 'test_job', intervalMs: 1000, run: async () => {} });
    const app = makeApp(scheduler);
    const res = await request(app).get('/api/diagnostics/scheduler');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      name: 'test_job',
      lastDurationMs: 1234,
      runCount24h: 5,
      errorCount24h: 1,
    });
  });

  it('returns null/0 for audit fields when no audit data for a job', async () => {
    mockGetAuditStats.mockReturnValue([]);
    const scheduler = new Scheduler();
    scheduler.register({ name: 'new_job', intervalMs: 1000, run: async () => {} });
    const app = makeApp(scheduler);
    const res = await request(app).get('/api/diagnostics/scheduler');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      name: 'new_job',
      lastDurationMs: null,
      runCount24h: 0,
      errorCount24h: 0,
    });
  });

  it('handles multiple jobs with partial audit coverage', async () => {
    mockGetAuditStats.mockReturnValue([
      { job: 'job_a', lastDurationMs: 500, runCount24h: 3, errorCount24h: 0 },
    ]);
    const scheduler = new Scheduler();
    scheduler.register({ name: 'job_a', intervalMs: 1000, run: async () => {} });
    scheduler.register({ name: 'job_b', intervalMs: 1000, run: async () => {} });
    const app = makeApp(scheduler);
    const res = await request(app).get('/api/diagnostics/scheduler');
    expect(res.status).toBe(200);
    const a = res.body.find((j: { name: string }) => j.name === 'job_a');
    const b = res.body.find((j: { name: string }) => j.name === 'job_b');
    expect(a).toMatchObject({ lastDurationMs: 500, runCount24h: 3, errorCount24h: 0 });
    expect(b).toMatchObject({ lastDurationMs: null, runCount24h: 0, errorCount24h: 0 });
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
