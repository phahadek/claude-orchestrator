/**
 * Tests for db/queries.ts's getJobBootSchedule — the durable-last-run seed
 * used by the retention-sweep jobs (scheduler_audit_pruner,
 * session_events_pruner) so a restart doesn't discard progress toward the
 * next fire. started_at is ISO-8601 TEXT.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db';
import { insertSchedulerAudit, getJobBootSchedule, isJobOverdue } from '../queries';

beforeEach(() => {
  db.prepare('DELETE FROM scheduler_audit').run();
});

const NOW = Date.parse('2026-08-21T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const INTERVAL_MS = 24 * HOUR;

describe('getJobBootSchedule', () => {
  it('fires immediately when the job has never run', () => {
    const schedule = getJobBootSchedule('some_job', INTERVAL_MS, NOW);
    expect(schedule.runOnBoot).toBe(true);
    expect(schedule.initialDelayMs).toBe(0);
  });

  it('fires immediately when the durable last run is older than intervalMs', () => {
    insertSchedulerAudit({
      job: 'overdue_job',
      status: 'ok',
      started_at: new Date(NOW - 30 * HOUR).toISOString(),
      completed_at: new Date(NOW - 30 * HOUR + 1000).toISOString(),
      duration_ms: 1000,
      event_loop_blocked_ms: 0,
      items_processed: 1,
      error: null,
    });
    const schedule = getJobBootSchedule('overdue_job', INTERVAL_MS, NOW);
    expect(schedule.runOnBoot).toBe(true);
    expect(schedule.initialDelayMs).toBe(0);
    expect(isJobOverdue('overdue_job', INTERVAL_MS, NOW)).toBe(true);
  });

  it('seeds the first fire at last_run + intervalMs when registered part-way through the interval', () => {
    // Last run was 21h ago, on a 24h interval — 3h still remain.
    const lastRunAt = NOW - 21 * HOUR;
    insertSchedulerAudit({
      job: 'partial_job',
      status: 'ok',
      started_at: new Date(lastRunAt).toISOString(),
      completed_at: new Date(lastRunAt + 1000).toISOString(),
      duration_ms: 1000,
      event_loop_blocked_ms: 0,
      items_processed: 1,
      error: null,
    });
    const schedule = getJobBootSchedule('partial_job', INTERVAL_MS, NOW);
    expect(schedule.runOnBoot).toBe(false);
    expect(schedule.initialDelayMs).toBe(lastRunAt + INTERVAL_MS - NOW);
    expect(schedule.initialDelayMs).toBe(3 * HOUR);
    expect(isJobOverdue('partial_job', INTERVAL_MS, NOW)).toBe(false);
  });

  it('ignores non-ok runs when finding the last durable run', () => {
    insertSchedulerAudit({
      job: 'mixed_job',
      status: 'ok',
      started_at: new Date(NOW - 20 * HOUR).toISOString(),
      completed_at: new Date(NOW - 20 * HOUR + 1000).toISOString(),
      duration_ms: 1000,
      event_loop_blocked_ms: 0,
      items_processed: 1,
      error: null,
    });
    insertSchedulerAudit({
      job: 'mixed_job',
      status: 'failed',
      started_at: new Date(NOW - 1 * HOUR).toISOString(),
      completed_at: new Date(NOW - 1 * HOUR + 1000).toISOString(),
      duration_ms: 1000,
      event_loop_blocked_ms: 0,
      items_processed: 0,
      error: 'boom',
    });
    const schedule = getJobBootSchedule('mixed_job', INTERVAL_MS, NOW);
    expect(schedule.runOnBoot).toBe(false);
    expect(schedule.initialDelayMs).toBe(4 * HOUR);
  });
});
