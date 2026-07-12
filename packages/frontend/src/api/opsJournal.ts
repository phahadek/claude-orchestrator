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

export const opsJournalApi = {
  listForMilestone(milestone: string): Promise<OpsJournalEntry[]> {
    return apiRequest<{ entries: OpsJournalEntry[] }>(
      `/api/ops-journal?milestone=${encodeURIComponent(milestone)}`,
    ).then((res) => res.entries);
  },

  /** Ops(N) button: launches one individual, dependency-ordered session per selected task. */
  launch(milestoneId: string, taskIds: string[]): Promise<OpsLaunchResult> {
    return apiRequest<OpsLaunchResult>('/api/ops/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestoneId, taskIds }),
    });
  },
};
