import { getProjectByGithubRepo, getProjectById } from '../config';
import {
  clearPrEnqueued,
  ensureLocalBranchEnqueued,
  ensurePrEnqueued,
  getApprovedLocalBranches,
  getMergeQueueCandidatePRs,
} from '../db/queries';
import type { PullRequestRow } from '../db/types';

export type MergeQueueEntry =
  | {
      kind: 'pr';
      projectId: string;
      prNumber: number;
      repo: string;
      row: PullRequestRow;
      enqueuedAt: number;
    }
  | { kind: 'local'; projectId: string; id: number; enqueuedAt: number };

/**
 * Rows that cannot merge until someone else acts (conflicting with base, or an
 * approval that bypassed a failed gate at this head) must not sit at the head
 * and stall the PRs behind them; they rejoin once the blocker clears.
 */
function isHeldOutOfQueue(pr: PullRequestRow): boolean {
  if (pr.merge_state === 'dirty') return true;
  if (pr.mergeable === 0 && pr.merge_state !== 'clean') return true;
  try {
    const parsed = pr.review_result
      ? (JSON.parse(pr.review_result) as {
          gateBypassed?: { headSha?: string | null };
        })
      : undefined;
    const bypass = parsed?.gateBypassed;
    return Boolean(
      bypass && (!bypass.headSha || bypass.headSha === pr.head_sha),
    );
  } catch {
    return false;
  }
}

/**
 * Derived per-project FIFO: merge-ready, auto-merge-enabled PRs and local
 * branches ordered by their persisted enqueue timestamp. Not a separate store —
 * a restart rebuilds the same order from the columns. A paused row drops out of
 * the eligible set (and so out of the queue), which is how a failing head is
 * ejected and the next entry becomes head. Only merge-blocking pauses eject;
 * an advisory (blocks_merge:false) pause leaves the PR queued.
 */
export function computeMergeQueues(
  now: number = Date.now(),
): Map<string, MergeQueueEntry[]> {
  const queues = new Map<string, MergeQueueEntry[]>();
  const push = (entry: MergeQueueEntry): void => {
    const list = queues.get(entry.projectId) ?? [];
    list.push(entry);
    queues.set(entry.projectId, list);
  };

  for (const pr of getMergeQueueCandidatePRs()) {
    if (isHeldOutOfQueue(pr)) {
      clearPrEnqueued(pr.pr_number, pr.repo);
      continue;
    }
    const project = getProjectByGithubRepo(pr.repo);
    if (!project?.autoMergeEnabled) continue;
    push({
      kind: 'pr',
      projectId: project.id,
      prNumber: pr.pr_number,
      repo: pr.repo,
      row: pr,
      enqueuedAt: ensurePrEnqueued(pr.pr_number, pr.repo, now),
    });
  }
  for (const lb of getApprovedLocalBranches()) {
    if (!getProjectById(lb.project_id)) continue;
    push({
      kind: 'local',
      projectId: lb.project_id,
      id: lb.id,
      enqueuedAt: ensureLocalBranchEnqueued(lb.id, now),
    });
  }

  const tieKey = (e: MergeQueueEntry): number =>
    e.kind === 'pr' ? e.prNumber : 1e12 + e.id;
  for (const list of queues.values()) {
    list.sort((a, b) => a.enqueuedAt - b.enqueuedAt || tieKey(a) - tieKey(b));
  }
  return queues;
}

export type QueueDecision =
  | { allowed: true; waitMs: number }
  | { allowed: false; headLabel: string };

function label(e: MergeQueueEntry): string {
  return e.kind === 'pr' ? `PR #${e.prNumber}` : `local branch #${e.id}`;
}

/** True only when the PR is actually the head of its project's queue; false when not queued. */
export function isPrMergeQueueHead(
  prNumber: number,
  repo: string,
  now: number = Date.now(),
): boolean {
  const project = getProjectByGithubRepo(repo);
  if (!project) return false;
  const head = (computeMergeQueues(now).get(project.id) ?? [])[0];
  return (
    head?.kind === 'pr' && head.prNumber === prNumber && head.repo === repo
  );
}

/** "May merge" question: true when the PR is the head, or not queued at all. */
export function checkPrQueueHead(
  prNumber: number,
  repo: string,
  now: number = Date.now(),
): QueueDecision {
  const project = getProjectByGithubRepo(repo);
  if (!project) return { allowed: true, waitMs: 0 };
  const queue = computeMergeQueues(now).get(project.id) ?? [];
  const self = queue.find(
    (e) => e.kind === 'pr' && e.prNumber === prNumber && e.repo === repo,
  );
  if (!self) return { allowed: true, waitMs: 0 };
  if (queue[0] !== self) return { allowed: false, headLabel: label(queue[0]) };
  return { allowed: true, waitMs: Math.max(0, now - self.enqueuedAt) };
}

export function checkLocalBranchQueueHead(
  id: number,
  projectId: string,
  now: number = Date.now(),
): QueueDecision {
  const queue = computeMergeQueues(now).get(projectId) ?? [];
  const self = queue.find((e) => e.kind === 'local' && e.id === id);
  if (!self) return { allowed: true, waitMs: 0 };
  if (queue[0] !== self) return { allowed: false, headLabel: label(queue[0]) };
  return { allowed: true, waitMs: Math.max(0, now - self.enqueuedAt) };
}
