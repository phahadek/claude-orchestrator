import { useState, useEffect } from 'react';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import {
  formatTokenCount,
  formatCost,
} from '@claude-orchestrator/backend/src/utils/usage';
import type { TaskView } from '../types/taskView';
import { ProjectSwitcher } from './ProjectSwitcher';
import { MilestoneProgress } from './MilestoneProgress';
import { PlanUsageBars } from './PlanUsageBars';
import { ReconciliationPill } from './header/ReconciliationPill';
import type { BootReconciliationState } from '../hooks/useBootReconciliation';
import type { PlanUsage } from '@claude-orchestrator/backend/src/ws/types';
import styles from './Header.module.css';

export type TopView =
  | 'tasks'
  | 'sessions'
  | 'prs'
  | 'analytics'
  | 'gate'
  | 'settings';

interface AutoLaunchTogglePatch {
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId?: string | null;
}

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  activeBoardId: string | null;
  onBoardChange: (boardId: string) => void;
  activeView: TopView;
  onViewChange: (view: TopView) => void;
  totalTokens?: number;
  totalCost?: number;
  planUsage?: PlanUsage | null;
  tasks?: TaskView[];
  incompleteReviewCount?: number;
  onAutoLaunchToggle?: (patch: AutoLaunchTogglePatch) => void;
  autoLaunchRunningCount?: number;
  autoLaunchCap?: number;
  autoLaunchQueuedCount?: number;
  autoLaunchPollIntervalMs?: number;
  bootReconciliation?: BootReconciliationState;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(max-width: 768px)').matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

