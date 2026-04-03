export type DisplayStatus =
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'needs_attention'
  | 'ready_to_merge'
  | 'done'
  | 'backlog';

export interface TaskView {
  taskId: string;
  taskName: string;
  notionStatus: string;
  displayStatus: DisplayStatus;
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
  } | null;
  pr: {
    prNumber: number;
    prUrl: string;
    title: string;
    headBranch: string;
    baseBranch: string;
    state: string;
    draft: boolean;
  } | null;
  review: {
    sessionId: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    iterationCount: number;
  } | null;
}
