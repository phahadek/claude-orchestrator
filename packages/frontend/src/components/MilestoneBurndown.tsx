import { useMemo } from 'react';
import type { TaskView } from '../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';
import styles from './MilestoneBurndown.module.css';

export type BurndownState = 'pending' | 'staged' | 'done';

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
    if (CLOSED_STATUSES.has(task.displayStatus)) continue;

    const phase: PhaseKey | undefined = PRE_READY_STATUSES.has(
      task.displayStatus,
    )
      ? 'grooming'
      : TYPE_TO_PHASE[task.taskType];
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

function phaseTotal(counts: PhaseStateCounts): number {
  return counts.pending + counts.staged + counts.done;
}

interface Props {
  tasks: TaskView[];
  convergence: MilestoneConvergence | null;
  activePhase: string | null;
  onPhaseSelect: (phase: string | null) => void;
}

export function MilestoneBurndown({
  tasks,
  convergence,
  activePhase,
  onPhaseSelect,
}: Props) {
  const phases = useMemo(
    () => computePhaseBurndown(tasks, convergence),
    [tasks, convergence],
  );

  return (
    <div className={styles.container} data-testid="milestone-burndown">
      {PHASE_ORDER.map((phase) => {
        const segment = phases[phase];
        const total = phaseTotal(segment.counts);
        const isActive = activePhase === phase;

        return (
          <button
            key={phase}
            type="button"
            className={`${styles.phaseRow} ${isActive ? styles.phaseRowActive : ''}`}
            data-testid={`phase-segment-${phase}`}
            aria-pressed={isActive}
            onClick={() => onPhaseSelect(phase)}
          >
            <div className={styles.phaseHeader}>
              <span className={styles.phaseLabel}>{PHASE_LABELS[phase]}</span>
              <span className={styles.phaseCount}>{total}</span>
              {segment.blockerCount > 0 && (
                <span
                  className={styles.blockerBadge}
                  data-testid={`phase-blockers-${phase}`}
                  title={`${segment.blockerCount} blocker${segment.blockerCount === 1 ? '' : 's'}`}
                >
                  ⚠ {segment.blockerCount}
                </span>
              )}
            </div>
            <div className={styles.track}>
              {total === 0 ? (
                <div className={styles.emptySegment} />
              ) : (
                <>
                  {segment.counts.pending > 0 && (
                    <div
                      className={`${styles.fill} ${styles.fillPending}`}
                      style={{ width: `${(segment.counts.pending / total) * 100}%` }}
                    />
                  )}
                  {segment.counts.staged > 0 && (
                    <div
                      className={`${styles.fill} ${styles.fillStaged}`}
                      style={{ width: `${(segment.counts.staged / total) * 100}%` }}
                    />
                  )}
                  {segment.counts.done > 0 && (
                    <div
                      className={`${styles.fill} ${styles.fillDone}`}
                      style={{ width: `${(segment.counts.done / total) * 100}%` }}
                    />
                  )}
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
