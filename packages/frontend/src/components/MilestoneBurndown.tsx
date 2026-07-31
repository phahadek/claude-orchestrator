import { useMemo } from 'react';
import type { TaskView } from '../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';
import {
  PHASE_ORDER,
  PHASE_LABELS,
  PHASE_SEGMENT_ORDER,
  SEGMENT_STATE_LABELS,
  computePhaseBurndown,
  phaseTotal,
  type SegmentState,
} from '../utils/phaseBurndown';
import styles from './MilestoneBurndown.module.css';

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
}

export function MilestoneBurndown({
  tasks,
  convergence,
  activePhase,
  onPhaseSelect,
  onWarningSelect,
  activeWarningPhase = null,
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
