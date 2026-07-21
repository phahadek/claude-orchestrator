import { apiRequest } from './projects';

type OpsState =
  | 'pending'
  | 'candidate'
  | 'staged-proposal'
  | 'applied-pending-confirm'
  | 'blocked'
  | 'incident-frozen'
  | 'resolved';

/** One row of the per-task ops_journal, as surfaced to the Ops(N) staged view. */
export interface OpsJournalEntry {
  taskId: string;
  project: string;
  milestone: string;
  state: OpsState;
  disposition?: string;
  workedIn?: unknown;
  evidence?: unknown;
  findingOrProposal?: unknown;
  falsification?: unknown;
  filedFollowons?: unknown;
  needsFromOperator?: unknown;
  resolution?: unknown;
  updatedAt: string;
}

export interface OpsLaunchResult {
  launched: string[];
  deferred: string[];
}

/** Workflow the Groom(N) / Ops(N) launcher buttons dispatch — resolved to a sessionType server-side. */
export type PlanningWorkflow = 'groom' | 'design' | 'ops' | 'investigation';

export const opsJournalApi = {
  listForMilestone(milestone: string): Promise<OpsJournalEntry[]> {
    return apiRequest<{ entries: OpsJournalEntry[] }>(
      `/api/ops-journal?milestone=${encodeURIComponent(milestone)}`,
    ).then((res) => res.entries);
  },

  /**
   * Groom(N) / Ops(N) buttons: launches one individual, dependency-ordered
   * planning session per selected task via the unified planning-launch route.
   */
  launch(
    workflow: PlanningWorkflow,
    projectId: string,
    milestoneId: string,
    taskIds: string[],
  ): Promise<OpsLaunchResult> {
    return apiRequest<OpsLaunchResult>('/api/planning/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow,
        projectId,
        milestone: milestoneId,
        taskIds,
      }),
    });
  },
};
