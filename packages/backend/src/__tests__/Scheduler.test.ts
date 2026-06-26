import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  insertSchedulerAudit: vi.fn(),
}));

import { insertSchedulerAudit } from '../db/queries.js';
import { Scheduler } from '../orchestration/Scheduler.js';

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
    const run1Done = new Promise<void>((r) => { resolve1 = r; });
    const runFn = vi.fn()
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
