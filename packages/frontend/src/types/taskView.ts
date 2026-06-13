import type { CanonicalPauseReason } from '@claude-orchestrator/backend/src/db/pauseReason';

export type DisplayStatus =
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'needs_attention'
  | 'ready_to_merge'
  | 'done'
  | 'backlog';

export type PauseReason = CanonicalPauseReason;

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
    preReviewStage?: string | null;
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
