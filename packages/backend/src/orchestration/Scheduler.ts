import { performance } from 'node:perf_hooks';
import { logger } from '../logger';
import { insertSchedulerAudit } from '../db/queries';
import type { ServerMessage } from '../ws/types';

export type JobRunStatus = 'ok' | 'failed' | 'skipped' | 'degraded';

/**
 * Scheduler-wide cap on jobs actually executing at once. Each job already
 * serializes against itself (see `concurrency`), but with no cross-job bound
 * every job's independent setTimeout can expire during the same event-loop
 * block and all become runnable the instant the loop drains — a thundering
 * herd that then serializes into one contiguous mega-block. This bound
 * forces the rest to queue (FIFO) and run in sequence instead.
 */
export const GLOBAL_MAX_CONCURRENT_JOBS = 4;

/**
 * A completed ('ok') tick that processed zero items and ran at/above this
 * duration or event-loop-blocked time is reclassified as 'degraded' — a
 * multi-minute tick that did no work is indistinguishable from a wedged one,
 * not a healthy no-op, and must not be reported as ok.
 */
export const DEGRADED_TICK_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Scheduler-wide default execution window for a job's `run`. Applies when a
 * job does not set its own `timeoutMs`. A hung network-bound job that never
 * settles would otherwise hold a global concurrency slot (see
 * GLOBAL_MAX_CONCURRENT_JOBS) forever and starve every other job — this
 * bounds that. Jobs with legitimately longer runtimes (observed:
 * multi-hour) must set their own `timeoutMs` override.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

export interface JobOptions {
  name: string;
  intervalMs: number | (() => number);
  runOnBoot?: boolean;
  /**
   * Delay before the FIRST fire, overriding intervalMs for that one
   * scheduling call only — seeded from a job's durable last-run time
   * (last_ok_started_at + intervalMs, clamped at zero) so a restart that
   * lands mid-interval resumes the original schedule instead of restarting
   * a fresh intervalMs-long wait from registration. Ignored when
   * runOnBoot is true. Every reschedule after the first fire uses the
   * normal intervalMs.
   */
  initialDelayMs?: number;
  jitterMs?: number;
  enabled?: () => boolean;
  concurrency?: 'skip-if-running' | 'queue-next' | 'serial-no-overlap';
  /**
   * Max time allowed for `run` to settle before it is treated as timed
   * out: its AbortSignal is aborted, the global concurrency slot is
   * released, and the run is recorded as failed. Defaults to
   * DEFAULT_JOB_TIMEOUT_MS. Set higher for jobs with known long runtimes.
   */
  timeoutMs?: number;
  run: (ctx: {
    signal: AbortSignal;
  }) => Promise<
    ({ items_processed?: number } & Record<string, unknown>) | void
  >;
  onError?: (err: unknown) => void;
}

export interface JobStatus {
  name: string;
  /** True once the job has been admitted into the global concurrency window and is actually executing. */
  running: boolean;
  /** True while the job is waiting for a free global concurrency slot, before it starts executing. */
  queued: boolean;
  lastRunAt: string | null;
  lastStatus: JobRunStatus | null;
  nextRunAt: string | null;
}

interface JobState {
  opts: JobOptions;
  timer: NodeJS.Timeout | null;
  // In-flight from the moment a fire is accepted (pre-admission) through
  // completion — this is what the skip-if-running / queue-next concurrency
  // guard checks, and its semantics must not change. It does NOT distinguish
  // queued-for-a-slot from actually executing; `executing` does that.
  running: boolean;
  executing: boolean;
  queued: boolean;
  abortController: AbortController | null;
  lastRunAt: string | null;
  lastStatus: JobRunStatus | null;
  nextRunAt: string | null;
  stopped: boolean;
}

export class Scheduler {
  private jobs = new Map<string, JobState>();
  private broadcast: ((msg: ServerMessage) => void) | null = null;
  private globalRunning = 0;
  private admissionQueue: Array<() => void> = [];

  setBroadcast(fn: (msg: ServerMessage) => void): void {
    this.broadcast = fn;
  }

  register(opts: JobOptions): void {
    if (this.jobs.has(opts.name)) {
      logger.warn(
        `[Scheduler] job '${opts.name}' already registered — skipping`,
      );
      return;
    }
    this.jobs.set(opts.name, {
      opts,
      timer: null,
      running: false,
      executing: false,
      queued: false,
      abortController: null,
      lastRunAt: null,
      lastStatus: null,
      nextRunAt: null,
      stopped: true,
    });
  }