export function Header({
  projects,
  activeProjectId,
  onProjectChange,
  activeBoardId,
  onBoardChange,
  activeView,
  onViewChange,
  totalTokens,
  totalCost,
  planUsage,
  tasks,
  incompleteReviewCount,
  onAutoLaunchToggle,
  autoLaunchRunningCount,
  autoLaunchCap,
  autoLaunchQueuedCount,
  autoLaunchPollIntervalMs,
  bootReconciliation,
}: Props) {
  const isMobile = useIsMobile();

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const boards = activeProject?.boards ?? [];
  const showAutoLaunchToggle =
    activeProject !== null &&
    activeProject.taskSource !== 'yaml' &&
    boards.length > 0;
  const autoLaunchEnabled = activeProject?.autoLaunchEnabled ?? false;
  const autoLaunchMilestoneId = activeProject?.autoLaunchMilestoneId ?? null;
  const isOnThisMilestone =
    autoLaunchEnabled && autoLaunchMilestoneId === activeBoardId;
  const otherMilestoneName =
    autoLaunchEnabled &&
    autoLaunchMilestoneId &&
    autoLaunchMilestoneId !== activeBoardId
      ? (boards.find((b) => b.id === autoLaunchMilestoneId)?.name ?? null)
      : null;
  const autoLaunchTooltip = (() => {
    if (isOnThisMilestone) return 'Auto-launch ON for this milestone';
    if (otherMilestoneName)
      return `Auto-launch active on ${otherMilestoneName} — click to reassign to current milestone`;
    return 'Auto-launch OFF — click to enable for this milestone';
  })();

  function handleAutoLaunchClick() {
    if (!onAutoLaunchToggle || !activeBoardId) return;
    if (isOnThisMilestone) {
      onAutoLaunchToggle({ autoLaunchEnabled: false });
    } else {
      onAutoLaunchToggle({
        autoLaunchEnabled: true,
        autoLaunchMilestoneId: activeBoardId,
      });
    }
  }

  const navContent = (
    <nav className={styles.nav}>
      <button
        type="button"
        className={`${styles.navLink}${activeView === 'tasks' ? ` ${styles.navLinkActive}` : ''}`}
        onClick={() => onViewChange('tasks')}
        title="Tasks"
      >
        Tasks
      </button>
      <button
        type="button"
        className={`${styles.navLink}${activeView === 'sessions' ? ` ${styles.navLinkActive}` : ''}`}
        onClick={() => onViewChange('sessions')}
        title="Sessions"
      >
        Sessions
      </button>
      <button
        type="button"
        className={`${styles.navLink}${activeView === 'prs' ? ` ${styles.navLinkActive}` : ''}`}
        onClick={() => onViewChange('prs')}
      >
        PRs
        {incompleteReviewCount != null && incompleteReviewCount > 0 && (
          <span
            className={styles.incompleteBadge}
            title="Incomplete review — needs attention"
          >
            {incompleteReviewCount}
          </span>
        )}
      </button>
      <button
        type="button"
        className={`${styles.navLink} ${styles.navLinkIcon}${activeView === 'analytics' ? ` ${styles.navLinkActive}` : ''}`}
        onClick={() => onViewChange('analytics')}
        title="Analytics"
        aria-label="Analytics"
      >
        📊
      </button>
      <button
        type="button"
        className={`${styles.navLink} ${styles.navLinkIcon}${activeView === 'gate' ? ` ${styles.navLinkActive}` : ''}`}
        onClick={() => onViewChange('gate')}
        title="Gate Readiness"
        aria-label="Gate Readiness"
      >
        🚦
      </button>
      <button
        type="button"
        className={`${styles.navLink} ${styles.navLinkIcon}${activeView === 'settings' ? ` ${styles.navLinkActive}` : ''}`}
        onClick={() => onViewChange('settings')}
        title="Settings"
        aria-label="Settings"
      >
        ⚙️
      </button>
    </nav>
  );

  const autoLaunchContent = showAutoLaunchToggle ? (
    <button
      type="button"
      className={`${styles.autoLaunchPill}${isOnThisMilestone ? ` ${styles.autoLaunchPillOn}` : ''}`}
      onClick={handleAutoLaunchClick}
      disabled={!activeBoardId || !onAutoLaunchToggle}
      title={`${autoLaunchTooltip}${
        autoLaunchCap != null && autoLaunchRunningCount != null
          ? ` — ${autoLaunchRunningCount} running, ${autoLaunchQueuedCount ?? 0} queued, cap ${autoLaunchCap}. Auto-launch checks every ${Math.round((autoLaunchPollIntervalMs ?? 60000) / 1000)}s.`
          : ''
      }`}
      aria-pressed={isOnThisMilestone}
      aria-label={
        isOnThisMilestone
          ? 'Auto-launch ON for this milestone'
          : otherMilestoneName
            ? `Auto-launch active on ${otherMilestoneName}`
            : 'Auto-launch OFF'
      }
      data-testid="auto-launch-counter"
    >
      <span aria-hidden="true">🤖</span>
      {autoLaunchCap != null && autoLaunchRunningCount != null && (
        <span className={styles.autoLaunchCounterText}>
          {autoLaunchRunningCount}/{autoLaunchCap}
        </span>
      )}
      {(autoLaunchQueuedCount ?? 0) > 0 && (
        <span className={styles.autoLaunchQueued}>
          {autoLaunchQueuedCount}⏳
        </span>
      )}
    </button>
  ) : null;

  const tokenContent =
    totalTokens != null && totalTokens > 0 ? (
      <button
        type="button"
        className={styles.tokenSummary}
        onClick={() => onViewChange('analytics')}
        title="View token analytics"
      >
        {formatTokenCount(totalTokens)} tokens
        {totalCost != null && totalCost > 0
          ? ` (~${formatCost(totalCost)})`
          : ''}
      </button>
    ) : null;

  /** Synthetic sentinel value used as boardId when "Non-milestone" is selected. */
  const NON_MILESTONE_BOARD_ID = '__non_milestone__';

  const milestoneSelectContent =
    boards.length > 0 ? (
      <select
        className={styles.milestoneSelect}
        value={activeBoardId ?? ''}
        onChange={(e) => onBoardChange(e.target.value)}
      >
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
        <option key={NON_MILESTONE_BOARD_ID} value={NON_MILESTONE_BOARD_ID}>
          Non-milestone
        </option>
      </select>
    ) : null;

  if (isMobile) {
    return (
      <header className={`${styles.header} ${styles.headerMobile}`}>
        <div className={styles.mobileRow1} data-testid="mobile-row1">
          {navContent}
        </div>
        <div className={styles.mobileRow2} data-testid="mobile-row2">
          <ProjectSwitcher
            projects={projects}
            activeProjectId={activeProjectId}
            onProjectChange={onProjectChange}
          />
          {milestoneSelectContent}
          {autoLaunchContent}
          {tasks && tasks.length > 0 && (
            <MilestoneProgress tasks={tasks} compact />
          )}
          {tokenContent}
          <PlanUsageBars usage={planUsage} />
          {bootReconciliation && bootReconciliation.phase !== 'idle' && (
            <ReconciliationPill state={bootReconciliation} />
          )}
        </div>
      </header>
    );
  }

  return (
    <header className={styles.header}>
      <span className={styles.appName}>Claude Code Orchestrator</span>
      {navContent}
      <div className={styles.divider} />
      <ProjectSwitcher
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectChange={onProjectChange}
      />
      {milestoneSelectContent && (
        <>
          <div className={styles.divider} />
          {milestoneSelectContent}
        </>
      )}
      {showAutoLaunchToggle && (
        <>
          <div className={styles.divider} />
          {autoLaunchContent}
        </>
      )}
      {tasks && tasks.length > 0 && (
        <>
          <div className={styles.divider} />
          <MilestoneProgress tasks={tasks} />
        </>
      )}
      {tokenContent && <div className={styles.divider} />}
      <div className={styles.tokenStack}>
        {tokenContent}
        <PlanUsageBars usage={planUsage} />
      </div>
      {bootReconciliation && bootReconciliation.phase !== 'idle' && (
        <>
          <div className={styles.divider} />
          <ReconciliationPill state={bootReconciliation} />
        </>
      )}
    </header>
  );
}
