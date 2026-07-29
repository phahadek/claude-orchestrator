import type { TaskView } from '../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';

type BurndownState = 'pending' | 'staged' | 'done';

export const PHASE_ORDER = [
  'design',
  'grooming',
  'code',
  'investigation',
  'ops',
  'gate',
] as const;

export type PhaseKey = (typeof PHASE_ORDER)[number];

export const PHASE_LABELS: Record<PhaseKey, string> = {
  design: 'Design',
  grooming: 'Grooming',
  code: 'Code',
  investigation: 'Investigation',
  ops: 'Ops',
  gate: 'Gate items',
};

/** Task types that map to a phase once a task has cleared grooming (Ready or beyond). */
const TYPE_TO_PHASE: Record<string, PhaseKey> = {
  '📐 Design': 'design',
  '📋 Planning': 'design',
  '💻 Code': 'code',
  '🧪 Testing': 'code',
  '🔧 Operational': 'ops',
  '🔎 Investigation': 'investigation',
};

/** Statuses that count as "still short of Ready" — grouped into the Grooming phase regardless of type. */
const PRE_READY_STATUSES = new Set(['backlog']);

/** Statuses excluded entirely — closed out, not blocking the milestone. */
const CLOSED_STATUSES = new Set(['deferred']);

export interface PhaseStateCounts {
  pending: number;
  staged: number;
  done: number;
}

export interface PhaseSegmentData {
  phase: PhaseKey;
  counts: PhaseStateCounts;
  blockerCount: number;
}

function emptyCounts(): PhaseStateCounts {
  return { pending: 0, staged: 0, done: 0 };
}

/** The burndown phase a task belongs to, or null when it's closed out (deferred) or its type maps to none. */
export function phaseForTask(task: TaskView): PhaseKey | null {
  if (CLOSED_STATUSES.has(task.displayStatus)) return null;
  if (PRE_READY_STATUSES.has(task.displayStatus)) return 'grooming';
  return TYPE_TO_PHASE[task.taskType] ?? null;
}

function stateForTask(task: TaskView): BurndownState {
  if (task.displayStatus === 'done') return 'done';
  if (task.displayStatus === 'ready') return 'pending';
  return 'staged';
}

/**
 * Derives the per-phase x per-state breakdown from the milestone's task
 * views and the gate axis of its convergence read. No backend "shape" for
 * this exists yet, so it's computed client-side from data already scoped to
 * the active project + board.
 */
export function computePhaseBurndown(
  tasks: TaskView[],
  convergence: MilestoneConvergence | null,
): Record<PhaseKey, PhaseSegmentData> {
  const result = {} as Record<PhaseKey, PhaseSegmentData>;
  for (const phase of PHASE_ORDER) {
    result[phase] = { phase, counts: emptyCounts(), blockerCount: 0 };
  }

  for (const task of tasks) {
    const phase = phaseForTask(task);
    if (!phase) continue;

    const state = stateForTask(task);
    result[phase].counts[state] += 1;
    if (task.blocked) {
      result[phase].blockerCount += 1;
    }
  }

  const gate = convergence?.axes.gate;
  if (gate) {
    result.gate.counts.pending = gate.blockingCount;
    result.gate.blockerCount = gate.blockingCount;
  }

  return result;
}

export function phaseTotal(counts: PhaseStateCounts): number {
  return counts.pending + counts.staged + counts.done;
}
