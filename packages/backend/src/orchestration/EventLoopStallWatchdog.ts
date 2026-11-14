import {
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
} from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import { logger } from '../logger';
import { recordEvent } from '../audit/AuditLog';
import type { SlowStatement } from '../db/slowStatementRecorder';
import type { JobRunWindow } from './Scheduler';

export const STALL_THRESHOLD_MS = 2000;
const DEFAULT_INTERVAL_MS = 500;
const GC_ENTRY_CAP = 500;

export interface ResourceDelta {
  minorPageFault: number;
  majorPageFault: number;
  fsRead: number;
  fsWrite: number;
  userCpuMs: number;
  systemCpuMs: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
}

export interface StallEvent {
  blockedMs: number;
  endedAt: number;
  /** Scheduler jobs executing when the stall ended — a lead, not an attribution; [] means none were. */
  activeJobs: string[];
  p99DelayMs: number;
  maxDelayMs: number;
  /** Scheduler jobs whose run overlapped the stall window, including ones already finished at tick time. */
  recentJobs: JobRunWindow[];
  /** Slow main-thread SQLite statements that overlapped the stall window. */
  slowStatements: SlowStatement[];
  /** Sum of GC pause durations inside the stall window. */
  gcPauseMs: number;
  /** process.resourceUsage() change between the previous tick and this one. */
  resourceDelta: ResourceDelta;
}

function sampleResources(): ResourceDelta {
  const u = process.resourceUsage();
  return {
    minorPageFault: u.minorPageFault,
    majorPageFault: u.majorPageFault,
    fsRead: u.fsRead,
    fsWrite: u.fsWrite,
    userCpuMs: u.userCPUTime / 1000,
    systemCpuMs: u.systemCPUTime / 1000,
    voluntaryContextSwitches: u.voluntaryContextSwitches,
    involuntaryContextSwitches: u.involuntaryContextSwitches,
  };
}

export class EventLoopStallWatchdog {
  private readonly intervalMs: number;
  private readonly thresholdMs: number;
  private readonly nowFn: () => number;
  private readonly activeJobsFn: () => string[];
  private readonly record: (e: StallEvent) => void;
  private readonly recentJobsFn: (
    fromMs: number,
    toMs: number,
  ) => JobRunWindow[];
  private readonly slowStatementsFn: (
    fromMs: number,
    toMs: number,
  ) => SlowStatement[];
  private readonly gcPauseFn: ((fromMs: number, toMs: number) => number) | null;
  private readonly resourceFn: () => ResourceDelta;
  private lastResources: ResourceDelta | null = null;
  private gcEntries: Array<{ endedAt: number; duration: number }> = [];
  private gcObserver: PerformanceObserver | null = null;
  private timer: NodeJS.Timeout | null = null;
  private expected = 0;
  private histogram: IntervalHistogram | null = null;

  constructor(opts: {
    intervalMs?: number;
    thresholdMs?: number;
    nowFn?: () => number;
    activeJobsFn: () => string[];
    record: (e: StallEvent) => void;
    recentJobsFn?: (fromMs: number, toMs: number) => JobRunWindow[];
    slowStatementsFn?: (fromMs: number, toMs: number) => SlowStatement[];
    gcPauseFn?: (fromMs: number, toMs: number) => number;
    resourceFn?: () => ResourceDelta;
  }) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.thresholdMs = opts.thresholdMs ?? STALL_THRESHOLD_MS;
    this.nowFn = opts.nowFn ?? Date.now;
    this.activeJobsFn = opts.activeJobsFn;
    this.record = opts.record;
    this.recentJobsFn = opts.recentJobsFn ?? (() => []);
    this.slowStatementsFn = opts.slowStatementsFn ?? (() => []);
    this.gcPauseFn = opts.gcPauseFn ?? null;
    this.resourceFn = opts.resourceFn ?? sampleResources;
  }

  start(): void {
    if (this.timer) return;
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.lastResources = this.resourceFn();
    if (!this.gcPauseFn) this.startGcObserver();
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
    this.gcObserver?.disconnect();
    this.gcObserver = null;
    this.gcEntries = [];
  }

  private startGcObserver(): void {
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.gcEntries.push({
            endedAt: performance.timeOrigin + e.startTime + e.duration,
            duration: e.duration,
          });
        }
        if (this.gcEntries.length > GC_ENTRY_CAP) {
          this.gcEntries.splice(0, this.gcEntries.length - GC_ENTRY_CAP);
        }
      });
      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch {
      this.gcObserver = null;
    }
  }

  private gcPause(fromMs: number, toMs: number): number {
    if (this.gcPauseFn) return this.gcPauseFn(fromMs, toMs);
    let sum = 0;
    for (const g of this.gcEntries) {
      if (g.endedAt >= fromMs && g.endedAt - g.duration <= toMs) {
        sum += g.duration;
      }
    }
    return sum;
  }

  private tick(): void {
    const now = this.nowFn();
    const drift = now - this.expected;
    this.expected = now + this.intervalMs;
    const h = this.histogram;
    const prev = this.lastResources;
    const cur = this.resourceFn();
    this.lastResources = cur;
    if (drift < this.thresholdMs) {
      h?.reset();
      return;
    }
    const maxDelayMs = h ? h.max / 1e6 : 0;
    const p99DelayMs = h ? h.percentile(99) / 1e6 : 0;
    h?.reset();
    try {
      const from = now - drift;
      const base = prev ?? cur;
      this.record({
        blockedMs: drift,
        endedAt: now,
        activeJobs: this.activeJobsFn(),
        p99DelayMs,
        maxDelayMs,
        recentJobs: this.recentJobsFn(from, now),
        slowStatements: this.slowStatementsFn(from, now),
        gcPauseMs: this.gcPause(from, now),
        resourceDelta: {
          minorPageFault: cur.minorPageFault - base.minorPageFault,
          majorPageFault: cur.majorPageFault - base.majorPageFault,
          fsRead: cur.fsRead - base.fsRead,
          fsWrite: cur.fsWrite - base.fsWrite,
          userCpuMs: cur.userCpuMs - base.userCpuMs,
          systemCpuMs: cur.systemCpuMs - base.systemCpuMs,
          voluntaryContextSwitches:
            cur.voluntaryContextSwitches - base.voluntaryContextSwitches,
          involuntaryContextSwitches:
            cur.involuntaryContextSwitches - base.involuntaryContextSwitches,
        },
      });
    } catch (err) {
      logger.error('[EventLoopStall] record failed', { err });
    }
  }
}

export function recordStallEvent(e: StallEvent): void {
  logger.warn(
    `[EventLoopStall] event loop blocked ~${e.blockedMs}ms (endedAt=${e.endedAt}, activeJobs=[${e.activeJobs.join(',')}], recentJobs=[${e.recentJobs.map((j) => j.name).join(',')}], slowStatements=${e.slowStatements.length}, gcPauseMs=${e.gcPauseMs.toFixed(1)}, p99DelayMs=${e.p99DelayMs.toFixed(1)}, maxDelayMs=${e.maxDelayMs.toFixed(1)}); activeJobs is a lead only — the stall may originate outside the scheduler`,
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
      recentJobs: e.recentJobs,
      slowStatements: e.slowStatements,
      gcPauseMs: e.gcPauseMs,
      resourceDelta: e.resourceDelta,
    },
  });
}
