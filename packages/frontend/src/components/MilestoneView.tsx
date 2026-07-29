import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskView as BackendTaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { TaskView } from '../types/taskView';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import type { StagedIntent } from '../api/stagedIntents';
import type { SessionState } from '../hooks/useSessionStore';
import { useMilestoneConvergence } from '../hooks/useMilestoneConvergence';
import { MilestoneBurndown } from './MilestoneBurndown';
import {
  MilestoneDecisionStack,
  type MilestoneStackSelection,
} from './MilestoneDecisionStack';
import { MilestoneDrilldown } from './MilestoneDrilldown';
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
  /** Tasks for the active project + board — already scoped upstream. */
  tasks: TaskView[];
  lastTaskUpdate: BackendTaskView | null;
  lastStagedIntentChange: StagedIntent | null;
  sessions: SessionState[];
  send: (msg: ClientMessage) => void;
  setSessionArchived: (sessionId: string, archived: boolean) => void;
  setSessionFavorited: (sessionId: string, favorited: boolean) => void;
  project?: ProjectConfig | null;
}

export function MilestoneView({
  activeProjectId,
  activeBoardId,
  activeBoardMilestone,
  tasks,
  lastTaskUpdate,
  lastStagedIntentChange,
  sessions,
  send,
  setSessionArchived,
  setSessionFavorited,
  project = null,
}: Props) {
  // Shared filter state: the burndown (left) emits a phase, the decision
  // stack (middle) consumes it.
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);
  const [selection, setSelection] = useState<MilestoneStackSelection | null>(
    null,
  );

  const invalidationKey = useMemo(
    () => `${lastTaskUpdate?.taskId ?? ''}:${lastStagedIntentChange?.id ?? ''}`,
    [lastTaskUpdate, lastStagedIntentChange],
  );

  const { convergence } = useMilestoneConvergence({
    projectId: activeProjectId,
    milestoneId: activeBoardMilestone ? activeBoardId : null,
    invalidationKey,
  });

  // The decision-inbox lens keys on the milestone's canonical short id
  // (convergence.milestone), distinct from activeBoardId (the DB board id
  // used to scope /api/tasks/active).
  const milestoneKey = convergence?.milestone ?? null;

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

  // Selection lives against a specific milestone's stack — drop it when the
  // milestone scope changes so the drill-down never shows a stale item.
  useEffect(() => {
    setSelection(null);
  }, [activeProjectId, activeBoardId]);

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
        {activeProjectId && milestoneKey ? (
          <MilestoneDecisionStack
            projectId={activeProjectId}
            milestone={milestoneKey}
            tasks={tasks}
            phaseFilter={phaseFilter}
            selection={selection}
            onSelect={setSelection}
          />
        ) : (
          <div className={styles.mountPlaceholder}>
            Decision stack{phaseFilter ? ` (filtered: ${phaseFilter})` : ''}
          </div>
        )}
      </div>

      <div
        className={styles.resizeHandle}
        onMouseDown={handleResizeMouseDown}
      />

      <div
        className={styles.rightPanel}
        data-testid="milestone-drilldown-mount"
      >
        <MilestoneDrilldown
          selection={selection}
          tasks={tasks}
          projectId={activeProjectId}
          sessions={sessions}
          send={send}
          setSessionArchived={setSessionArchived}
          setSessionFavorited={setSessionFavorited}
          project={project}
        />
      </div>
    </div>
  );
}
