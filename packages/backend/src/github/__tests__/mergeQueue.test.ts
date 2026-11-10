import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueued = vi.hoisted(() => new Map<string, number>());

vi.mock('../../db/queries', () => ({
  getMergeQueueCandidatePRs: vi.fn(),
  clearPrEnqueued: vi.fn((n: number, repo: string) => {
    enqueued.delete(`${repo}#${n}`);
  }),
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

import {
  getMergeQueueCandidatePRs as getApprovedOpenPRs,
  getApprovedLocalBranches,
} from '../../db/queries';
import {
  checkLocalBranchQueueHead,
  checkPrQueueHead,
  computeMergeQueues,
  isPrMergeQueueHead,
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

  it('a conflicting or gate-bypassed PR does not stall the PRs behind it', () => {
    const dirty = { pr_number: 1, repo: 'o/r', merge_state: 'dirty' } as never;
    const bypassed = {
      pr_number: 2,
      repo: 'o/r',
      head_sha: 'h',
      review_result: JSON.stringify({
        verdict: 'approved',
        gateBypassed: { headSha: 'h' },
      }),
    } as never;
    vi.mocked(getApprovedOpenPRs).mockReturnValue([dirty, bypassed, pr(3)]);
    const queue = computeMergeQueues(100).get('p1')!;
    expect(queue.map((e) => (e.kind === 'pr' ? e.prNumber : -1))).toEqual([3]);
    expect(checkPrQueueHead(3, 'o/r', 200).allowed).toBe(true);
  });

  it('holds out mergeable=0 with a non-clean state (unknown, ci_failed, blocked) but not clean or mergeable NULL/1', () => {
    const mk = (n: number, mergeable: number | null, state: string | null) =>
      ({
        pr_number: n,
        repo: 'o/r',
        mergeable,
        merge_state: state,
      }) as never;
    vi.mocked(getApprovedOpenPRs).mockReturnValue([
      mk(1, 0, 'unknown'),
      mk(2, 0, 'ci_failed'),
      mk(3, 0, 'blocked'),
      mk(4, 0, 'dirty'),
      mk(5, 0, 'clean'),
      mk(6, null, 'unknown'),
      mk(7, 1, 'unknown'),
    ]);
    const queue = computeMergeQueues(100).get('p1')!;
    expect(queue.map((e) => (e.kind === 'pr' ? e.prNumber : -1))).toEqual([
      5, 6, 7,
    ]);
  });

  it('a conflicting earlier-enqueued PR does not block a later clean PR, and rejoins at the back', () => {
    const conflicting = (m: number | null) =>
      ({
        pr_number: 1,
        repo: 'o/r',
        mergeable: m,
        merge_state: m === 0 ? 'unknown' : 'clean',
      }) as never;
    vi.mocked(getApprovedOpenPRs).mockReturnValue([conflicting(1)]);
    computeMergeQueues(100);
    vi.mocked(getApprovedOpenPRs).mockReturnValue([conflicting(0), pr(2)]);
    expect(checkPrQueueHead(2, 'o/r', 200).allowed).toBe(true);
    expect(enqueued.has('o/r#1')).toBe(false);

    vi.mocked(getApprovedOpenPRs).mockReturnValue([conflicting(1), pr(2)]);
    const queue = computeMergeQueues(300).get('p1')!;
    expect(queue.map((e) => (e.kind === 'pr' ? e.prNumber : -1))).toEqual([
      2, 1,
    ]);
  });

  it('isPrMergeQueueHead is true only for the actual head, false when not queued', () => {
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(1)]);
    computeMergeQueues(100);
    vi.mocked(getApprovedOpenPRs).mockReturnValue([pr(2), pr(1)]);
    expect(isPrMergeQueueHead(1, 'o/r', 200)).toBe(true);
    expect(isPrMergeQueueHead(2, 'o/r', 200)).toBe(false);
    expect(isPrMergeQueueHead(99, 'o/r', 200)).toBe(false);
    expect(isPrMergeQueueHead(1, 'x/y', 200)).toBe(false);
  });

  it('an unqueued PR is not blocked', () => {
    expect(checkPrQueueHead(99, 'o/r')).toEqual({ allowed: true, waitMs: 0 });
  });
});
