import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { logger } from '../../logger';
import {
  EventLoopStallWatchdog,
  recordStallEvent,
  STALL_THRESHOLD_MS,
  type StallEvent,
} from '../EventLoopStallWatchdog';
import { attachWsLifecycleLogging } from '../../ws/connectionLifecycle';
import { Scheduler } from '../Scheduler';
import { insertProject } from '../../db/queries';
import { buildInvestigateDbSnapshot } from '../../investigation/investigateSnapshot';

const INTERVAL = 500;

function setup(activeJobs: () => string[] = () => []) {
  let clock = 0;
  const events: StallEvent[] = [];
  const wd = new EventLoopStallWatchdog({
    intervalMs: INTERVAL,
    nowFn: () => clock,
    activeJobsFn: activeJobs,
    record: (e) => events.push(e),
  });
  // Simulates the loop being blocked for blockMs before the next fire.
  const fire = (blockMs = 0) => {
    clock += INTERVAL + blockMs;
    vi.advanceTimersByTime(INTERVAL);
  };
  return { wd, events, fire };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EventLoopStallWatchdog', () => {
  it('records exactly one event for a 5s block and none for a 300ms block', () => {
    const { wd, events, fire } = setup();
    wd.start();
    fire();
    fire(300);
    expect(events).toHaveLength(0);
    fire(5000);
    expect(events).toHaveLength(1);
    expect(Math.abs(events[0].blockedMs - 5000)).toBeLessThanOrEqual(INTERVAL);
    fire();
    expect(events).toHaveLength(1);
    wd.stop();
  });

  it('records two events for two separate blocks and zero for a steady loop', () => {
    const steady = setup();
    steady.wd.start();
    for (let i = 0; i < 20; i++) steady.fire();
    expect(steady.events).toHaveLength(0);
    steady.wd.stop();

    const { wd, events, fire } = setup();
    wd.start();
    fire(STALL_THRESHOLD_MS + 1000);
    fire();
    fire(4000);
    fire();
    expect(events).toHaveLength(2);
    wd.stop();
  });

  it('lists exactly the executing jobs at stall end, [] when none', async () => {
    const scheduler = new Scheduler();
    let release!: () => void;
    scheduler.register({
      name: 'busy_job',
      intervalMs: 60_000,
      runOnBoot: true,
      run: () => new Promise<void>((r) => (release = r)),
    });
    scheduler.register({
      name: 'idle_job',
      intervalMs: 60_000,
      run: async () => {},
    });
    const { wd, events, fire } = setup(() => scheduler.getExecutingJobNames());
    wd.start();
    scheduler.start('busy_job');
    await vi.advanceTimersByTimeAsync(1);
    fire(3000);
    expect(events[0].activeJobs).toEqual(['busy_job']);
    release();
    await vi.advanceTimersByTimeAsync(1);
    fire(3000);
    expect(events[1].activeJobs).toEqual([]);
    wd.stop();
    await scheduler.stopAll();
  });

  it('unrefs its interval and stop() clears it', () => {
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as NodeJS.Timeout;
    const setSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue(fakeTimer);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { wd } = setup();
    wd.start();
    expect(unref).toHaveBeenCalled();
    wd.stop();
    expect(clearSpy).toHaveBeenCalledWith(fakeTimer);
    setSpy.mockRestore();
  });
});

describe('recordStallEvent', () => {
  it('writes an event_loop_stall audit row with the payload keys and is in the incident list', () => {
    db.prepare('DELETE FROM audit_log').run();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    recordStallEvent({
      blockedMs: 5000,
      endedAt: 123,
      activeJobs: ['a'],
      p99DelayMs: 1.5,
      maxDelayMs: 9,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[EventLoopStall]'),
    );
    const row = db
      .prepare(`SELECT event_type, payload, project_id FROM audit_log`)
      .get() as {
      event_type: string;
      payload: string;
      project_id: string | null;
    };
    expect(row.event_type).toBe('event_loop_stall');
    expect(Object.keys(JSON.parse(row.payload)).sort()).toEqual(
      ['activeJobs', 'blockedMs', 'endedAt', 'maxDelayMs', 'p99DelayMs'].sort(),
    );

    insertProject({
      id: 'stall-proj',
      name: 'Stall',
      project_dir: '/nonexistent/stall',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    db.prepare(`UPDATE audit_log SET project_id = 'stall-proj'`).run();
    const snap = buildInvestigateDbSnapshot('stall-proj');
    expect(snap.health.recentAuditEvents.map((e) => e.eventType)).toContain(
      'event_loop_stall',
    );
  });
});

describe('attachWsLifecycleLogging', () => {
  it('logs code, reason, peer and non-negative lifetime on close; error handler does not throw', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const handlers: Record<string, (...a: never[]) => void> = {};
    const ws = {
      on(ev: string, cb: (...a: never[]) => void) {
        handlers[ev] = cb;
        return this;
      },
    };
    let t = 1000;
    attachWsLifecycleLogging(ws as never, '10.0.0.5', () => t);
    t = 1750;
    (handlers.close as (c: number, r: Buffer) => void)(
      1006,
      Buffer.from('gone'),
    );
    const closeMsg = String(info.mock.calls.at(-1)?.[0]);
    expect(closeMsg).toContain('code=1006');
    expect(closeMsg).toContain('gone');
    expect(closeMsg).toContain('peer=10.0.0.5');
    expect(closeMsg).toContain('lifetimeMs=750');
    expect(() =>
      (handlers.error as (e: Error) => void)(new Error('boom')),
    ).not.toThrow();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('boom');
  });
});
