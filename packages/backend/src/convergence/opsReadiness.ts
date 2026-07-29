import { listOpsJournalEntries } from '../db/queries';
import type { OpsJournalState } from '../db/types';

/** Terminal state: the ops task no longer blocks milestone completion. */
const RESOLVED_STATE: OpsJournalState = 'resolved';

export interface OpsBlockingItem {
  task_id: string;
  state: OpsJournalState;
}

export interface OpsReadiness {
  status: 'green' | 'blocked';
  blocking: OpsBlockingItem[];
  blockingCount: number;
}

/** Headline output: green once every ops_journal row for this (project, milestone) is resolved. */
export function getOpsReadiness(project: string, milestone: string): OpsReadiness {
  const entries = listOpsJournalEntries().filter(
    (e) => e.project === project && e.milestone === milestone,
  );
  const blocking = entries
    .filter((e) => e.state !== RESOLVED_STATE)
    .map((e) => ({ task_id: e.task_id, state: e.state }));
  return {
    status: blocking.length === 0 ? 'green' : 'blocked',
    blocking,
    blockingCount: blocking.length,
  };
}

export interface OpsMilestoneReadiness {
  project: string;
  milestone: string;
  status: 'green' | 'blocked';
  blockingCount: number;
}

export interface ListOpsMilestoneReadinessOptions {
  project?: string;
}

interface OpsMilestoneGroup {
  project: string;
  milestone: string;
  blockingCount: number;
}

/** The multi-milestone / multi-project ops readiness rollup — mirrors gateService's listMilestoneReadiness. */
export function listOpsMilestoneReadiness(
  options: ListOpsMilestoneReadinessOptions = {},
): OpsMilestoneReadiness[] {
  const entries = options.project
    ? listOpsJournalEntries().filter((e) => e.project === options.project)
    : listOpsJournalEntries();

  const groups = new Map<string, OpsMilestoneGroup>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.project, entry.milestone]);
    const group = groups.get(key);
    const blocked = entry.state !== RESOLVED_STATE ? 1 : 0;
    if (group) {
      group.blockingCount += blocked;
    } else {
      groups.set(key, {
        project: entry.project,
        milestone: entry.milestone,
        blockingCount: blocked,
      });
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      project: group.project,
      milestone: group.milestone,
      status: (group.blockingCount === 0 ? 'green' : 'blocked') as
        | 'green'
        | 'blocked',
      blockingCount: group.blockingCount,
    }))
    .sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.milestone.localeCompare(b.milestone),
    );
}
