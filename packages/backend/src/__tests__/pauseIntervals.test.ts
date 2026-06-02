import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../../test/helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

import { db } from '../db/db.js';
import {
  insertPauseInterval,
  closePauseInterval,
  getPauseIntervalsBySession,
  getTotalPausedMs,
} from '../db/queries.js';

function insertSession(sessionId: string, endedAt?: number | null): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions (session_id, status, started_at, ended_at)
     VALUES (?, 'running', ?, ?)`,
  ).run(sessionId, Date.now(), endedAt ?? null);
}

beforeEach(() => {
  db.prepare('DELETE FROM session_pause_intervals').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('insertPauseInterval', () => {
  it('inserts an open interval with resumed_at NULL', () => {
    insertSession('sess-1');
    insertPauseInterval('sess-1', 'rate_limit');
    const intervals = getPauseIntervalsBySession('sess-1');
    expect(intervals).toHaveLength(1);
    expect(intervals[0].session_id).toBe('sess-1');
    expect(intervals[0].pause_reason).toBe('rate_limit');
    expect(intervals[0].paused_at).toBeGreaterThan(0);
    expect(intervals[0].resumed_at).toBeNull();
  });

  it('inserts multiple open intervals for different pause reasons', () => {
    insertSession('sess-2');
    insertPauseInterval('sess-2', 'rate_limit');
    insertPauseInterval('sess-2', 'stuck_timeout');
    const intervals = getPauseIntervalsBySession('sess-2');
    expect(intervals).toHaveLength(2);
    expect(intervals.map((i) => i.pause_reason)).toEqual([
      'rate_limit',
      'stuck_timeout',
    ]);
  });
});

describe('closePauseInterval', () => {
  it('sets resumed_at on the most recent open interval', () => {
    insertSession('sess-3');
    insertPauseInterval('sess-3', 'rate_limit');
    closePauseInterval('sess-3');
    const intervals = getPauseIntervalsBySession('sess-3');
    expect(intervals[0].resumed_at).not.toBeNull();
    expect(intervals[0].resumed_at).toBeGreaterThanOrEqual(
      intervals[0].paused_at,
    );
  });

  it('does not close already-closed intervals on second call', () => {
    insertSession('sess-4');
    insertPauseInterval('sess-4', 'rate_limit');
    closePauseInterval('sess-4');
    const firstResume = getPauseIntervalsBySession('sess-4')[0].resumed_at!;

    // Second close should be a no-op (no open intervals remain)
    closePauseInterval('sess-4');
    const secondResume = getPauseIntervalsBySession('sess-4')[0].resumed_at!;
    expect(secondResume).toBe(firstResume);
  });

  it('closes only the most recent open interval when multiple exist', () => {
    insertSession('sess-5');
    insertPauseInterval('sess-5', 'rate_limit');
    insertPauseInterval('sess-5', 'rate_limit');
    closePauseInterval('sess-5');

    const intervals = getPauseIntervalsBySession('sess-5');
    const open = intervals.filter((i) => i.resumed_at === null);
    const closed = intervals.filter((i) => i.resumed_at !== null);
    expect(open).toHaveLength(1);
    expect(closed).toHaveLength(1);
    // The closed one is the most recently inserted
    expect(closed[0].id).toBeGreaterThan(open[0].id);
  });
});

describe('getTotalPausedMs', () => {
  it('returns 0 when no intervals exist', () => {
    insertSession('sess-6');
    expect(getTotalPausedMs('sess-6')).toBe(0);
  });

  it('sums completed pause durations for a rate_limit pause/resume cycle', async () => {
    insertSession('sess-7');
    const before = Date.now();
    insertPauseInterval('sess-7', 'rate_limit');
    await new Promise((r) => setTimeout(r, 20));
    closePauseInterval('sess-7');
    const total = getTotalPausedMs('sess-7');
    expect(total).toBeGreaterThanOrEqual(20);
    expect(total).toBeLessThan(Date.now() - before + 100);
  });

  it('sums multiple completed pause/resume cycles', async () => {
    insertSession('sess-8');
    // First cycle
    insertPauseInterval('sess-8', 'rate_limit');
    await new Promise((r) => setTimeout(r, 20));
    closePauseInterval('sess-8');
    // Second cycle
    insertPauseInterval('sess-8', 'stuck_timeout');
    await new Promise((r) => setTimeout(r, 20));
    closePauseInterval('sess-8');
    const total = getTotalPausedMs('sess-8');
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it('uses endedAt as implicit resume for open intervals (session ending while paused)', async () => {
    const startedAt = Date.now();
    insertPauseInterval('sess-9', 'api_overloaded');
    await new Promise((r) => setTimeout(r, 30));
    const endedAt = Date.now();
    // Session ended while paused — pass endedAt as implicit resume
    const total = getTotalPausedMs('sess-9', endedAt);
    expect(total).toBeGreaterThanOrEqual(30);
    expect(total).toBeLessThanOrEqual(endedAt - startedAt + 100);
  });

  it('ignores open intervals when no endedAt is passed (uses now)', async () => {
    insertSession('sess-10');
    insertPauseInterval('sess-10', 'rate_limit');
    await new Promise((r) => setTimeout(r, 10));
    const total = getTotalPausedMs('sess-10');
    // With implicit now, open intervals contribute their current elapsed time
    expect(total).toBeGreaterThanOrEqual(10);
  });
});

describe('rate_limit pause/resume full cycle', () => {
  it('active_wall_clock_ms subtracts paused time from wall_clock', async () => {
    const startedAt = Date.now();
    insertSession('sess-11', null);
    insertPauseInterval('sess-11', 'rate_limit');
    await new Promise((r) => setTimeout(r, 30));
    closePauseInterval('sess-11');
    await new Promise((r) => setTimeout(r, 10));
    const endedAt = Date.now();

    const wall_clock_ms = endedAt - startedAt;
    const total_paused_ms = getTotalPausedMs('sess-11', endedAt);
    const active_wall_clock_ms = Math.max(0, wall_clock_ms - total_paused_ms);

    expect(total_paused_ms).toBeGreaterThanOrEqual(30);
    expect(active_wall_clock_ms).toBeLessThan(wall_clock_ms);
    expect(active_wall_clock_ms).toBeGreaterThan(0);
  });
});
