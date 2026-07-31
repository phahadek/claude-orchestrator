import type { TaskView } from '../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';

/** States used by every phase except grooming — a task's progress through its own type-mapped phase. */
type BurndownState = 'pending' | 'staged' | 'done';

/**
 * Grooming's internal states, computed client-side from fields already on
 * TaskView (blocked / planningSession) — see docs/tasks resolution notes.
 * `blocked` takes priority over `inGrooming` when both are true, since a
 * blocked task needs attention regardless of an in-flight groom session.
 */
type GroomingState = 'blocked' | 'inGrooming' | 'untouched';

export type SegmentState = BurndownState | GroomingState;

export const PHASE_ORDER = [
  'design',
  'grooming',
  'code',
  'investigation',
  'ops',
  'gate',
] as const;

export type PhaseKey = (typeof PHASE_ORDER)[number];

/** Per-phase ordered list of segment states to render, left to right. */
export const PHASE_SEGMENT_ORDER: Record<PhaseKey, readonly SegmentState[]> =
  {
    design: ['pending', 'staged', 'done'],
    grooming: ['blocked', 'inGrooming', 'untouched'],
    code: ['pending', 'staged', 'done'],
    investigation: ['pending', 'staged', 'done'],
    ops: ['pending', 'staged', 'done'],
    gate: ['pending'],
  };

/** The one PhaseKey that isn't a task filter — gate items are gate_item rows, not tasks (see isGatePhase). */
const GATE_PHASE: PhaseKey = 'gate';

/**
 * True when the burndown's selected bar is the gate-items bar. Unlike the
 * other bars, 'gate' has no corresponding task phase (phaseForTask never
 * returns it) — selecting it must route to the gate panel, not filter tasks.
 */
export function isGatePhase(phase: string | null): boolean {
  return phase === GATE_PHASE;
}

export const PHASE_LABELS: Record<PhaseKey, string> = {
  design: 'Design',
  grooming: 'Grooming',
  code: 'Code',
  investigation: 'Investigation',
  ops: 'Ops',
  gate: 'Gate items',
};

export const SEGMENT_STATE_LABELS: Record<SegmentState, string> = {
  pending: 'Pending',
  staged: 'Staged',
  done: 'Done',
  blocked: 'Blocked',
  inGrooming: 'In grooming',
  untouched: 'Untouched',
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

export interface PhaseSegmentData {
  phase: PhaseKey;
  counts: Partial<Record<SegmentState, number>>;
  /**
   * A warning quantity distinct from the segment total — for task-backed
   * phases, the count of blocked tasks in this phase; for gate, the count of
   * items sitting in a bespoke (unrecognized) state that need re-disposition.
   * Never equal to the bar's total by construction.
   */
  blockerCount: number;
}

function emptyCounts(): Partial<Record<SegmentState, number>> {
  return {};
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

/** Grooming's internal state for a pre-Ready task — see GroomingState. */
function groomingStateForTask(task: TaskView): GroomingState {
  if (task.blocked) return 'blocked';
  if (
    task.planningSession?.sessionType === 'groom' &&
    task.planningSession.endedAt === null
  ) {
    return 'inGrooming';
  }
  return 'untouched';
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

    const state: SegmentState =
      phase === 'grooming' ? groomingStateForTask(task) : stateForTask(task);
    const counts = result[phase].counts;
    counts[state] = (counts[state] ?? 0) + 1;
    if (task.blocked) {
      result[phase].blockerCount += 1;
    }
  }

  const gate = convergence?.axes.gate;
  if (gate) {
    result.gate.counts.pending = gate.blockingCount;
    result.gate.blockerCount = gate.bespokeCount;
  }

  return result;
}

export function phaseTotal(counts: Partial<Record<SegmentState, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

/**
 * The tasks a phase's warning badge refers to — the same population counted
 * into blockerCount for task-backed phases. Not meaningful for gate (see
 * isGatePhase); callers must route gate's warning to the gate panel instead
 * of calling this.
 */
export function flaggedTasksForPhase(
  phase: PhaseKey,
  tasks: TaskView[],
): TaskView[] {
  return tasks.filter((task) => task.blocked && phaseForTask(task) === phase);
}
