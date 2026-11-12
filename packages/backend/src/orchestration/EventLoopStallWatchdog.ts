import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import { logger } from '../logger';
import { recordEvent } from '../audit/AuditLog';

export const STALL_THRESHOLD_MS = 2000;
const DEFAULT_INTERVAL_MS = 500;

export interface StallEvent {
  blockedMs: number;
  endedAt: number;
  /** Scheduler jobs executing when the stall ended — a lead, not an attribution; [] means none were. */
  activeJobs: string[];
  p99DelayMs: number;
  maxDelayMs: number;
}

export class EventLoopStallWatchdog {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly nowFn: () => number;
  private readonly activeJobsFn: () => string[];
  private readonly record: (e: StallEvent) => void;
  private timer: NodeJS.Timeout | null = null;
  private expected = 0;
  private histogram: IntervalHistogram | null = null;

  constructor(opts: {
    intervalMs?: number;
    thresholdMs?: number;
    nowFn?: () => number;
    activeJobsFn: () => string[];
    record: (e: StallEvent) => void;
  }) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.thresholdMs = opts.thresholdMs ?? STALL_THRESHOLD_MS;
    this.nowFn = opts.nowFn ?? Date.now;
    this.activeJobsFn = opts.activeJobsFn;
    this.record = opts.record;
  }

  start(): void {
    if (this.timer) return;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.expected = this.nowFn() + this.intervalMs;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.histogram?.disable();
    this.histogram = null;
  }

  private tick(): void {
    const now = this.nowFn();
    const drift = now - this.expected;
    this.expected = now + this.intervalMs;
    const h = this.histogram;
    if (drift < this.thresholdMs) {
      h?.reset();
      return;
    }
    const maxDelayMs = h ? h.max / 1e6 : 0;
    const p99DelayMs = h ? h.percentile(99) / 1e6 : 0;
    h?.reset();
    try {
      this.record({
        blockedMs: drift,
        endedAt: now,
        activeJobs: this.activeJobsFn(),
        p99DelayMs,
        maxDelayMs,
      });
    } catch (err) {
      logger.error('[EventLoopStall] record failed', { err });
    }
  }
}

export function recordStallEvent(e: StallEvent): void {
  logger.warn(
    `[EventLoopStall] event loop blocked ~${e.blockedMs}ms (endedAt=${e.endedAt}, activeJobs=[${e.activeJobs.join(',')}], p99DelayMs=${e.p99DelayMs.toFixed(1)}, maxDelayMs=${e.maxDelayMs.toFixed(1)}); activeJobs is a lead only — the stall may originate outside the scheduler`,
  );
  recordEvent({
    event_type: 'event_loop_stall',
    actor_type: 'system',
    payload: {
      blockedMs: e.blockedMs,
      endedAt: e.endedAt,
      activeJobs: e.activeJobs,
      p99DelayMs: e.p99DelayMs,
      maxDelayMs: e.maxDelayMs,
    },
  });
}
