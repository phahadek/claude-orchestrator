import type { TaskView } from '../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';

/** A task's progress through its own type-mapped phase; Backlog tasks are 'grooming'. */
export type BurndownState = 'grooming' | 'pending' | 'staged' | 'done';

/** Gate's own state-machine vocabulary (see gateService.ts GATE_STATES), rendered in full so resolved items are visible alongside outstanding ones. */
type GateState =
  | 'open'
  | 'runnable'
  | 'pendingApproval'
  | 'pending'
  | 'pass'
  | 'fail'
  | 'deferred'
  | 'discarded';

export type SegmentState = BurndownState | GateState;

/** Maps a gate item's raw state string (gateService.ts) to its SegmentState key. */
export const GATE_STATE_KEY: Record<string, GateState> = {
  open: 'open',
  runnable: 'runnable',
  'pending-approval': 'pendingApproval',
  pending: 'pending',
  pass: 'pass',
  fail: 'fail',
  deferred: 'deferred',
  discarded: 'discarded',
};

export const PHASE_ORDER = [
  'design',
  'code',
  'ops',
  'gate',
] as const;

export type PhaseKey = (typeof PHASE_ORDER)[number];

export const TASK_STATE_ORDER: readonly BurndownState[] = [
  'grooming',
  'pending',
  'staged',
  'done',
];

/** Per-phase ordered list of segment states to render, left to right. */
export const PHASE_SEGMENT_ORDER: Record<PhaseKey, readonly SegmentState[]> = {
  design: TASK_STATE_ORDER,
  code: TASK_STATE_ORDER,
  ops: TASK_STATE_ORDER,
  gate: [
    'open',
    'runnable',
    'pendingApproval',
    'pending',
    'pass',
    'fail',
    'deferred',
    'discarded',
  ],
};

/** The one PhaseKey that isn't a task filter — gate items are gate_item rows, not tasks (see isGatePhase). */
export const GATE_PHASE: PhaseKey = 'gate';

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
  code: 'Code',
  ops: 'Investigation & Ops',
  gate: 'Gate items',
};

export const SEGMENT_STATE_LABELS: Record<SegmentState, string> = {
  grooming: 'Grooming',
  pending: 'Pending',
  staged: 'Staged',
  done: 'Done',
  open: 'Open',
  runnable: 'Runnable',
  pendingApproval: 'Pending approval',
  pass: 'Pass',
  fail: 'Fail',
  deferred: 'Deferred',
  discarded: 'Discarded',
};

/** Task types that map to a phase once a task has cleared grooming (Ready or beyond). */
const TYPE_TO_PHASE: Record<string, PhaseKey> = {
  '📐 Design': 'design',
  '📋 Planning': 'design',
  '💻 Code': 'code',
  '🧪 Testing': 'code',
  '🔧 Operational': 'ops',
  '🔎 Investigation': 'ops',
};

export type OpsKind = 'investigation' | 'operational';

export const OPS_KINDS: readonly OpsKind[] = ['investigation', 'operational'];

export const OPS_KIND_LABELS: Record<OpsKind, string> = {
  investigation: 'Investigation',
  operational: 'Ops',
};

const TYPE_TO_OPS_KIND: Record<string, OpsKind> = {
  '🔎 Investigation': 'investigation',
  '🔧 Operational': 'operational',
};

/** Statuses excluded entirely — closed out, not blocking the milestone. */
const CLOSED_STATUSES = new Set(['deferred']);

export interface PhaseSegmentData {
  phase: PhaseKey;
  counts: Partial<Record<SegmentState, number>>;
  /** Per-type status breakdown; set only for 'ops'. */
  byKind?: Partial<Record<OpsKind, Partial<Record<BurndownState, number>>>>;
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
  return TYPE_TO_PHASE[task.taskType] ?? null;
}

function stateForTask(task: TaskView): BurndownState {
  if (task.displayStatus === 'backlog') return 'grooming';
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
    const counts = result[phase].counts;
    counts[state] = (counts[state] ?? 0) + 1;
    const kind = TYPE_TO_OPS_KIND[task.taskType];
    if (phase === 'ops' && kind) {
      const byKind = (result.ops.byKind ??= {});
      const kindCounts = (byKind[kind] ??= {});
      kindCounts[state] = (kindCounts[state] ?? 0) + 1;
    }
    if (task.blocked) {
      result[phase].blockerCount += 1;
    }
  }

  const gate = convergence?.axes.gate;
  if (gate) {
    const gateCounts = result.gate.counts;
    for (const [rawState, count] of Object.entries(gate.counts)) {
      const key = GATE_STATE_KEY[rawState] ?? 'open';
      gateCounts[key] = (gateCounts[key] ?? 0) + count;
    }
    result.gate.blockerCount = gate.bespokeCount;
  }

  return result;
}

export function phaseTotal(
  counts: Partial<Record<SegmentState, number>>,
): number {
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
