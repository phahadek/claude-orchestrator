/**
 * Integration-level test for the scheduler-audit read path: seeds real
 * scheduler_audit rows (via insertSchedulerAudit against an isolated
 * in-memory DB) and asserts GET /api/diagnostics/scheduler returns the
 * per-job event-loop-blocking-time aggregates computed by the real
 * getSchedulerAuditStats query — not a mocked stand-in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../db/db', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  createDiagnosticsRouter,
  setScheduler,
} from '../routes/diagnostics.js';
import { Scheduler } from '../orchestration/Scheduler.js';
import { insertSchedulerAudit } from '../db/queries.js';

function makeApp(scheduler: Scheduler) {
  setScheduler(scheduler);
  const app = express();
  app.use(express.json());
  app.use('/api/diagnostics', createDiagnosticsRouter());
  return app;
}

function isoMinutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

describe('GET /api/diagnostics/scheduler — event-loop-blocking aggregates (seeded fixture)', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler();
    scheduler.register({
      name: 'gate_verification_reconciler',
      intervalMs: 60_000,
      run: async () => {},
    });

    insertSchedulerAudit({
      job: 'gate_verification_reconciler',
      status: 'ok',
      started_at: isoMinutesAgo(120),
      completed_at: isoMinutesAgo(120),
      duration_ms: 99_500,
      event_loop_blocked_ms: 4_200,
    });
    insertSchedulerAudit({
      job: 'gate_verification_reconciler',
      status: 'ok',
      started_at: isoMinutesAgo(60),
      completed_at: isoMinutesAgo(60),
      duration_ms: 500,
      event_loop_blocked_ms: 20,
    });
    // Outside the 24h window — must not affect the aggregates.
    insertSchedulerAudit({
      job: 'gate_verification_reconciler',
      status: 'ok',
      started_at: isoMinutesAgo(60 * 48),
      completed_at: isoMinutesAgo(60 * 48),
      duration_ms: 100,
      event_loop_blocked_ms: 99_999,
    });
  });

  it('returns per-job max/mean event_loop_blocked_ms computed from real seeded rows', async () => {
    const app = makeApp(scheduler);
    const res = await supertest(app).get('/api/diagnostics/scheduler');
    expect(res.status).toBe(200);
    const job = res.body.jobs.find(
      (j: { name: string }) => j.name === 'gate_verification_reconciler',
    );
    expect(job).toBeDefined();
    expect(job.maxEventLoopBlockedMs24h).toBe(4200);
    expect(job.meanEventLoopBlockedMs24h).toBe(Math.round((4200 + 20) / 2));
    expect(job.runCount24h).toBe(2);
  });
});
