import { getPRByNotionTaskId, getLatestCodeSessionByNotionTaskId, getSetting } from '../db/queries';
import type { TaskView } from '../ws/types';

export type DisplayStatus =
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'needs_attention'
  | 'ready_to_merge'
  | 'done';

export interface TaskStatusInput {
  notionStatus: string;             // raw Notion status string
  codeSessionStatus: string | null; // 'running' | 'done' | 'error' | null
  prState: string | null;           // 'open' | 'merged' | 'closed' | null
  prDraft: boolean;                 // true if PR is draft
  reviewVerdict: string | null;     // 'approved' | 'needs_changes' | 'incomplete' | null
  reviewIterationCount: number;     // how many review cycles
  reviewIterationCap: number;       // configurable cap from settings
}

/**
 * Pure, stateless function that derives a display status for a task by
 * combining Notion status, session state, PR state, and review verdict.
 * Conditions are evaluated in priority order (most terminal first).
 */
export function deriveDisplayStatus(input: TaskStatusInput): DisplayStatus {
  const {
    codeSessionStatus,
    prState,
    reviewVerdict,
    reviewIterationCount,
    reviewIterationCap,
    notionStatus,
  } = input;

  // 1. done — PR merged or closed (terminal state)
  if (prState === 'merged' || prState === 'closed') {
    return 'done';
  }

  // 2. ready_to_merge — review approved, PR still open
  if (reviewVerdict === 'approved' && prState === 'open') {
    return 'ready_to_merge';
  }

  // 3. needs_attention — review iteration cap exceeded
  if (reviewIterationCount >= reviewIterationCap) {
    return 'needs_attention';
  }

  // 4. in_review — PR exists, not yet approved
  if (prState === 'open') {
    return 'in_review';
  }

  // 5. in_progress — code session running, no PR yet
  if (codeSessionStatus === 'running') {
    return 'in_progress';
  }

  // 6. ready — default (Notion status = Ready, no active code session)
  void notionStatus; // consumed for documentation; no runtime check needed
  return 'ready';
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

function getReviewIterationCap(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REVIEW_ITERATIONS;
}

/**
 * Fetch the live state for a Notion task from SQLite and derive its display status.
 * Returns null if no session or PR is found (i.e. task is not tracked in DB yet).
 */
export function deriveDisplayStatusFromDb(notionTaskId: string): DisplayStatus {
  const prRow = getPRByNotionTaskId(notionTaskId);
  const sessionRow = getLatestCodeSessionByNotionTaskId(notionTaskId);

  let reviewVerdict: string | null = null;
  if (prRow?.review_result) {
    try {
      const parsed = JSON.parse(prRow.review_result) as { verdict?: string };
      reviewVerdict = parsed.verdict ?? null;
    } catch {
      // ignore malformed review_result
    }
  }

  return deriveDisplayStatus({
    notionStatus: '',
    codeSessionStatus: sessionRow?.status ?? null,
    prState: prRow?.state ?? null,
    prDraft: (prRow?.draft ?? 0) === 1,
    reviewVerdict,
    reviewIterationCount: prRow?.review_iteration ?? 0,
    reviewIterationCap: getReviewIterationCap(),
  });
}

/**
 * Build a TaskView snapshot for a Notion task from SQLite — used as the patch payload
 * in task_updated messages.
 */
export function buildTaskViewFromDb(notionTaskId: string): Partial<TaskView> {
  const prRow = getPRByNotionTaskId(notionTaskId);
  const sessionRow = getLatestCodeSessionByNotionTaskId(notionTaskId);

  let reviewVerdict: string | null = null;
  if (prRow?.review_result) {
    try {
      const parsed = JSON.parse(prRow.review_result) as { verdict?: string };
      reviewVerdict = parsed.verdict ?? null;
    } catch {
      // ignore malformed review_result
    }
  }

  const patch: Partial<TaskView> = {};
  if (sessionRow) patch.codeSession = { status: sessionRow.status };
  if (prRow?.pr_url) patch.prUrl = prRow.pr_url;
  if (prRow?.state) patch.prState = prRow.state;
  if (reviewVerdict) patch.reviewVerdict = reviewVerdict;
  return patch;
}
