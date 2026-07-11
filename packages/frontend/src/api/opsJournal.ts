import { apiRequest } from './projects';

export type OpsState =
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

export const opsJournalApi = {
  listForMilestone(milestone: string): Promise<OpsJournalEntry[]> {
    return apiRequest<{ entries: OpsJournalEntry[] }>(
      `/api/ops-journal?milestone=${encodeURIComponent(milestone)}`,
    ).then((res) => res.entries);
  },
};
