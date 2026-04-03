import { getPRByNotionTaskId, getLatestCodeSessionByNotionTaskId, getSetting, getTaskCache } from '../db/queries';

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
 * Pure, stateless function that derives a display status for a task.
 * Notion status is the primary source of truth for grouping.
 * Local signals (PR state, review verdict) are used only for enrichment
 * within the Notion-derived group, not for overriding it.
 * Exception: a merged or closed PR always results in 'done'.
 */
export function deriveDisplayStatus(input: TaskStatusInput): DisplayStatus {
  const {
    notionStatus,
    prState,
    reviewVerdict,
    reviewIterationCount,
    reviewIterationCap,
  } = input;

  // 1. done — PR merged or closed (terminal override, takes precedence over Notion)
  if (prState === 'merged' || prState === 'closed') {
    return 'done';
  }

  // 2. Notion status is the primary source of truth for grouping
  if (notionStatus.includes('Done')) return 'done';

  if (notionStatus.includes('In Review')) {
    // Enrich with review-specific sub-states within the In Review group
    if (reviewVerdict === 'approved' && prState === 'open') return 'ready_to_merge';
    if (reviewIterationCount >= reviewIterationCap) return 'needs_attention';
    return 'in_review';
  }

  if (notionStatus.includes('In Progress')) return 'in_progress';

  // 3. ready — default (includes 🗂️ Ready and any unrecognized status)
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
 * Reads the Notion status from the task cache so grouping respects Notion as source of truth.
 */
export function deriveDisplayStatusFromDb(notionTaskId: string): DisplayStatus {
  const prRow = getPRByNotionTaskId(notionTaskId);
  const sessionRow = getLatestCodeSessionByNotionTaskId(notionTaskId);

  let notionStatus = '';
  const taskCacheRow = getTaskCache(notionTaskId);
  if (taskCacheRow) {
    try {
      const task = JSON.parse(taskCacheRow.raw_json) as { status?: string };
      notionStatus = task.status ?? '';
    } catch {
      // ignore malformed cache
    }
  }

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
    notionStatus,
    codeSessionStatus: sessionRow?.status ?? null,
    prState: prRow?.state ?? null,
    prDraft: (prRow?.draft ?? 0) === 1,
    reviewVerdict,
    reviewIterationCount: prRow?.review_iteration ?? 0,
    reviewIterationCap: getReviewIterationCap(),
  });
}

