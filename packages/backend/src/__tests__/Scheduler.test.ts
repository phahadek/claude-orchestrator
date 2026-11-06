import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  insertSchedulerAudit: vi.fn(),
}));

import { insertSchedulerAudit } from '../db/queries.js';
import {
  Scheduler,
  GLOBAL_MAX_CONCURRENT_JOBS,
  DEGRADED_TICK_THRESHOLD_MS,
  DEFAULT_JOB_TIMEOUT_MS,
} from '../orchestration/Scheduler.js';

const mockInsertAudit = vi.mocked(insertSchedulerAudit);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeScheduler() {
  const scheduler = new Scheduler();
  const broadcasts: unknown[] = [];
  scheduler.setBroadcast((msg) => broadcasts.push(msg));
  return { scheduler, broadcasts };
}

describe('Scheduler.register', () => {
  it('registers a job and shows it in status()', () => {
    const { scheduler } = makeScheduler();
    scheduler.register({
      name: 'test_job',
      intervalMs: 1000,
      run: async () => {},
    });
    const status = scheduler.status();
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe('test_job');
  });

  it('ignores duplicate registration', () => {
    const { scheduler } = makeScheduler();
    scheduler.register({ name: 'dup', intervalMs: 1000, run: async () => {} });
    scheduler.register({ name: 'dup', intervalMs: 2000, run: async () => {} });
    expect(scheduler.status()).toHaveLength(1);
  });
});

