import { recordEvent } from '../audit/AuditLog';
import { resolveCapabilityDisqualification } from '../audit/capabilityDispositionMining';
import {
  getOpsJournalEntry,
  listOpsJournalEntries,
  upsertOpsJournalEntry,
  deleteOpsJournalEntry,
} from '../db/queries';
import type { OpsJournalRow, OpsJournalState } from '../db/types';

export type OpsState = OpsJournalState;

type OpsDisposition = 'pass' | 'blocked-pending-fix' | 'pass-with-caveat';

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
 * applied-pending-confirm → resolved. candidate → resolved and
 * staged-proposal → resolved are also allowed directly, for Investigation
 * work that reaches a "no change needed" decision — there is no applied
 * change to reconcile through applied-pending-confirm, so the proposal (the
 * recommendation itself) closes straight to resolved once the operator
 * approves the staged closing set. blocked / incident-frozen are freezes
 * reachable from (and returning to) any non-terminal state. resolved is
 * terminal.
 */
export const ALLOWED_TRANSITIONS: Record<OpsState, OpsState[]> = {
  pending: ['candidate', 'blocked', 'incident-frozen'],
  candidate: [
    'staged-proposal',
    'pending',
    'blocked',
    'incident-frozen',
    'resolved',
  ],
  'staged-proposal': [
    'applied-pending-confirm',
    'candidate',
    'blocked',
    'incident-frozen',
    'resolved',
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

/**
 * Session-reachable terminal ops_journal states, by task Type — resolved at
 * grooming (task 3b022f91-52f3-8121). A dispatched/interactive 🔧
 * Operational run drives the journal to applied-pending-confirm and leaves
 * the final applied-pending-confirm -> resolved confirmation to the
 * operator, so its own session-reachable terminal target is
 * applied-pending-confirm, blocked, or resolved. A 🔎 Investigation
 * self-verifies in-session — there is no operator-applied change to
 * reconcile — so its terminal target is resolved or blocked. Any other (or
 * uncached/missing) task Type falls back to the Operational set, the more
 * permissive of the two. Used by PlanningOrchestrator.checkTerminal to nudge
 * a session that reaches terminal with its journal still at an intermediate
 * waypoint (pending / candidate / staged-proposal, or for Investigation also
 * applied-pending-confirm) instead of letting it settle half-finished.
 */
const INVESTIGATION_SESSION_TERMINAL_STATES: ReadonlySet<OpsState> = new Set([
  'resolved',
  'blocked',
]);

const OPERATIONAL_SESSION_TERMINAL_STATES: ReadonlySet<OpsState> = new Set([
  'applied-pending-confirm',
  'resolved',
  'blocked',
]);

export function isSessionTerminalOpsState(
  state: OpsState,
  taskType: string | null | undefined,
): boolean {
  const allowed =
    taskType === '🔎 Investigation'
      ? INVESTIGATION_SESSION_TERMINAL_STATES
      : OPERATIONAL_SESSION_TERMINAL_STATES;
  return allowed.has(state);
}

/**
 * Thrown by foldOpsTransitionChain when a hop within the chain itself is
 * illegal — in practice unreachable from the stage-time caller, which only
 * ever folds a chain of already-individually-validated staged intents, but
 * kept as a hard failure (rather than silently stopping the fold) so a bug
 * upstream surfaces immediately instead of validating the next hop against
 * the wrong state.
 */
export class InvalidOpsTransitionChainError extends Error {
  constructor(from: OpsState, to: OpsState) {
    super(`ops_journal: invalid transition ${from} -> ${to} in staged chain`);
    this.name = 'InvalidOpsTransitionChainError';
  }
}

/**
 * The state a sequence of not-yet-applied journal.setState targets would
 * leave an entry in, folding forward from `from` one hop at a time via
 * isValidOpsTransition — the chain-aware read that lets a staged (but not
 * yet applied) transition serve as the "current state" for validating the
 * next staged transition in the same turn, instead of only ever reading the
 * applied row. An empty chain returns `from` unchanged.
 */
export function foldOpsTransitionChain(
  from: OpsState,
  chain: readonly OpsState[],
): OpsState {
  let current = from;
  for (const next of chain) {
    if (!isValidOpsTransition(current, next)) {
      throw new InvalidOpsTransitionChainError(current, next);
    }
    current = next;
  }
  return current;
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

/** All journal entries for a given milestone, as surfaced to the Ops(N) staged-intent view. */
export function listEntriesForMilestone(milestone: string): OpsJournalEntry[] {
  return listOpsJournalEntries()
    .filter((row) => row.milestone === milestone)
    .map(rowToEntry);
}

/**
 * Typed in-place field writer for one journal entry — replaces ops-journal-set.mjs.
 * The entry must already exist (seeded by reconcileJournal); this never creates one.
 */
export function setEntryState(
  taskId: string,
  state: OpsState,
  fields?: Partial<Omit<OpsJournalEntry, 'taskId' | 'state' | 'updatedAt'>>,
): OpsState {
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
  // The sole hook that lifts or hardens a capability-disposition-trail
  // disqualification (see audit/capabilityDispositionMining.ts) — a no-op
  // for every ops_journal entry not tied to one. Runs for both the
  // interactive route (routes/opsJournal.ts) and the staged journal.setState
  // -> "resolved" commit path (routes/stagedIntents.ts), since both funnel
  // through this function.
  if (state === 'resolved') {
    resolveCapabilityDisqualification(
      taskId,
      updated.resolution,
      updated.updatedAt,
    );
  }
  recordEvent({
    event_type: 'ops_journal_state_changed',
    actor_type: 'system',
    task_id: taskId,
    project_id: updated.project,
    payload: { from: current.state, to: state, milestone: updated.milestone },
  });
  return current.state;
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
