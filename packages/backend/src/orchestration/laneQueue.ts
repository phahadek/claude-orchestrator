/**
 * Priority-aware permit queue for the test lane: one waiter list per project,
 * each ordered by execution rank, with freed slots handed to projects
 * round-robin. Kept separate from tasks/deferralClassifier.ts's Semaphore,
 * which the classifier still uses as a plain FIFO.
 */

import { LaneRunWithdrawnError } from '../tasks/deferralClassifier';
import { executionGroupOrder, type ExecutionGroup } from './executionPriority';
import { logger } from '../logger';

export interface LaneWaiterKey {
  projectId: string;
  group: ExecutionGroup;
  rankKey: (number | string)[];
  requestedAt: number;
}

interface Waiter {
  id: string;
  key: LaneWaiterKey;
  wake: () => void;
  reject: (err: Error) => void;
  /** Wall-clock ms when this waiter was first passed over as ineligible. */
  skippedSince?: number;
}

export interface PriorityLaneQueueOpts {
  rerank?: (projectId: string, runIds: string[]) => Map<string, LaneWaiterKey>;
  onGrant?: (runId: string) => void;
  /**
   * Called when a free slot could go to this waiter. May have side effects
   * (the lane takes the owner's merge hold here), so it is called only for a
   * waiter about to be granted when it returns true. An ineligible waiter is
   * passed over without losing its rank.
   */
  eligible?: (runId: string) => boolean;
  /** Wall-clock ms an ineligible waiter may stay passed over before being withdrawn. */
  skipCeilingMs?: number;
  /** Called after a waiter is withdrawn for exceeding skipCeilingMs. */
  onSkipExpired?: (runId: string) => void;
  /** Interval for re-evaluating passed-over waiters between slot releases. */
  reevaluateIntervalMs?: number;
  clock?: () => number;
}

export const SKIP_EXPIRED_REASON = 'session_not_idle';

function compareKeyParts(
  a: (number | string)[],
  b: (number | string)[],
): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === typeof y) return x < y ? -1 : 1;
    return typeof x === 'number' ? -1 : 1;
  }
  return a.length - b.length;
}

