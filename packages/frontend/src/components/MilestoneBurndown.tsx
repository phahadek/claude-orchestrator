import { useMemo } from 'react';
import type { TaskView } from '../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';
import {
  PHASE_ORDER,
  PHASE_LABELS,
  PHASE_SEGMENT_ORDER,
  SEGMENT_STATE_LABELS,
  GATE_PHASE,
  computePhaseBurndown,
  phaseTotal,
  type SegmentState,
} from '../utils/phaseBurndown';
import { useConvergenceHistory } from '../hooks/useConvergenceHistory';
import { ConvergenceSparkline } from './ConvergenceSparkline';
import styles from './MilestoneBurndown.module.css';

const TASK_AXIS_LABELS: Record<'green' | 'blocked' | 'unavailable', string> = {
  green: 'Green',
  blocked: 'Blocked',
  unavailable: 'Unavailable',
};

const SEGMENT_FILL_CLASS: Record<SegmentState, string> = {
  pending: styles.fillPending,
  staged: styles.fillStaged,
  done: styles.fillDone,
  blocked: styles.fillPending,
  inGrooming: styles.fillStaged,
  untouched: styles.fillUntouched,
};

interface Props {
  tasks: TaskView[];
  convergence: MilestoneConvergence | null;
  activePhase: string | null;
  onPhaseSelect: (phase: string | null) => void;
  /** Invoked when a phase's ⚠ warning badge is activated — distinct from selecting the phase via its label. */
  onWarningSelect?: (phase: string) => void;
  /** The phase whose warning is currently the active selection, if any. */
  activeWarningPhase?: string | null;
  /** Scopes the convergence-history fetch for the sparkline; null suppresses it. */
  projectId?: string | null;
  milestoneId?: string | null;
}

export function MilestoneBurndown({
  tasks,
  convergence,
  activePhase,
  onPhaseSelect,
  onWarningSelect,
  activeWarningPhase = null,
  projectId = null,
  milestoneId = null,
}: Props) {
  const phases = useMemo(
    () => computePhaseBurndown(tasks, convergence),
    [tasks, convergence],
  );
  const { history } = useConvergenceHistory(projectId, milestoneId);

  return (
    <div className={styles.container} data-testid="milestone-burndown">
      {convergence && (
        <div
          className={styles.convergenceHeader}
          data-testid="convergence-header"
        >
          <div className={styles.convergenceTop}>
            <span
              className={`${styles.statusDot} ${convergence.status === 'green' ? styles.statusGreen : styles.statusBlocked}`}
              data-testid="convergence-status"
              title={`Convergence: ${convergence.status}`}
            />
            <span
              className={styles.distanceFigure}
              data-testid="convergence-distance"
            >
              {convergence.distanceToGreen}
            </span>
            <span className={styles.distanceLabel}>
              to green (tasks + gate + seed — ops tracked separately)
            </span>
          </div>

          <div
            className={styles.axisChips}
            data-testid="convergence-axis-chips"
          >
            <span
              className={`${styles.axisChip} ${styles[`axisChip_${convergence.axes.tasks.status}`]}`}
              data-testid="convergence-chip-tasks"
              title={`Tasks: ${TASK_AXIS_LABELS[convergence.axes.tasks.status]}`}
            >
              Tasks: {TASK_AXIS_LABELS[convergence.axes.tasks.status]} (
              {convergence.axes.tasks.open})
            </span>

            <button
              type="button"
              className={`${styles.axisChip} ${styles.axisChipClickable} ${convergence.axes.gate.status === 'green' ? styles.axisChip_green : styles.axisChip_blocked}`}
              data-testid="convergence-chip-gate"
              onClick={() => onPhaseSelect(GATE_PHASE)}
            >
              Gate ({convergence.axes.gate.blockingCount})
            </button>

            <span
              className={`${styles.axisChip} ${convergence.axes.seed.status === 'green' ? styles.axisChip_green : styles.axisChip_blocked}`}
              data-testid="convergence-chip-seed"
            >
              Seed ({convergence.axes.seed.blockingCount})
            </span>

            <span
              className={`${styles.axisChip} ${convergence.axes.ops.status === 'green' ? styles.axisChip_green : styles.axisChip_blocked}`}
              data-testid="convergence-chip-ops"
              title={
                convergence.axes.ops.status === 'green'
                  ? 'No unresolved touched ops work'
                  : 'Ops work needs resolution'
              }
            >
              Ops ({convergence.axes.ops.blockingCount})
            </span>
          </div>

          {history.length > 0 && (
            <div className={styles.sparklineWrap}>
              <ConvergenceSparkline points={history} />
            </div>
          )}
        </div>
      )}
      {PHASE_ORDER.map((phase) => {
        const segment = phases[phase];
        const total = phaseTotal(segment.counts);
        const isActive = activePhase === phase || activeWarningPhase === phase;
        const isWarningActive = activeWarningPhase === phase;

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
                  role="button"
                  tabIndex={0}
                  className={`${styles.blockerBadge} ${isWarningActive ? styles.blockerBadgeActive : ''}`}
                  data-testid={`phase-blockers-${phase}`}
                  aria-pressed={isWarningActive}
                  title={`${segment.blockerCount} blocker${segment.blockerCount === 1 ? '' : 's'} — click to view`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onWarningSelect?.(phase);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      onWarningSelect?.(phase);
                    }
                  }}
                >
                  ⚠ {segment.blockerCount}
                </span>
              )}
            </div>
            <div className={styles.track}>
              {total === 0 ? (
                <div className={styles.emptySegment} />
              ) : (
                PHASE_SEGMENT_ORDER[phase].map((state) => {
                  const count = segment.counts[state] ?? 0;
                  if (count === 0) return null;
                  return (
                    <div
                      key={state}
                      className={`${styles.fill} ${SEGMENT_FILL_CLASS[state]}`}
                      style={{ width: `${(count / total) * 100}%` }}
                      title={`${SEGMENT_STATE_LABELS[state]}: ${count}`}
                    />
                  );
                })
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
