import { describe, it, expect } from 'vitest';
import { PriorityLaneQueue, type LaneWaiterKey } from '../laneQueue';
import { LaneRunWithdrawnError } from '../../tasks/deferralClassifier';

const key = (
  projectId: string,
  group: LaneWaiterKey['group'],
  rankKey: (number | string)[] = [],
  requestedAt = 0,
): LaneWaiterKey => ({ projectId, group, rankKey, requestedAt });

/** Queues a waiter and records its grant order into `order`; returns its release handle once granted. */
function enqueue(
  q: PriorityLaneQueue,
  id: string,
  k: LaneWaiterKey,
  order: string[],
  releases: Record<string, () => void>,
): void {
  void q.acquire(id, k).then((release) => {
    order.push(id);
    releases[id] = release;
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PriorityLaneQueue', () => {
  it('wakes one project waiters in rank order: urgent, blocker, priority', async () => {
    const q = new PriorityLaneQueue(1);
    const order: string[] = [];
    const rel: Record<string, () => void> = {};
    const holder = await q.acquire('holder', key('A', 'priority'));
    enqueue(q, 'low', key('A', 'priority', [2]), order, rel);
    enqueue(q, 'urgent', key('A', 'urgent', [0, 1]), order, rel);
    enqueue(q, 'blocker', key('A', 'blocker', [-2, 1]), order, rel);

    holder();
    await flush();
    rel.urgent();
    await flush();
    rel.blocker();
    await flush();
    expect(order).toEqual(['urgent', 'blocker', 'low']);
  });

  it('breaks equal rank keys by requestedAt, then run id', async () => {
    const q = new PriorityLaneQueue(1);
    const order: string[] = [];
    const rel: Record<string, () => void> = {};
    const holder = await q.acquire('holder', key('A', 'priority'));
    enqueue(q, 'c', key('A', 'priority', [1], 5), order, rel);
    enqueue(q, 'b', key('A', 'priority', [1], 5), order, rel);
    enqueue(q, 'a', key('A', 'priority', [1], 9), order, rel);
    enqueue(q, 'z', key('A', 'priority', [1], 1), order, rel);

    holder();
    for (let i = 0; i < 4; i++) {
      await flush();
      const last = order[order.length - 1];
      if (last) rel[last]();
    }
    await flush();
    expect(order).toEqual(['z', 'b', 'c', 'a']);
  });

  it('alternates between projects, skips empty ones, and handles a project added mid-run', async () => {
    const q = new PriorityLaneQueue(1);
    const order: string[] = [];
    const rel: Record<string, () => void> = {};
    const holder = await q.acquire('holder', key('B', 'priority'));
    enqueue(q, 'a1', key('A', 'priority', [], 1), order, rel);
    enqueue(q, 'a2', key('A', 'priority', [], 2), order, rel);
    enqueue(q, 'a3', key('A', 'priority', [], 3), order, rel);
    enqueue(q, 'b1', key('B', 'priority', [], 4), order, rel);
    enqueue(q, 'b2', key('B', 'priority', [], 5), order, rel);

    holder();
    await flush();
    enqueue(q, 'c1', key('C', 'priority', [], 6), order, rel);
    for (let i = 0; i < 5; i++) {
      await flush();
      rel[order[order.length - 1]]();
    }
    await flush();
    // cursor starts unset: A, then B, then C (added mid-run), then A, B; a3 last.
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('lets fresh rerank keys decide the winner at release', async () => {
    const fresh = new Map<string, LaneWaiterKey>();
    const q = new PriorityLaneQueue(1, {
      rerank: (pid, ids) =>
        new Map(ids.filter((i) => fresh.has(i)).map((i) => [i, fresh.get(i)!])),
    });
    const order: string[] = [];
    const rel: Record<string, () => void> = {};
    const holder = await q.acquire('holder', key('A', 'priority'));
    enqueue(q, 'x', key('A', 'priority', [0]), order, rel);
    enqueue(q, 'y', key('A', 'priority', [1]), order, rel);
    expect(q.positionOf('x')).toBe(1);

    fresh.set('y', key('A', 'urgent', [0, 0]));
    q.rerankProject('A');
    expect(q.positionOf('y')).toBe(1);
    expect(q.positionOf('x')).toBe(2);

    q.rekey('x', key('A', 'execute_now', [0]));
    expect(q.positionOf('x')).toBe(1);
    q.rekey('x', key('A', 'priority', [0]));

    holder();
    await flush();
    expect(order).toEqual(['y']);
  });

  it('simulates round-robin in positionOf across projects', async () => {
    const q = new PriorityLaneQueue(1);
    await q.acquire('holder', key('A', 'priority'));
    void q.acquire('a1', key('A', 'priority', [], 1));
    void q.acquire('a2', key('A', 'priority', [], 2));
    void q.acquire('b1', key('B', 'priority', [], 3));
    expect(q.positionOf('a1')).toBe(1);
    expect(q.positionOf('b1')).toBe(2);
    expect(q.positionOf('a2')).toBe(3);
    expect(q.queueDepth()).toBe(3);
    expect(q.positionOf('nope')).toBeNull();
  });

  it('withdraw removes a waiter and rejects with LaneRunWithdrawnError', async () => {
    const q = new PriorityLaneQueue(1);
    await q.acquire('holder', key('A', 'priority'));
    const p = q.acquire('w', key('A', 'priority'));
    expect(q.withdraw('w', 'newer')).toBe(true);
    await expect(p).rejects.toBeInstanceOf(LaneRunWithdrawnError);
    expect(q.withdraw('w', 'newer')).toBe(false);
    expect(q.queueDepth()).toBe(0);
  });

  it('resize growth 1->3 with three waiters wakes exactly two', async () => {
    const q = new PriorityLaneQueue(1);
    const order: string[] = [];
    const rel: Record<string, () => void> = {};
    await q.acquire('holder', key('A', 'priority'));
    enqueue(q, 'w1', key('A', 'priority', [], 1), order, rel);
    enqueue(q, 'w2', key('A', 'priority', [], 2), order, rel);
    enqueue(q, 'w3', key('A', 'priority', [], 3), order, rel);

    q.resize(3);
    await flush();
    expect(order).toEqual(['w1', 'w2']);
    expect(q.inUse()).toBe(3);
    expect(q.queueDepth()).toBe(1);
  });

  it('calls onGrant for each granted run', async () => {
    const granted: string[] = [];
    const q = new PriorityLaneQueue(1, { onGrant: (id) => granted.push(id) });
    const release = await q.acquire('first', key('A', 'priority'));
    void q.acquire('second', key('A', 'priority'));
    release();
    await flush();
    expect(granted).toEqual(['first', 'second']);
  });
});
