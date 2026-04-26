import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { formatTokenCount, formatCost } from '@claude-orchestrator/backend/src/utils/usage';
import type { TaskView } from '../types/taskView';
import { ProjectSwitcher } from './ProjectSwitcher';
import { MilestoneProgress } from './MilestoneProgress';
import styles from './Header.module.css';

export type TopView = 'tasks' | 'sessions' | 'prs' | 'analytics' | 'settings';

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
  tasks?: TaskView[];
  incompleteReviewCount?: number;
}

export function Header({ projects, activeProjectId, onProjectChange, activeBoardId, onBoardChange, activeView, onViewChange, totalTokens, totalCost, tasks, incompleteReviewCount }: Props) {
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const boards = activeProject?.boards ?? [];

  return (
    <header className={styles.header}>
      <span className={styles.appName}>Claude Code Orchestrator</span>
      <nav className={styles.nav}>
        <button
          type="button"
          className={`${styles.navLink}${activeView === 'tasks' ? ` ${styles.navLinkActive}` : ''}`}
          onClick={() => onViewChange('tasks')}
        >
          Tasks
        </button>
        <button
          type="button"
          className={`${styles.navLink}${activeView === 'sessions' ? ` ${styles.navLinkActive}` : ''}`}
          onClick={() => onViewChange('sessions')}
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
            <span className={styles.incompleteBadge} title="Incomplete review — needs attention">{incompleteReviewCount}</span>
          )}
        </button>
        <button
          type="button"
          className={`${styles.navLink}${activeView === 'analytics' ? ` ${styles.navLinkActive}` : ''}`}
          onClick={() => onViewChange('analytics')}
        >
          Analytics
        </button>
        <button
          type="button"
          className={`${styles.navLink}${activeView === 'settings' ? ` ${styles.navLinkActive}` : ''}`}
          onClick={() => onViewChange('settings')}
        >
          Settings
        </button>
      </nav>
      <div className={styles.divider} />
      <ProjectSwitcher
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectChange={onProjectChange}
      />
      {boards.length > 1 && (
        <>
          <div className={styles.divider} />
          <select
            className={styles.milestoneSelect}
            value={activeBoardId ?? ''}
            onChange={(e) => onBoardChange(e.target.value)}
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </>
      )}
      {tasks && tasks.length > 0 && (
        <>
          <div className={styles.divider} />
          <MilestoneProgress tasks={tasks} />
        </>
      )}
      {totalTokens != null && totalTokens > 0 && (
        <>
          <div className={styles.divider} />
          <button
            type="button"
            className={styles.tokenSummary}
            onClick={() => onViewChange('analytics')}
            title="View token analytics"
          >
            {formatTokenCount(totalTokens)} tokens
            {totalCost != null && totalCost > 0 ? ` (~${formatCost(totalCost)})` : ''}
          </button>
        </>
      )}
    </header>
  );
}
