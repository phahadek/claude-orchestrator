import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  insertSchedulerAudit: vi.fn(),
}));

import { insertSchedulerAudit } from '../db/queries.js';
import { Scheduler } from '../orchestration/Scheduler.js';

const mockInsertAudit = vi.mocked(insertSchedulerAudit);

beforeEach(() => {
  vi.clearAllMocks();
});

// Real (non-faked) timers throughout this file — measuring event-loop
// blocking requires the actual wall clock / libuv loop, not sinon fake time.
function busyWaitMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* deliberately spin the CPU to hold the event loop */
  }
}

function makeScheduler() {
  const scheduler = new Scheduler();
  scheduler.setBroadcast(() => {});
  return scheduler;
}

describe('Scheduler event-loop blocking instrumentation', () => {
  it('records event_loop_blocked_ms ~= N for a job that busy-blocks synchronously for N ms', async () => {
    const scheduler = makeScheduler();
    scheduler.register({
      name: 'blocker',
      intervalMs: 60_000,
      run: async () => {
        busyWaitMs(80);
      },
    });
    scheduler.start();
    await scheduler.triggerNow('blocker');

    expect(mockInsertAudit).toHaveBeenCalledOnce();
    const row = mockInsertAudit.mock.calls[0][0];
    expect(row.status).toBe('ok');
    expect(row.event_loop_blocked_ms).toBeGreaterThanOrEqual(60);
    // duration_ms retains its existing wall-clock semantics/value.
    expect(row.duration_ms).toBeGreaterThanOrEqual(60);

    await scheduler.stopAll();
  }, 20000);

  it('distinguishes a blocker from a victim: a busy-blocking job records much more event_loop_blocked_ms than a job that only awaits a timer for the same wall-clock duration', async () => {
    // A single absolute near-zero threshold on event_loop_blocked_ms is
    // flaky under a shared, parallel test runner — other concurrently
    // running test files keep the real event loop busy. Comparing the
    // "victim" (timer-only) job against a "blocker" (busy-block) job run in
    // the same test proves the instrumentation separates cause from effect
    // regardless of ambient loop noise.
    const scheduler = makeScheduler();
    const N = 150;
    scheduler.register({
      name: 'blocker2',
      intervalMs: 60_000,
      run: async () => {
        busyWaitMs(N);
      },
    });
    scheduler.register({
      name: 'waiter',
      intervalMs: 60_000,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, N));
      },
    });
    scheduler.start();
    await scheduler.triggerNow('blocker2');
    await scheduler.triggerNow('waiter');

    expect(mockInsertAudit).toHaveBeenCalledTimes(2);
    const blockerRow = mockInsertAudit.mock.calls[0][0];
    const waiterRow = mockInsertAudit.mock.calls[1][0];

    // duration_ms (wall-clock) is approximately N for both — that's the
    // number today's scheduler_audit already records, and it alone cannot
    // tell these two jobs apart.
    expect(blockerRow.duration_ms).toBeGreaterThanOrEqual(N * 0.6);
    expect(waiterRow.duration_ms).toBeGreaterThanOrEqual(N * 0.6);

    // event_loop_blocked_ms is what tells them apart: the blocker held the
    // loop for most of N; the waiter, which never ran synchronous work,
    // held it for only a small fraction of N.
    expect(blockerRow.event_loop_blocked_ms).toBeGreaterThanOrEqual(N * 0.6);
    expect(waiterRow.event_loop_blocked_ms).toBeLessThan(N * 0.5);
    expect(waiterRow.event_loop_blocked_ms).toBeLessThan(
      blockerRow.event_loop_blocked_ms,
    );

    await scheduler.stopAll();
  }, 20000);

  it('still records event_loop_blocked_ms alongside status=failed when run() throws', async () => {
    const scheduler = makeScheduler();
    scheduler.register({
      name: 'failer',
      intervalMs: 60_000,
      run: async () => {
        busyWaitMs(40);
        throw new Error('boom');
      },
    });
    scheduler.start();
    await scheduler.triggerNow('failer');

    expect(mockInsertAudit).toHaveBeenCalledOnce();
    const row = mockInsertAudit.mock.calls[0][0];
    expect(row.status).toBe('failed');
    expect(typeof row.event_loop_blocked_ms).toBe('number');
    expect(row.event_loop_blocked_ms).toBeGreaterThanOrEqual(20);

    await scheduler.stopAll();
  });
});