function compareWaiters(a: Waiter, b: Waiter): number {
  const g = executionGroupOrder(a.key.group) - executionGroupOrder(b.key.group);
  if (g !== 0) return g;
  const k = compareKeyParts(a.key.rankKey, b.key.rankKey);
  if (k !== 0) return k;
  if (a.key.requestedAt !== b.key.requestedAt)
    return a.key.requestedAt - b.key.requestedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class PriorityLaneQueue {
  private available: number;
  private size: number;
  private readonly lists = new Map<string, Waiter[]>();
  private cursor: string | null = null;
  private reevalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    capacity: number,
    private readonly opts: PriorityLaneQueueOpts = {},
  ) {
    this.available = capacity;
    this.size = capacity;
  }

  inUse(): number {
    return this.size - this.available;
  }

  capacity(): number {
    return this.size;
  }

  queueDepth(): number {
    let n = 0;
    for (const list of this.lists.values()) n += list.length;
    return n;
  }

  async acquire(runId: string, key: LaneWaiterKey): Promise<() => void> {
    if (this.available > 0 && (this.opts.eligible?.(runId) ?? true)) {
      this.available--;
      this.opts.onGrant?.(runId);
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const parkedWithFreeSlot = this.available > 0;
      this.insert({
        id: runId,
        key,
        wake: () => {
          this.available--;
          resolve(() => this.release());
          this.opts.onGrant?.(runId);
        },
        reject,
        skippedSince: parkedWithFreeSlot ? this.now() : undefined,
      });
      if (parkedWithFreeSlot) this.scheduleReevaluation();
    });
  }

  withdraw(runId: string, supersededBy: string): boolean {
    const found = this.find(runId);
    if (!found) return false;
    this.removeFrom(found.list, found.index, found.waiter.key.projectId);
    found.waiter.reject(new LaneRunWithdrawnError(supersededBy));
    return true;
  }

  resize(newCapacity: number): void {
    this.available += newCapacity - this.size;
    this.size = newCapacity;
    this.drain();
  }

  rekey(runId: string, key: LaneWaiterKey): void {
    const found = this.find(runId);
    if (!found) return;
    this.removeFrom(found.list, found.index, found.waiter.key.projectId);
    found.waiter.key = key;
    this.insert(found.waiter);
  }

  rerankProject(projectId: string): void {
    this.rerankOne(projectId);
  }

  /** 1-indexed estimated global grant position, simulating the round-robin over the current lists. */
  positionOf(runId: string): number | null {
    if (!this.find(runId)) return null;
    const sim = new Map<string, string[]>();
    for (const [pid, list] of this.lists) {
      if (list.length > 0)
        sim.set(
          pid,
          list.map((w) => w.id),
        );
    }
    const heads = new Map<string, number>();
    let cursor = this.cursor;
    let position = 0;
    while (sim.size > 0) {
      const ids = [...sim.keys()].sort();
      const pid = ids.find((p) => cursor === null || p > cursor) ?? ids[0];
      const list = sim.get(pid)!;
      const head = heads.get(pid) ?? 0;
      position++;
      if (list[head] === runId) return position;
      if (head + 1 >= list.length) sim.delete(pid);
      else heads.set(pid, head + 1);
      cursor = pid;
    }
    return null;
  }

  private release(): void {
    this.available++;
    this.drain();
  }

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private drain(): void {
    this.expireSkipped();
    while (this.available > 0 && this.lists.size > 0) {
      for (const pid of [...this.lists.keys()]) this.rerankOne(pid);
      if (!this.grantNext()) break;
    }
    this.scheduleReevaluation();
  }

  /** Grants the first eligible waiter: projects round-robin, each list in rank order. */
  private grantNext(): boolean {
    const ids = [...this.lists.keys()].sort();
    const start = ids.findIndex((p) => this.cursor === null || p > this.cursor);
    const ordered =
      start <= 0 ? ids : [...ids.slice(start), ...ids.slice(0, start)];
    for (const pid of ordered) {
      const list = this.lists.get(pid)!;
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (this.opts.eligible && !this.opts.eligible(w.id)) {
          w.skippedSince ??= this.now();
          continue;
        }
        this.removeFrom(list, i, pid);
        this.cursor = pid;
        w.wake();
        return true;
      }
    }
    return false;
  }

  private expireSkipped(): void {
    const ceiling = this.opts.skipCeilingMs;
    if (ceiling === undefined) return;
    const now = this.now();
    const expired: Waiter[] = [];
    for (const list of this.lists.values()) {
      for (const w of list) {
        if (w.skippedSince !== undefined && now - w.skippedSince >= ceiling)
          expired.push(w);
      }
    }
    for (const w of expired) {
      const found = this.find(w.id);
      if (!found) continue;
      this.removeFrom(found.list, found.index, w.key.projectId);
      w.reject(new LaneRunWithdrawnError(SKIP_EXPIRED_REASON));
      this.opts.onSkipExpired?.(w.id);
    }
  }

  private scheduleReevaluation(): void {
    if (this.reevalTimer) {
      clearTimeout(this.reevalTimer);
      this.reevalTimer = null;
    }
    let anySkipped = false;
    for (const list of this.lists.values()) {
      if (list.some((w) => w.skippedSince !== undefined)) anySkipped = true;
    }
    if (!anySkipped) return;
    this.reevalTimer = setTimeout(() => {
      this.reevalTimer = null;
      this.drain();
    }, this.opts.reevaluateIntervalMs ?? 30_000);
    this.reevalTimer.unref?.();
  }

  private rerankOne(projectId: string): void {
    const list = this.lists.get(projectId);
    if (!list || !this.opts.rerank) return;
    let fresh: Map<string, LaneWaiterKey>;
    try {
      fresh = this.opts.rerank(
        projectId,
        list.map((w) => w.id),
      );
    } catch (err) {
      logger.warn(`[laneQueue] rerank failed for ${projectId}: ${err}`);
      return;
    }
    for (const w of list) {
      const key = fresh.get(w.id);
      if (key) w.key = { ...key, projectId };
    }
    list.sort(compareWaiters);
  }

  private insert(waiter: Waiter): void {
    const pid = waiter.key.projectId;
    let list = this.lists.get(pid);
    if (!list) this.lists.set(pid, (list = []));
    let i = list.length;
    while (i > 0 && compareWaiters(list[i - 1], waiter) > 0) i--;
    list.splice(i, 0, waiter);
  }

  private removeFrom(list: Waiter[], index: number, projectId: string): void {
    list.splice(index, 1);
    if (list.length === 0) this.lists.delete(projectId);
  }

  private find(
    runId: string,
  ): { waiter: Waiter; list: Waiter[]; index: number } | null {
    for (const list of this.lists.values()) {
      const index = list.findIndex((w) => w.id === runId);
      if (index !== -1) return { waiter: list[index], list, index };
    }
    return null;
  }
}
