import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueued = vi.hoisted(() => new Map<string, number>());

vi.mock('../../db/queries', () => ({
  getApprovedOpenPRs: vi.fn(),
  getApprovedLocalBranches: vi.fn(),
  // First-seen stamp persists across calls, like the DB column across restarts.
  ensurePrEnqueued: vi.fn((n: number, repo: string, now: number) => {
    const k = `${repo}#${n}`;
    if (!enqueued.has(k)) enqueued.set(k, now);
    return enqueued.get(k)!;
  }),
  ensureLocalBranchEnqueued: vi.fn((id: number, now: number) => {
    const k = `local#${id}`;
    if (!enqueued.has(k)) enqueued.set(k, now);
    return enqueued.get(k)!;
  }),
}));

vi.mock('../../config', () => ({
  getProjectByGithubRepo: vi.fn((repo: string) =>
    repo === 'o/r' ? { id: 'p1', autoMergeEnabled: true } : undefined,
  ),
  getProjectById: vi.fn((id: string) => (id === 'p1' ? { id } : undefined)),
}));

import { getApprovedOpenPRs, getApprovedLocalBranches } from '../../db/queries';
import {
  checkLocalBranchQueueHead,
  checkPrQueueHead,
  computeMergeQueues,
} from '../mergeQueue';

const pr = (n: number) => ({ pr_number: n, repo: 'o/r' }) as never;

beforeEach(() => {
  enqueued.clear();
  vi.mocked(getApprovedOpenPRs).mockReturnValue([]);
  vi.mocked(getApprovedLocalBranches).mockReturnValue([]);
});

describe('merge queue', () => {
  it('orders by enqueue time and only the oldest is head', () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(1)]);
    computeMergeQueues(100);
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(3), pr(2), pr(1)]);
    computeMergeQueues(200);

    expect(checkPrQueueHead(1, 'o/r', 300)).toEqual({
      allowed: true,
      waitMs: 200,
    });
    expect(checkPrQueueHead(2, 'o/r', 300)).toMatchObject({ allowed: false });
    expect(checkPrQueueHead(3, 'o/r', 300)).toMatchObject({ allowed: false });
  });

  it('order is rebuilt identically from persisted stamps (restart)', () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(5), pr(4)]);
    const first = computeMergeQueues(10).get('p1')!;
    const afterRestart = computeMergeQueues(9999).get('p1')!;
    expect(afterRestart).toEqual(first);
  });

  it('ejecting the head (drops out of eligible set) promotes the next PR', () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(1), pr(2)]);
    computeMergeQueues(100);
    expect(checkPrQueueHead(2, 'o/r', 150).allowed).toBe(false);

    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(2)]);
    expect(checkPrQueueHead(2, 'o/r', 160)).toMatchObject({ allowed: true });
  });

  it('local branches share the project queue with PRs', () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(1)]);
    computeMergeQueues(100);
    vi.mocked(getApprovedLocalBranches).mockReturnValue([
      { id: 7, project_id: 'p1' } as never,
    ]);
    expect(checkLocalBranchQueueHead(7, 'p1', 200).allowed).toBe(false);
    expect(checkPrQueueHead(1, 'o/r', 200).allowed).toBe(true);
  });

  it('an unqueued PR is not blocked', () => {
    expect(checkPrQueueHead(99, 'o/r')).toEqual({ allowed: true, waitMs: 0 });
  });
});
