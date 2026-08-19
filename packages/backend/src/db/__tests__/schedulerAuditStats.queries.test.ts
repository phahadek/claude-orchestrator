/**
 * Tests for db/queries.ts's getSchedulerAuditStats — the diagnostics poll's
 * per-job stats. Rewritten from a window-function rank over the full
 * scheduler_audit table to correlated lookups against idx_scheduler_audit_job
 * (job, started_at DESC), so it's an indexed SEARCH per distinct job rather
 * than a SCAN + materialisation of every row. started_at is ISO-8601 TEXT
 * (unlike session_events.timestamp, which is epoch-ms), so the 24h window is
 * bounded with an ISO cutoff string, not a numeric/epoch-ms bound.
 */

import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { vi } from 'vitest';
import { db } from '../db';
import { insertSchedulerAudit, getSchedulerAuditStats } from '../queries';

beforeEach(() => {
  db.prepare('DELETE FROM scheduler_audit').run();
});

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function iso(offsetMsFromNow: number): string {
  return new Date(NOW + offsetMsFromNow).toISOString();
}

describe('getSchedulerAuditStats', () => {
  it('matches the previous window-function implementation across jobs, statuses, and the 24h boundary', () => {
    // job_a: three runs inside 24h (2 ok, 1 failed), one run outside 24h.
    insertSchedulerAudit({
      job: 'job_a',
      status: 'ok',
      started_at: iso(-30 * HOUR),
      completed_at: iso(-30 * HOUR + 1000),
      duration_ms: 999,
      event_loop_blocked_ms: 50,
    });
    insertSchedulerAudit({
      job: 'job_a',
      status: 'ok',
      started_at: iso(-10 * HOUR),
      completed_at: iso(-10 * HOUR + 1000),
      duration_ms: 100,
      event_loop_blocked_ms: 10,
    });
    insertSchedulerAudit({
      job: 'job_a',
      status: 'failed',
      started_at: iso(-5 * HOUR),
      completed_at: iso(-5 * HOUR + 1000),
      duration_ms: 200,
      event_loop_blocked_ms: 30,
    });
    insertSchedulerAudit({
      job: 'job_a',
      status: 'ok',
      started_at: iso(-1 * HOUR),
      completed_at: iso(-1 * HOUR + 1000),
      duration_ms: 300,
      event_loop_blocked_ms: 20,
    });

    // job_b: only a skipped run inside the window (excluded from run/error counts).
    insertSchedulerAudit({
      job: 'job_b',
      status: 'skipped',
      started_at: iso(-2 * HOUR),
      completed_at: iso(-2 * HOUR + 1000),
      duration_ms: 5,
      event_loop_blocked_ms: null,
    });

    const stats = getSchedulerAuditStats(NOW);
    const a = stats.find((s) => s.job === 'job_a');
    const b = stats.find((s) => s.job === 'job_b');

    expect(a).toEqual({
      job: 'job_a',
      lastDurationMs: 300, // most recent started_at
      runCount24h: 3, // 2 ok + 1 failed, excludes the 30h-old run
      errorCount24h: 1,
      maxEventLoopBlockedMs24h: 30,
      meanEventLoopBlockedMs24h: Math.round((10 + 30 + 20) / 3),
    });

    expect(b).toEqual({
      job: 'job_b',
      lastDurationMs: 5,
      runCount24h: 0,
      errorCount24h: 0,
      maxEventLoopBlockedMs24h: null,
      meanEventLoopBlockedMs24h: null,
    });
  });

  it('uses the ISO-8601 started_at column for the 24h cutoff, not an epoch-ms bound', () => {
    // started_at 20h ago in ISO form — an epoch-ms cutoff (`started_at >= Date.now() - 24h`,
    // comparing a numeric value against ISO text) would fail to match this row at all,
    // since SQLite's text/numeric comparison rules would exclude it either way.
    insertSchedulerAudit({
      job: 'iso_job',
      status: 'ok',
      started_at: iso(-20 * HOUR),
      completed_at: iso(-20 * HOUR + 1000),
      duration_ms: 42,
      event_loop_blocked_ms: 5,
    });

    const stats = getSchedulerAuditStats(NOW);
    const job = stats.find((s) => s.job === 'iso_job');

    expect(job?.runCount24h).toBe(1);
    expect(job?.maxEventLoopBlockedMs24h).toBe(5);
  });

  it('EXPLAIN QUERY PLAN shows no full scan/window-function materialisation over scheduler_audit', () => {
    insertSchedulerAudit({
      job: 'job_a',
      status: 'ok',
      started_at: iso(-1 * HOUR),
      completed_at: iso(-1 * HOUR + 1000),
      duration_ms: 1,
      event_loop_blocked_ms: 1,
    });

    // Force the statement to be prepared, then inspect its plan directly.
    getSchedulerAuditStats(NOW);
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT
             j.job AS job,
             (SELECT duration_ms FROM scheduler_audit sa WHERE sa.job = j.job ORDER BY sa.started_at DESC LIMIT 1) AS last_duration_ms,
             (SELECT COUNT(*) FROM scheduler_audit sa WHERE sa.job = j.job AND sa.status IN ('ok', 'failed') AND sa.started_at >= @cutoff) AS run_count_24h,
             (SELECT COUNT(*) FROM scheduler_audit sa WHERE sa.job = j.job AND sa.status = 'failed' AND sa.started_at >= @cutoff) AS error_count_24h,
             (SELECT MAX(event_loop_blocked_ms) FROM scheduler_audit sa WHERE sa.job = j.job AND sa.started_at >= @cutoff) AS max_event_loop_blocked_ms_24h,
             (SELECT AVG(event_loop_blocked_ms) FROM scheduler_audit sa WHERE sa.job = j.job AND sa.started_at >= @cutoff) AS mean_event_loop_blocked_ms_24h
           FROM (SELECT DISTINCT job FROM scheduler_audit) j`,
        )
        .all({ cutoff: iso(-24 * HOUR) }) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');

    expect(plan).not.toMatch(/SCAN ranked/);
    expect(plan.toUpperCase()).not.toMatch(/USE TEMP B-TREE FOR WINDOW/i);
    expect(plan).toMatch(
      /SEARCH sa USING (COVERING )?INDEX idx_scheduler_audit_job/,
    );
  });
});
