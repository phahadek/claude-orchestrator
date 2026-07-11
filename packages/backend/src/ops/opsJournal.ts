import { recordEvent } from '../audit/AuditLog';
import {
  getOpsJournalEntry,
  listOpsJournalEntries,
  listOpsJournalEntriesForMilestone,
  upsertOpsJournalEntry,
  deleteOpsJournalEntry,
} from '../db/queries';
import type { OpsJournalRow, OpsJournalState } from '../db/types';

export type OpsState = OpsJournalState;

export const OPS_STATES: readonly OpsState[] = [
  'pending',
  'candidate',
  'staged-proposal',
  'applied-pending-confirm',
  'blocked',
  'incident-frozen',
  'resolved',
];

export type OpsDisposition =
  | 'pass'
  | 'blocked-pending-fix'
  | 'pass-with-caveat';

export interface OpsJournalEntry {
  taskId: string;
  project: string;
  milestone: string;
  state: OpsState;
  disposition?: OpsDisposition;
  workedIn?: unknown;
  evidence?: unknown;
  findingOrProposal?: unknown;
  falsification?: unknown;
  filedFollowons?: unknown;
  needsFromOperator?: unknown;
  resolution?: unknown;
  updatedAt: string;
}

/** One row per task on the live board, as surfaced to reconcileJournal. */
export interface OpsBoardTaskRow {
  taskId: string;
  project: string;
  milestone: string;
}

/**
 * The normal path walks pending → candidate → staged-proposal →
 * applied-pending-confirm → resolved. blocked / incident-frozen are freezes
 * reachable from (and returning to) any non-terminal state. resolved is terminal.
 */
const ALLOWED_TRANSITIONS: Record<OpsState, OpsState[]> = {
  pending: ['candidate', 'blocked', 'incident-frozen'],
  candidate: ['staged-proposal', 'pending', 'blocked', 'incident-frozen'],
  'staged-proposal': [
    'applied-pending-confirm',
    'candidate',
    'blocked',
    'incident-frozen',
  ],
  'applied-pending-confirm': [
    'resolved',
    'staged-proposal',
    'blocked',
    'incident-frozen',
  ],
  blocked: [
    'pending',
    'candidate',
    'staged-proposal',
    'applied-pending-confirm',
    'incident-frozen',
    'resolved',
  ],
  'incident-frozen': [
    'pending',
    'candidate',
    'staged-proposal',
    'applied-pending-confirm',
    'blocked',
    'resolved',
  ],
  resolved: [],
};

export function isValidOpsTransition(from: OpsState, to: OpsState): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function rowToEntry(row: OpsJournalRow): OpsJournalEntry {
  return {
    taskId: row.task_id,
    project: row.project,
    milestone: row.milestone,
    state: row.state,
    disposition: (row.disposition as OpsDisposition | null) ?? undefined,
    workedIn: parseJson(row.worked_in),
    evidence: parseJson(row.evidence),
    findingOrProposal: parseJson(row.finding_or_proposal),
    falsification: parseJson(row.falsification),
    filedFollowons: parseJson(row.filed_followons),
    needsFromOperator: parseJson(row.needs_from_operator),
    resolution: parseJson(row.resolution),
    updatedAt: row.updated_at,
  };
}

function entryToRow(entry: OpsJournalEntry): OpsJournalRow {
  return {
    task_id: entry.taskId,
    project: entry.project,
    milestone: entry.milestone,
    state: entry.state,
    disposition: entry.disposition ?? null,
    worked_in: stringifyJson(entry.workedIn),
    evidence: stringifyJson(entry.evidence),
    finding_or_proposal: stringifyJson(entry.findingOrProposal),
    falsification: stringifyJson(entry.falsification),
    filed_followons: stringifyJson(entry.filedFollowons),
    needs_from_operator: stringifyJson(entry.needsFromOperator),
    resolution: stringifyJson(entry.resolution),
    updated_at: entry.updatedAt,
  };
}

export function getEntry(taskId: string): OpsJournalEntry | undefined {
  const row = getOpsJournalEntry(taskId);
  return row ? rowToEntry(row) : undefined;
}

export function listEntries(): OpsJournalEntry[] {
  return listOpsJournalEntries().map(rowToEntry);
}

export function listEntriesForMilestone(
  project: string,
  milestone: string,
): OpsJournalEntry[] {
  return listOpsJournalEntriesForMilestone(project, milestone).map(rowToEntry);
}

/**
 * Typed in-place field writer for one journal entry — replaces ops-journal-set.mjs.
 * The entry must already exist (seeded by reconcileJournal); this never creates one.
 */
export function setEntryState(
  taskId: string,
  state: OpsState,
  fields?: Partial<Omit<OpsJournalEntry, 'taskId' | 'state' | 'updatedAt'>>,
): void {
  const row = getOpsJournalEntry(taskId);
  if (!row) {
    throw new Error(
      `ops_journal: no entry for task ${taskId} — reconcileJournal must seed it first`,
    );
  }
  const current = rowToEntry(row);
  if (!isValidOpsTransition(current.state, state)) {
    throw new Error(
      `ops_journal: invalid transition ${current.state} -> ${state} for task ${taskId}`,
    );
  }
  const updated: OpsJournalEntry = {
    ...current,
    ...fields,
    taskId,
    state,
    updatedAt: new Date().toISOString(),
  };
  upsertOpsJournalEntry(entryToRow(updated));
  recordEvent({
    event_type: 'ops_journal_state_changed',
    actor_type: 'system',
    task_id: taskId,
    project_id: updated.project,
    payload: { from: current.state, to: state, milestone: updated.milestone },
  });
}

/**
 * Rebuilds the journal against the live board: entries for tasks no longer
 * present (Done / Deferred / removed) are dropped, still-open tasks keep their
 * worked fields untouched, and newly-eligible tasks are seeded at "pending".
 */
export function reconcileJournal(liveBoard: OpsBoardTaskRow[]): void {
  const liveIds = new Set(liveBoard.map((t) => t.taskId));
  const existing = listOpsJournalEntries();

  for (const row of existing) {
    if (!liveIds.has(row.task_id)) {
      deleteOpsJournalEntry(row.task_id);
      recordEvent({
        event_type: 'ops_journal_entry_dropped',
        actor_type: 'system',
        task_id: row.task_id,
        project_id: row.project,
        payload: { milestone: row.milestone, state: row.state },
      });
    }
  }

  const existingIds = new Set(existing.map((r) => r.task_id));
  for (const t of liveBoard) {
    if (!existingIds.has(t.taskId)) {
      const seeded: OpsJournalEntry = {
        taskId: t.taskId,
        project: t.project,
        milestone: t.milestone,
        state: 'pending',
        updatedAt: new Date().toISOString(),
      };
      upsertOpsJournalEntry(entryToRow(seeded));
      recordEvent({
        event_type: 'ops_journal_entry_seeded',
        actor_type: 'system',
        task_id: t.taskId,
        project_id: t.project,
        payload: { milestone: t.milestone },
      });
    }
  }
}
