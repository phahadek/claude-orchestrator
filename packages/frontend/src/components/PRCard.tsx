// Legacy compatibility shim. New code should use WorkItemCard directly.
import { WorkItemCard } from './WorkItemCard';
import type { PRWorkItem, WorkItemCardProps } from './WorkItemCard';

export type { PRReviewResult, PRReviewDimension } from './WorkItemCard';

// Legacy flat type (no 'type' discriminant) — used by existing tests and external callers.
export interface PRListItem {
  prNumber: number;
  prUrl: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  notionTaskId: string | null;
  notionTaskTitle: string | null;
  sessionId: string | null;
  reviewSessionId: string | null;
  repo: string;
  reviewResult: import('./WorkItemCard').PRReviewResult | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviewIteration?: number;
  mergeState: string | null;
  failingChecks?: string[] | null;
  pauseReason?: string | null;
}

export type PRCardProps = Omit<WorkItemCardProps, 'item'> & { pr: PRListItem };

export function PRCard({ pr, ...rest }: PRCardProps) {
  const item: PRWorkItem = {
    ...pr,
    type: 'pr',
    branchName: pr.headBranch ?? '',
    autoMergeEnabled: false,
  };
  return <WorkItemCard item={item} {...rest} />;
}
