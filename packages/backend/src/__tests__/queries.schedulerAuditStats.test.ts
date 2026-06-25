import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { getSchedulerAuditStats, insertSchedulerAudit } from '../db/queries.js';
import { db } from '../db/db.js';

function insertAudit(
  job: string,
  status: 'ok' | 'failed' | 'skipped',
  startedAt: string,
  durationMs = 100,
) {
  insertSchedulerAudit({
    job,
    status,
    started_at: startedAt,
    completed_at: startedAt,
    duration_ms: durationMs,
  });
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

beforeEach(() => {
  (db as import('better-sqlite3').Database)
    .prepare('DELETE FROM scheduler_audit')
    .run();
});

describe('getSchedulerAuditStats', () => {
  it('returns empty map when no audit rows exist', () => {
    const stats = getSchedulerAuditStats();
    expect(stats.size).toBe(0);
  });

  it('backfills lastDurationMs from the most recent non-skipped row', () => {
    insertAudit('archiver', 'ok', ago(10_000), 312);
    insertAudit('archiver', 'ok', ago(5_000), 500);
    const stats = getSchedulerAuditStats();
    expect(stats.get('archiver')?.lastDurationMs).toBe(500);
  });

  it('uses most recent ok/failed row, not a newer skipped row, for lastDurationMs', () => {
    insertAudit('archiver', 'ok', ago(10_000), 200);
    insertAudit('archiver', 'skipped', ago(1_000), 0);
    const stats = getSchedulerAuditStats();
    expect(stats.get('archiver')?.lastDurationMs).toBe(200);
  });

  it('counts ok+failed in last 24h for runCount24h, excludes skipped', () => {
    insertAudit('watcher', 'ok', ago(1_000));
    insertAudit('watcher', 'failed', ago(2_000));
    insertAudit('watcher', 'skipped', ago(3_000));
    const stats = getSchedulerAuditStats();
    expect(stats.get('watcher')?.runCount24h).toBe(2);
  });

  it('counts only failed rows in last 24h for errorCount24h', () => {
    insertAudit('watcher', 'ok', ago(1_000));
    insertAudit('watcher', 'failed', ago(2_000));
    insertAudit('watcher', 'failed', ago(3_000));
    const stats = getSchedulerAuditStats();
    expect(stats.get('watcher')?.errorCount24h).toBe(2);
  });

  it('excludes rows older than 24h from runCount24h and errorCount24h', () => {
    const twoDaysAgo = ago(2 * 24 * 60 * 60 * 1000);
    insertAudit('checker', 'ok', twoDaysAgo, 100);
    insertAudit('checker', 'failed', twoDaysAgo, 100);
    const stats = getSchedulerAuditStats();
    const entry = stats.get('checker');
    expect(entry?.runCount24h).toBe(0);
    expect(entry?.errorCount24h).toBe(0);
    // But lastDurationMs still comes from the old row
    expect(entry?.lastDurationMs).toBe(100);
  });

  it('reports per-job stats independently', () => {
    insertAudit('jobA', 'ok', ago(1_000), 111);
    insertAudit('jobA', 'failed', ago(2_000), 222);
    insertAudit('jobB', 'ok', ago(1_000), 333);
    const stats = getSchedulerAuditStats();
    expect(stats.get('jobA')?.runCount24h).toBe(2);
    expect(stats.get('jobA')?.errorCount24h).toBe(1);
    expect(stats.get('jobB')?.runCount24h).toBe(1);
    expect(stats.get('jobB')?.errorCount24h).toBe(0);
    expect(stats.get('jobB')?.lastDurationMs).toBe(333);
  });
});
