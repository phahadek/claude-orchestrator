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