describe('Scheduler.start / run', () => {
  it('runs a job after intervalMs elapses', async () => {
    const { scheduler } = makeScheduler();
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({ name: 'j1', intervalMs: 500, run: runFn });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(runFn).toHaveBeenCalledOnce();
    await scheduler.stopAll();
  });

  it('respects enabled() — skips run when false', async () => {
    const { scheduler } = makeScheduler();
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({
      name: 'j_disabled',
      intervalMs: 100,
      enabled: () => false,
      run: runFn,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(runFn).not.toHaveBeenCalled();
    await scheduler.stopAll();
  });

  it('picks up live intervalMs from function form on each scheduling cycle', async () => {
    // intervalMs() is sampled after each run, so a change takes effect from the NEXT scheduling call.
    const { scheduler } = makeScheduler();
    let interval = 1000;
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({
      name: 'j_dynamic',
      intervalMs: () => interval,
      run: runFn,
    });
    scheduler.start();
    // First run at 1000ms; _scheduleNext is called with interval=1000 → next at 2000ms
    await vi.advanceTimersByTimeAsync(1050);
    expect(runFn).toHaveBeenCalledOnce();
    // Second run at 2000ms; _scheduleNext is called with interval=1000 → next at 3000ms
    await vi.advanceTimersByTimeAsync(1050);
    expect(runFn).toHaveBeenCalledTimes(2);
    // Change interval to 5000ms — takes effect for the next _scheduleNext call (after 3rd run)
    interval = 5000;
    // Third run at 3000ms; _scheduleNext now reads 5000 → next at 8000ms
    await vi.advanceTimersByTimeAsync(1050);
    expect(runFn).toHaveBeenCalledTimes(3);
    // Advance well past old 4000ms mark — new interval hasn't fired yet
    await vi.advanceTimersByTimeAsync(4000);
    expect(runFn).toHaveBeenCalledTimes(3); // no 4th run yet
    await scheduler.stopAll();
  });

  it('runOnBoot=true fires immediately on start()', async () => {
    const { scheduler } = makeScheduler();
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({
      name: 'j_boot',
      intervalMs: 60_000,
      runOnBoot: true,
      run: runFn,
    });
    scheduler.start();
    // Allow microtasks to flush (boot run is async)
    await vi.advanceTimersByTimeAsync(1);
    expect(runFn).toHaveBeenCalledOnce();
    await scheduler.stopAll();
  });

  it('initialDelayMs seeds the first fire at last_run + intervalMs instead of intervalMs from registration', async () => {
    const { scheduler } = makeScheduler();
    const runFn = vi.fn().mockResolvedValue(undefined);
    // Job's durable last run was 21h into a 24h interval — 3h (10_800_000ms)
    // of "credit" remains toward the next fire.
    scheduler.register({
      name: 'j_seeded',
      intervalMs: 24 * 60 * 60 * 1000,
      runOnBoot: false,
      initialDelayMs: 3 * 60 * 60 * 1000,
      run: runFn,
    });
    scheduler.start();
    // Just short of the seeded delay — must not have fired yet.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000 - 100);
    expect(runFn).not.toHaveBeenCalled();
    // Crossing the seeded delay fires it, well short of a fresh 24h wait.
    await vi.advanceTimersByTimeAsync(200);
    expect(runFn).toHaveBeenCalledOnce();
    await scheduler.stopAll();
  });

  it('repeated restarts inside one interval do not postpone the fire beyond the originally seeded delay', async () => {
    // Simulates a job restarted several times before its durable last-run
    // + intervalMs is reached: each restart re-registers with the SAME
    // initialDelayMs (derived from the unchanged durable record), not a
    // fresh intervalMs from that restart's own registration time.
    const seededDelayMs = 3 * 60 * 60 * 1000;
    const intervalMs = 24 * 60 * 60 * 1000;
    let elapsedAcrossRestarts = 0;

    for (let restart = 0; restart < 3; restart++) {
      const { scheduler } = makeScheduler();
      const runFn = vi.fn().mockResolvedValue(undefined);
      const remaining = Math.max(0, seededDelayMs - elapsedAcrossRestarts);
      scheduler.register({
        name: 'j_restart_seeded',
        intervalMs,
        runOnBoot: remaining === 0,
        initialDelayMs: remaining,
        run: runFn,
      });
      scheduler.start();
      const advanceBy = 60 * 60 * 1000; // simulate 1h of uptime before "restart"
      await vi.advanceTimersByTimeAsync(advanceBy);
      elapsedAcrossRestarts += advanceBy;
      if (elapsedAcrossRestarts < seededDelayMs) {
        expect(runFn).not.toHaveBeenCalled();
      }
      await scheduler.stopAll();
    }

    // Final restart: remaining delay has elapsed — fires at/before
    // seededDelayMs total uptime, never at a re-pushed intervalMs.
    const { scheduler } = makeScheduler();
    const finalRunFn = vi.fn().mockResolvedValue(undefined);
    const finalRemaining = Math.max(0, seededDelayMs - elapsedAcrossRestarts);
    scheduler.register({
      name: 'j_restart_seeded',
      intervalMs,
      runOnBoot: finalRemaining === 0,
      initialDelayMs: finalRemaining,
      run: finalRunFn,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(finalRemaining + 10);
    expect(finalRunFn).toHaveBeenCalledOnce();
    await scheduler.stopAll();
  });
});

describe('Scheduler audit + WS broadcast', () => {
  it('writes audit row and broadcasts scheduler_job_run on success', async () => {
    const { scheduler, broadcasts } = makeScheduler();
    scheduler.register({
      name: 'audit_ok',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async () => ({ items_processed: 3 }),
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInsertAudit).toHaveBeenCalledOnce();
    const auditArg = mockInsertAudit.mock.calls[0][0];
    expect(auditArg.job).toBe('audit_ok');
    expect(auditArg.status).toBe('ok');
    expect(auditArg.items_processed).toBe(3);
    expect(auditArg.error).toBeNull();

    const ws = broadcasts.find(
      (m: unknown) => (m as { type: string }).type === 'scheduler_job_run',
    );
    expect(ws).toBeDefined();
    expect((ws as { job: string }).job).toBe('audit_ok');
    expect((ws as { status: string }).status).toBe('ok');
    expect((ws as { items_processed: number }).items_processed).toBe(3);
    await scheduler.stopAll();
  });

  it('broadcasts next_run_at as a future ISO string after job completes', async () => {
    const { scheduler, broadcasts } = makeScheduler();
    const now = Date.now();
    scheduler.register({
      name: 'next_run_job',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = broadcasts.find(
      (m: unknown) => (m as { type: string }).type === 'scheduler_job_run',
    ) as { next_run_at: string | null } | undefined;
    expect(ws).toBeDefined();
    expect(ws!.next_run_at).not.toBeNull();
    expect(new Date(ws!.next_run_at!).getTime()).toBeGreaterThan(now);
    await scheduler.stopAll();
  });

  it('broadcasts next_run_at: null for a job that is immediately re-queued', async () => {
    const { scheduler, broadcasts } = makeScheduler();
    let resolve1!: () => void;
    const run1Done = new Promise<void>((r) => {
      resolve1 = r;
    });
    const runFn = vi
      .fn()
      .mockReturnValueOnce(run1Done)
      .mockResolvedValue(undefined);
    scheduler.register({
      name: 'queued_job',
      intervalMs: 60_000,
      runOnBoot: true,
      concurrency: 'queue-next',
      run: runFn,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    // Trigger a second run while first is in-flight → gets queued
    void scheduler.triggerNow('queued_job');
    await vi.advanceTimersByTimeAsync(1);
    // Resolve first run — queued run starts immediately
    resolve1();
    await vi.advanceTimersByTimeAsync(10);
    // First completion broadcast should have next_run_at: null (queued run starts immediately)
    const ws = broadcasts.find(
      (m: unknown) => (m as { type: string }).type === 'scheduler_job_run',
    ) as { next_run_at: string | null } | undefined;
    expect(ws).toBeDefined();
    expect(ws!.next_run_at).toBeNull();
    await scheduler.stopAll();
  });

  it('writes audit row with status=failed on run() throw', async () => {
    const { scheduler } = makeScheduler();
    scheduler.register({
      name: 'audit_fail',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async () => {
        throw new Error('boom');
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    const auditArg = mockInsertAudit.mock.calls[0][0];
    expect(auditArg.status).toBe('failed');
    expect(auditArg.error).toContain('boom');
    await scheduler.stopAll();
  });

  it('writes audit row with status=skipped when enabled()=false', async () => {
    const { scheduler } = makeScheduler();
    scheduler.register({
      name: 'audit_skip',
      intervalMs: 60_000,
      runOnBoot: true,
      enabled: () => false,
      run: async () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInsertAudit).toHaveBeenCalledOnce();
    expect(mockInsertAudit.mock.calls[0][0].status).toBe('skipped');
    await scheduler.stopAll();
  });
});

describe('Scheduler concurrency modes', () => {
  it('skip-if-running emits skipped audit when triggerNow called while job in-flight', async () => {
    const { scheduler } = makeScheduler();
    let resolveRun!: () => void;
    const pending = new Promise<void>((r) => {
      resolveRun = r;
    });
    scheduler.register({
      name: 'j_skip',
      intervalMs: 60_000,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: () => pending,
    });
    scheduler.start();
    // Give the boot run time to start (it's now in-flight)
    await vi.advanceTimersByTimeAsync(1);
    // triggerNow while in-flight → should produce a skipped audit
    // (it re-uses _runJob which checks state.running)
    void scheduler.triggerNow('j_skip');
    await vi.advanceTimersByTimeAsync(1);
    const skipped = mockInsertAudit.mock.calls.filter(
      (c) => c[0].status === 'skipped',
    );
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    resolveRun();
    await scheduler.stopAll();
  });

  it('queue-next queues a run when a job is in-flight', async () => {
    const { scheduler } = makeScheduler();
    let resolve1!: () => void;
    const run1Done = new Promise<void>((r) => {
      resolve1 = r;
    });
    const runFn = vi
      .fn()
      .mockReturnValueOnce(run1Done)
      .mockResolvedValue(undefined);
    scheduler.register({
      name: 'j_queue',
      intervalMs: 60_000,
      runOnBoot: true,
      concurrency: 'queue-next',
      run: runFn,
    });
    scheduler.start();
    // Boot run starts — now in-flight
    await vi.advanceTimersByTimeAsync(1);
    expect(runFn).toHaveBeenCalledOnce();
    // Trigger another — should queue
    void scheduler.triggerNow('j_queue');
    await vi.advanceTimersByTimeAsync(1);
    expect(runFn).toHaveBeenCalledOnce(); // still in-flight, queued not started
    // Resolve first run → queued run should execute
    resolve1();
    await vi.advanceTimersByTimeAsync(10);
    expect(runFn).toHaveBeenCalledTimes(2);
    await scheduler.stopAll();
  });
});

describe('Scheduler.stopAll', () => {
  it('stopAll() cancels pending timers — no more runs after stop', async () => {
    const { scheduler } = makeScheduler();
    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({ name: 'j_stop', intervalMs: 200, run: runFn });
    scheduler.start();
    await scheduler.stopAll();
    runFn.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    expect(runFn).not.toHaveBeenCalled();
  });

  it('stopAll({ drain: true }) waits for in-flight run to complete', async () => {
    const { scheduler } = makeScheduler();
    let finished = false;
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    scheduler.register({
      name: 'j_drain',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async () => {
        await pending;
        finished = true;
      },
    });
    scheduler.start();
    // Let the boot run start
    await vi.advanceTimersByTimeAsync(1);
    const stopPromise = scheduler.stopAll({ drain: true, timeoutMs: 5000 });
    expect(finished).toBe(false);
    resolve();
    // Drain waits via polling; advance timers to let poll ticks fire
    await vi.advanceTimersByTimeAsync(500);
    await stopPromise;
    expect(finished).toBe(true);
  });

  it('stopAll({ drain: true, timeoutMs }) force-cancels after timeout via abort signal', async () => {
    const { scheduler } = makeScheduler();
    let aborted = false;
    scheduler.register({
      name: 'j_timeout',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async ({ signal }) => {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    const stopPromise = scheduler.stopAll({ drain: true, timeoutMs: 200 });
    // Advance past the timeout so the poll resolves
    await vi.advanceTimersByTimeAsync(500);
    await stopPromise;
    expect(aborted).toBe(true);
  });
});

describe('Scheduler.triggerNow', () => {
  it('triggers a job out-of-band and returns after completion', async () => {
    const { scheduler } = makeScheduler();
    const runFn = vi.fn().mockResolvedValue({ items_processed: 5 });
    scheduler.register({ name: 'j_trigger', intervalMs: 60_000, run: runFn });
    scheduler.start();
    await scheduler.triggerNow('j_trigger');
    expect(runFn).toHaveBeenCalledOnce();
    await scheduler.stopAll();
  });

  it('throws for unknown job name', async () => {
    const { scheduler } = makeScheduler();
    await expect(scheduler.triggerNow('nonexistent')).rejects.toThrow(
      'Unknown job',
    );
  });
});

describe('Scheduler global concurrency bound', () => {
  function registerBusyJobs(
    scheduler: Scheduler,
    count: number,
    tracker: {
      inFlight: number;
      peakInFlight: number;
      completed: number;
      active: Array<() => void>;
    },
  ) {
    for (let i = 0; i < count; i++) {
      scheduler.register({
        name: `bound_job_${i}`,
        intervalMs: 60_000,
        runOnBoot: true,
        run: () =>
          new Promise<void>((resolve) => {
            tracker.inFlight++;
            tracker.peakInFlight = Math.max(
              tracker.peakInFlight,
              tracker.inFlight,
            );
            tracker.active.push(() => {
              tracker.inFlight--;
              tracker.completed++;
              resolve();
            });
          }),
      });
    }
  }

  it('never admits more than GLOBAL_MAX_CONCURRENT_JOBS jobs at once when all their timers expire simultaneously', async () => {
    const { scheduler } = makeScheduler();
    const jobCount = GLOBAL_MAX_CONCURRENT_JOBS + 6;
    const tracker = {
      inFlight: 0,
      peakInFlight: 0,
      completed: 0,
      active: [] as Array<() => void>,
    };
    registerBusyJobs(scheduler, jobCount, tracker);

    scheduler.start();
    // All jobs are runOnBoot — their timers "expire" together on start().
    await vi.advanceTimersByTimeAsync(1);

    expect(tracker.peakInFlight).toBe(GLOBAL_MAX_CONCURRENT_JOBS);
    expect(tracker.inFlight).toBeLessThanOrEqual(GLOBAL_MAX_CONCURRENT_JOBS);

    // Release everything so the test doesn't leak pending jobs.
    while (tracker.completed < jobCount) {
      const batch = tracker.active.splice(0, tracker.active.length);
      batch.forEach((release) => release());
      await vi.advanceTimersByTimeAsync(1);
    }
    await scheduler.stopAll();
  });

  it('runs every deferred job across repeated drains — none is dropped or starved behind the global bound', async () => {
    const { scheduler } = makeScheduler();
    const jobCount = GLOBAL_MAX_CONCURRENT_JOBS + 6;
    const tracker = {
      inFlight: 0,
      peakInFlight: 0,
      completed: 0,
      active: [] as Array<() => void>,
    };
    registerBusyJobs(scheduler, jobCount, tracker);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);

    let drains = 0;
    while (tracker.completed < jobCount) {
      const batch = tracker.active.splice(0, tracker.active.length);
      expect(batch.length).toBeGreaterThan(0);
      batch.forEach((release) => release());
      await vi.advanceTimersByTimeAsync(1);
      drains++;
      // Guard against an infinite loop if a job were ever dropped/starved.
      expect(drains).toBeLessThanOrEqual(jobCount);
    }

    expect(tracker.completed).toBe(jobCount);
    await scheduler.stopAll();
  });

  it("leaves a job's own concurrency: 'skip-if-running' behaviour unchanged when the global bound is not saturated", async () => {
    expect(GLOBAL_MAX_CONCURRENT_JOBS).toBeGreaterThan(1);
    const { scheduler } = makeScheduler();
    let resolveRun!: () => void;
    const pending = new Promise<void>((r) => {
      resolveRun = r;
    });
    scheduler.register({
      name: 'j_skip_unsaturated',
      intervalMs: 60_000,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: () => pending,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    void scheduler.triggerNow('j_skip_unsaturated');
    await vi.advanceTimersByTimeAsync(1);
    const skipped = mockInsertAudit.mock.calls.filter(
      (c) => c[0].status === 'skipped',
    );
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    resolveRun();
    await scheduler.stopAll();
  });

  it('reports a newly-scheduled job as queued (not executing) while the global window is saturated, then executing once a slot frees', async () => {
    const { scheduler } = makeScheduler();
    const tracker = {
      inFlight: 0,
      peakInFlight: 0,
      completed: 0,
      active: [] as Array<() => void>,
    };
    registerBusyJobs(scheduler, GLOBAL_MAX_CONCURRENT_JOBS, tracker);

    let resolveLate!: () => void;
    const latePending = new Promise<void>((r) => {
      resolveLate = r;
    });
    scheduler.register({
      name: 'late_job',
      intervalMs: 60_000,
      runOnBoot: true,
      run: () => latePending,
    });

    scheduler.start();
    // All GLOBAL_MAX_CONCURRENT_JOBS busy jobs fire and occupy every slot;
    // late_job's own boot fire is accepted (running) but blocked on admission.
    await vi.advanceTimersByTimeAsync(1);

    const late = scheduler.status().find((s) => s.name === 'late_job');
    expect(late).toMatchObject({ running: false, queued: true });

    // Free one slot — late_job should now be admitted and executing.
    const [release] = tracker.active.splice(0, 1);
    release();
    await vi.advanceTimersByTimeAsync(1);

    const lateAfter = scheduler.status().find((s) => s.name === 'late_job');
    expect(lateAfter).toMatchObject({ running: true, queued: false });

    resolveLate();
    tracker.active.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(1);
    await scheduler.stopAll();
  });

  it('skip-if-running still suppresses a second fire while a job is queued but not yet executing', async () => {
    const { scheduler } = makeScheduler();
    const tracker = {
      inFlight: 0,
      peakInFlight: 0,
      completed: 0,
      active: [] as Array<() => void>,
    };
    registerBusyJobs(scheduler, GLOBAL_MAX_CONCURRENT_JOBS, tracker);

    const runFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({
      name: 'queued_skip_job',
      intervalMs: 60_000,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: runFn,
    });

    scheduler.start();
    // Global window saturated by the busy jobs; queued_skip_job is
    // in-flight (running=true) but stuck waiting for admission (queued=true).
    await vi.advanceTimersByTimeAsync(1);
    expect(
      scheduler.status().find((s) => s.name === 'queued_skip_job'),
    ).toMatchObject({ running: false, queued: true });
    expect(runFn).not.toHaveBeenCalled();

    // A second fire while queued must be skipped, not double-admitted.
    void scheduler.triggerNow('queued_skip_job');
    await vi.advanceTimersByTimeAsync(1);
    const skipped = mockInsertAudit.mock.calls.filter(
      (c) => c[0].status === 'skipped',
    );
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(runFn).not.toHaveBeenCalled();

    tracker.active.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(10);
    await scheduler.stopAll();
  });

  it('reports occupied-slot count and pending-admission depth', async () => {
    const { scheduler } = makeScheduler();
    const tracker = {
      inFlight: 0,
      peakInFlight: 0,
      completed: 0,
      active: [] as Array<() => void>,
    };
    const jobCount = GLOBAL_MAX_CONCURRENT_JOBS + 2;
    registerBusyJobs(scheduler, jobCount, tracker);

    expect(scheduler.admissionStats()).toEqual({
      occupiedSlots: 0,
      pendingAdmission: 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(scheduler.admissionStats()).toEqual({
      occupiedSlots: GLOBAL_MAX_CONCURRENT_JOBS,
      pendingAdmission: 2,
    });

    while (tracker.completed < jobCount) {
      const batch = tracker.active.splice(0, tracker.active.length);
      batch.forEach((release) => release());
      await vi.advanceTimersByTimeAsync(1);
    }
    await scheduler.stopAll();
  });
});

describe('Scheduler items_processed reporting', () => {
  it('records items_processed as an explicit 0 when a job returns no value', async () => {
    const { scheduler } = makeScheduler();
    scheduler.register({
      name: 'no_return',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    const auditArg = mockInsertAudit.mock.calls[0][0];
    expect(auditArg.items_processed).toBe(0);
    expect(auditArg.items_processed).not.toBeNull();
    await scheduler.stopAll();
  });
});

describe('Scheduler degraded tick classification', () => {
  it('records an ok, zero-item tick exceeding the degraded threshold as degraded', async () => {
    const { scheduler } = makeScheduler();
    scheduler.register({
      name: 'slow_zero',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async () => {
        // Fake timers also fake Date.now(), so advancing them synchronously
        // during the job simulates a multi-minute tick without the test
        // actually waiting that long.
        vi.advanceTimersByTime(DEGRADED_TICK_THRESHOLD_MS);
        return { items_processed: 0 };
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    const auditArg = mockInsertAudit.mock.calls[0][0];
    expect(auditArg.status).toBe('degraded');
    expect(auditArg.items_processed).toBe(0);
    await scheduler.stopAll();
  });

  it('keeps a fast zero-item tick recorded as ok', async () => {
    const { scheduler } = makeScheduler();
    scheduler.register({
      name: 'fast_zero',
      intervalMs: 60_000,
      runOnBoot: true,
      run: async () => ({ items_processed: 0 }),
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    const auditArg = mockInsertAudit.mock.calls[0][0];
    expect(auditArg.status).toBe('ok');
    expect(auditArg.items_processed).toBe(0);
    await scheduler.stopAll();
  });
});

describe('Scheduler job timeout', () => {
  it('applies DEFAULT_JOB_TIMEOUT_MS when a job omits timeoutMs', async () => {
    const { scheduler } = makeScheduler();
    scheduler.register({
      name: 'no_timeout_override',
      intervalMs: 60_000,
      runOnBoot: true,
      run: () => new Promise(() => {}), // never settles
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockInsertAudit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_JOB_TIMEOUT_MS);
    expect(mockInsertAudit).toHaveBeenCalledOnce();
    const auditArg = mockInsertAudit.mock.calls[0][0];
    expect(auditArg.status).not.toBe('ok');
    expect(auditArg.error).toContain('timed out');
    await scheduler.stopAll();
  });

  it("aborts the job's AbortSignal and records a non-ok audit row naming the timeout", async () => {
    const { scheduler } = makeScheduler();
    let capturedSignal: AbortSignal | undefined;
    scheduler.register({
      name: 'aborts_on_timeout',
      intervalMs: 60_000,
      timeoutMs: 1_000,
      runOnBoot: true,
      run: ({ signal }) => {
        capturedSignal = signal;
        return new Promise(() => {});
      },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(capturedSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capturedSignal!.aborted).toBe(true);
    const auditArg = mockInsertAudit.mock.calls[0][0];
    expect(auditArg.status).toBe('failed');
    expect(auditArg.error).toContain('timed out');
    await scheduler.stopAll();
  });

  it('releases the global slot within the timeout so a queued job is admitted, and a late settle does not double-release or double-audit', async () => {
    const { scheduler } = makeScheduler();
    const lateResolvers: Array<() => void> = [];
    for (let i = 0; i < GLOBAL_MAX_CONCURRENT_JOBS; i++) {
      scheduler.register({
        name: `hung_${i}`,
        intervalMs: 60_000,
        timeoutMs: 1_000,
        runOnBoot: true,
        run: () =>
          new Promise<void>((resolve) => {
            lateResolvers.push(resolve);
          }),
      });
    }
    const fifthRunFn = vi.fn().mockResolvedValue(undefined);
    scheduler.register({
      name: 'queued_fifth',
      intervalMs: 60_000,
      runOnBoot: true,
      run: fifthRunFn,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    // The four hung jobs saturate the global window; the fifth is parked
    // in the admission queue behind them.
    expect(fifthRunFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    // Timeouts fire, slots release, and the fifth job is admitted and runs.
    expect(fifthRunFn).toHaveBeenCalledOnce();
    expect(mockInsertAudit).toHaveBeenCalledTimes(
      GLOBAL_MAX_CONCURRENT_JOBS + 1,
    );

    const callsBeforeLateSettle = mockInsertAudit.mock.calls.length;
    // The abandoned hung runs finally settle late — must not write another
    // audit row or release an already-released slot.
    lateResolvers.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInsertAudit).toHaveBeenCalledTimes(callsBeforeLateSettle);

    await scheduler.stopAll();
  });

  it('clears state.running on timeout so skip-if-running does not suppress the next interval', async () => {
    const { scheduler } = makeScheduler();
    const runFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(undefined);
    scheduler.register({
      name: 'skip_if_running_recovers',
      intervalMs: 10_000,
      timeoutMs: 1_000,
      runOnBoot: true,
      run: runFn,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(runFn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    // Timeout clears state.running; the next interval must fire rather
    // than being suppressed as "already running".
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runFn).toHaveBeenCalledTimes(2);

    await scheduler.stopAll();
  });
});
