import { useCallback, useMemo, useRef, useState } from 'react';
import type { TaskView as BackendTaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { TaskView } from '../types/taskView';
import type { StagedIntent } from '../api/stagedIntents';
import { useMilestoneConvergence } from '../hooks/useMilestoneConvergence';
import { MilestoneBurndown } from './MilestoneBurndown';
import styles from './MilestoneView.module.css';

const MIN_MIDDLE_WIDTH_PCT = 30;
const MAX_MIDDLE_WIDTH_PCT = 80;
const DEFAULT_MIDDLE_WIDTH_PCT = 55;

interface Props {
  activeProjectId: string | null;
  /** The milestone scope this view follows — resolved from the overall panel's board selection. */
  activeBoardId: string | null;
  /** Display name of the active milestone, or null when no real milestone is selected. */
  activeBoardMilestone: string | null;
  lastTaskUpdate: BackendTaskView | null;
  lastStagedIntentChange: StagedIntent | null;
  /** Tasks for the active project + board — already scoped upstream. */
  tasks: TaskView[];
}

export function MilestoneView({
  activeProjectId,
  activeBoardId,
  activeBoardMilestone,
  lastTaskUpdate,
  lastStagedIntentChange,
  tasks,
}: Props) {
  // Shared filter state: the burndown (left) emits a phase, the decision
  // stack (middle) consumes it.
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);

  const invalidationKey = useMemo(
    () => `${lastTaskUpdate?.taskId ?? ''}:${lastStagedIntentChange?.id ?? ''}`,
    [lastTaskUpdate, lastStagedIntentChange],
  );

  const { convergence } = useMilestoneConvergence({
    projectId: activeProjectId,
    milestoneId: activeBoardMilestone ? activeBoardId : null,
    invalidationKey,
  });

  const [middleWidthPct, setMiddleWidthPct] = useState(
    DEFAULT_MIDDLE_WIDTH_PCT,
  );
  const middleWidthRef = useRef(middleWidthPct);
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePhaseFilterChange = useCallback((phase: string | null) => {
    setPhaseFilter((prev) => (prev === phase ? null : phase));
  }, []);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const onMove = (ev: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(
        MAX_MIDDLE_WIDTH_PCT,
        Math.max(MIN_MIDDLE_WIDTH_PCT, pct),
      );
      middleWidthRef.current = clamped;
      setMiddleWidthPct(clamped);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  if (!activeBoardMilestone) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState} data-testid="milestone-empty-state">
          <p>Select a milestone from the board switcher to see its progress.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.container}
      ref={containerRef}
      data-testid="milestone-view-shell"
    >
      <div className={styles.leftColumn} data-testid="milestone-burndown-mount">
        <MilestoneBurndown
          tasks={tasks}
          convergence={convergence}
          activePhase={phaseFilter}
          onPhaseSelect={handlePhaseFilterChange}
        />
      </div>

      <div
        className={styles.middlePanel}
        style={{ width: `${middleWidthPct}%` }}
        data-testid="milestone-decision-stack-mount"
      >
        <div className={styles.mountPlaceholder}>
          Decision stack{phaseFilter ? ` (filtered: ${phaseFilter})` : ''}
        </div>
      </div>

      <div
        className={styles.resizeHandle}
        onMouseDown={handleResizeMouseDown}
      />

      <div
        className={styles.rightPanel}
        data-testid="milestone-drilldown-mount"
      >
        <div className={styles.mountPlaceholder}>
          {convergence
            ? `Drill-down — status: ${convergence.status}`
            : 'Drill-down'}
        </div>
      </div>
    </div>
  );
}
