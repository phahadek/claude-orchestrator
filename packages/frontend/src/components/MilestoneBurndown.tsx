import { useMemo } from 'react';
import type { TaskView } from '../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';
import {
  PHASE_ORDER,
  PHASE_LABELS,
  computePhaseBurndown,
  phaseTotal,
} from '../utils/phaseBurndown';
import styles from './MilestoneBurndown.module.css';

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
                      style={{
                        width: `${(segment.counts.pending / total) * 100}%`,
                      }}
                    />
                  )}
                  {segment.counts.staged > 0 && (
                    <div
                      className={`${styles.fill} ${styles.fillStaged}`}
                      style={{
                        width: `${(segment.counts.staged / total) * 100}%`,
                      }}
                    />
                  )}
                  {segment.counts.done > 0 && (
                    <div
                      className={`${styles.fill} ${styles.fillDone}`}
                      style={{
                        width: `${(segment.counts.done / total) * 100}%`,
                      }}
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
