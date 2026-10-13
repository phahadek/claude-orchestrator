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
}

export interface PriorityLaneQueueOpts {
  rerank?: (projectId: string, runIds: string[]) => Map<string, LaneWaiterKey>;
  onGrant?: (runId: string) => void;
}

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
    if (this.available > 0) {
      this.available--;
      this.opts.onGrant?.(runId);
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      this.insert({
        id: runId,
        key,
        wake: () => {
          this.available--;
          resolve(() => this.release());
          this.opts.onGrant?.(runId);
        },
        reject,
      });
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
      if (list.length > 0) sim.set(pid, list.map((w) => w.id));
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

  private drain(): void {
    while (this.available > 0 && this.lists.size > 0) {
      for (const pid of [...this.lists.keys()]) this.rerankOne(pid);
      const pid = this.nextProject();
      if (pid === null) return;
      const list = this.lists.get(pid)!;
      const next = list[0];
      this.removeFrom(list, 0, pid);
      this.cursor = pid;
      next.wake();
    }
  }

  private nextProject(): string | null {
    const ids = [...this.lists.keys()].sort();
    if (ids.length === 0) return null;
    return ids.find((p) => this.cursor === null || p > this.cursor) ?? ids[0];
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