  start(name?: string): void {
    if (name) {
      const state = this.jobs.get(name);
      if (state) this._startJob(state);
    } else {
      for (const state of this.jobs.values()) {
        this._startJob(state);
      }
    }
  }

  private _startJob(state: JobState): void {
    if (!state.stopped) return;
    state.stopped = false;
    if (state.opts.runOnBoot) {
      void this._runJob(state);
    } else if (state.opts.initialDelayMs !== undefined) {
      this._scheduleNext(state, state.opts.initialDelayMs);
    } else {
      this._scheduleNext(state);
    }
  }

  private _scheduleNext(state: JobState, delayOverride?: number): void {
    if (state.stopped) return;
    let delay: number;
    if (delayOverride !== undefined) {
      delay = delayOverride;
    } else {
      const base =
        typeof state.opts.intervalMs === 'function'
          ? state.opts.intervalMs()
          : state.opts.intervalMs;
      const jitter = state.opts.jitterMs
        ? Math.random() * state.opts.jitterMs
        : 0;
      delay = base + jitter;
    }
    state.nextRunAt = new Date(Date.now() + delay).toISOString();
    state.timer = setTimeout(() => {
      state.timer = null;
      void this._runJob(state);
    }, delay);
    state.timer.unref?.();
  }

  /**
   * Resolves once the caller is admitted into the global concurrency
   * window. When the window is saturated the resolver is queued FIFO, so a
   * job deferred here is always released in arrival order — never starved
   * behind jobs that keep getting readmitted ahead of it.
   */
  private _admitGlobalSlot(): Promise<void> {
    if (
      this.globalRunning < GLOBAL_MAX_CONCURRENT_JOBS &&
      this.admissionQueue.length === 0
    ) {
      this.globalRunning++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.admissionQueue.push(resolve);
    });
  }

  private _releaseGlobalSlot(): void {
    this.globalRunning--;
    const next = this.admissionQueue.shift();
    if (next) {
      this.globalRunning++;
      next();
    }
  }

  private async _runJob(state: JobState): Promise<void> {
    const concurrency = state.opts.concurrency ?? 'skip-if-running';

    if (state.running) {
      if (concurrency === 'skip-if-running') {
        this._scheduleNext(state);
        await this._emitAudit(
          state,
          'skipped',
          Date.now(),
          Date.now(),
          undefined,
          undefined,
        );
        return;
      }
      if (concurrency === 'queue-next') {
        state.queued = true;
        return;
      }
      // serial-no-overlap: wait for current run to finish (queued flag handles it)
      state.queued = true;
      return;
    }

    if (state.opts.enabled && !state.opts.enabled()) {
      this._scheduleNext(state);
      await this._emitAudit(
        state,
        'skipped',
        Date.now(),
        Date.now(),
        undefined,
        undefined,
      );
      return;
    }

    state.running = true;
    state.queued = false;
    state.nextRunAt = null;

    // Cross-job admission bound: waits here if the global concurrency
    // window is saturated, so timing/measurement below reflects actual
    // execution, not queueing.
    await this._admitGlobalSlot();
    state.executing = true;

    const startedAt = Date.now();
    // Sampled immediately before the job's await and diffed at completion —
    // eventLoopUtilization(startElu) yields the loop-active time attributable
    // to this window, not the cumulative-since-boot absolute. This must not
    // itself block: eventLoopUtilization() reads process-internal counters,
    // it never touches the DB or does I/O.
    const startElu = performance.eventLoopUtilization();
    const ac = new AbortController();
    state.abortController = ac;

    let result: { items_processed?: number } | void = undefined;
    let runStatus: 'ok' | 'failed' = 'ok';
    let runError: { message: string; stack?: string } | undefined;

    const timeoutMs = state.opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    // The raw run promise is kept separate from the race so a late settle
    // (after we've already timed out and moved on) can be swallowed here
    // instead of surfacing as an unhandled rejection or re-triggering any
    // of the finally-block bookkeeping below.
    const runPromise = state.opts.run({ signal: ac.signal });
    runPromise.catch(() => {});

    const TIMED_OUT = Symbol('timed-out');
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    timeoutHandle!.unref?.();

    try {
      const raced = await Promise.race([runPromise, timeoutPromise]);
      if (raced === TIMED_OUT) {
        runStatus = 'failed';
        runError = {
          message: `job '${state.opts.name}' timed out after ${timeoutMs}ms`,
        };
        ac.abort();
        if (state.opts.onError) {
          state.opts.onError(new Error(runError.message));
        } else {
          logger.error(`[Scheduler] ${runError.message}`);
        }
      } else {
        result = raced;
      }
    } catch (err) {
      runStatus = 'failed';
      runError = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      if (state.opts.onError) {
        state.opts.onError(err);
      } else {
        logger.error(`[Scheduler] job '${state.opts.name}' failed:`, err);
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const completedAt = Date.now();
      const eventLoopBlockedMs = Math.round(
        performance.eventLoopUtilization(startElu).active,
      );
      state.running = false;
      state.executing = false;
      state.abortController = null;
      this._releaseGlobalSlot();
      // Jobs must report items_processed explicitly, so a genuine zero is
      // distinguishable from "unreported" — a job that returns nothing
      // (or omits the field) is recorded as having processed zero items.
      const itemsProcessed =
        (result as { items_processed?: number } | undefined)?.items_processed ??
        0;

      if (state.queued && !state.stopped) {
        state.queued = false;
        void this._runJob(state);
      } else {
        this._scheduleNext(state);
      }

      const durationMs = completedAt - startedAt;
      const finalStatus: JobRunStatus =
        runStatus === 'ok' &&
        itemsProcessed === 0 &&
        (durationMs >= DEGRADED_TICK_THRESHOLD_MS ||
          eventLoopBlockedMs >= DEGRADED_TICK_THRESHOLD_MS)
          ? 'degraded'
          : runStatus;

      await this._emitAudit(
        state,
        finalStatus,
        startedAt,
        completedAt,
        itemsProcessed,
        runError,
        eventLoopBlockedMs,
      );
    }
  }

  private async _emitAudit(
    state: JobState,
    status: JobRunStatus,
    startedAtMs: number,
    completedAtMs: number,
    itemsProcessed: number | undefined,
    error: { message: string; stack?: string } | undefined,
    eventLoopBlockedMs?: number,
  ): Promise<void> {
    const startedAt = new Date(startedAtMs).toISOString();
    const completedAt = new Date(completedAtMs).toISOString();
    const durationMs = completedAtMs - startedAtMs;

    state.lastRunAt = startedAt;
    state.lastStatus = status;

    try {
      insertSchedulerAudit({
        job: state.opts.name,
        status,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: durationMs,
        event_loop_blocked_ms: eventLoopBlockedMs ?? null,
        items_processed: itemsProcessed ?? null,
        error: error ? JSON.stringify(error) : null,
      });
    } catch (err) {
      logger.error(
        `[Scheduler] failed to write audit row for '${state.opts.name}':`,
        err,
      );
    }

    if (this.broadcast) {
      const msg: ServerMessage = {
        type: 'scheduler_job_run',
        job: state.opts.name,
        status,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: durationMs,
        next_run_at: state.nextRunAt,
        ...(itemsProcessed !== undefined && {
          items_processed: itemsProcessed,
        }),
        ...(error !== undefined && { error }),
      };
      this.broadcast(msg);
    }
  }

  async triggerNow(name: string): Promise<void> {
    const state = this.jobs.get(name);
    if (!state) throw new Error(`Unknown job: ${name}`);
    // Cancel pending timer so we don't double-fire
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    await this._runJob(state);
  }

  status(): JobStatus[] {
    return Array.from(this.jobs.values()).map((s) => ({
      name: s.opts.name,
      running: s.executing,
      queued: s.running && !s.executing,
      lastRunAt: s.lastRunAt,
      lastStatus: s.lastStatus,
      nextRunAt: s.nextRunAt,
    }));
  }

  /**
   * Snapshot of the global concurrency window: how many jobs currently hold
   * an admitted slot, and how many are queued waiting for one to free up.
   */
  admissionStats(): { occupiedSlots: number; pendingAdmission: number } {
    return {
      occupiedSlots: this.globalRunning,
      pendingAdmission: this.admissionQueue.length,
    };
  }

  async stopAll(
    opts: { drain?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    // Cancel all pending timers
    for (const state of this.jobs.values()) {
      state.stopped = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }

    if (!opts.drain) return;

    const running = Array.from(this.jobs.values()).filter((s) => s.running);
    if (running.length === 0) return;

    // Signal all in-flight jobs to abort
    for (const state of running) {
      state.abortController?.abort();
    }

    const timeoutMs = opts.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;

    await new Promise<void>((resolve) => {
      const check = () => {
        const stillRunning = Array.from(this.jobs.values()).some(
          (s) => s.running,
        );
        if (!stillRunning || Date.now() >= deadline) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }
}
