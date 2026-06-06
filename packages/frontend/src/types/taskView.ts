export type DisplayStatus =
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'needs_attention'
  | 'ready_to_merge'
  | 'done'
  | 'backlog';

export type PauseReason =
  | 'max_reviews'
  | 'stuck_timeout'
  | 'ci_failing'
  | 'ci_billing_blocked'
  | 'auto_merge_failed'
  | 'pr_closed'
  | 'review_failed'
  | 'api_overloaded'
  | 'merge_conflict'
  | 'awaiting_human_approval'
  | 'human_changes_requested'
  | 'pr_body_invalid'
  | 'attribution_missing'
  | 'audit_findings'
  | 'pr_creation_failed'
  | 'stalled_idle'
  | 'notion_done_update_stuck'
  | 'launch_failed';

export interface TaskView {
  taskId: string;
  taskName: string;
  notionStatus: string;
  displayStatus: DisplayStatus;
  pauseReason: PauseReason | null;
  priority: string;
  notionUrl: string;
  taskType: string;
  blocked: boolean;
  blockerNames: string[];
  wave: number;
  codeSession: {
    sessionId: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    lastMessage: string;
    inputTokens: number;
    outputTokens: number;
    context_occupancy_tokens?: number;
    compaction_count?: number;
    model?: string | null;
  } | null;
  pr: {
    prNumber: number;
    prUrl: string;
    title: string;
    headBranch: string;
    baseBranch: string;
    state: string;
    draft: boolean;
    mergeState: string | null;
  } | null;
  review: {
    sessionId: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    iterationCount: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
  totalTokens: { input: number; output: number };
}
