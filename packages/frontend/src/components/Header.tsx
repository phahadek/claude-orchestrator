import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { formatTokenCount, formatUtilization } from '@claude-dashboard/backend/src/utils/usage';
import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';
import { ProjectSwitcher } from './ProjectSwitcher';
import { MilestoneProgress } from './MilestoneProgress';
import styles from './Header.module.css';

export type TopView = 'tasks' | 'sessions' | 'prs' | 'settings';

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  activeBoardId: string | null;
  onBoardChange: (boardId: string) => void;
  activeView: TopView;
  onViewChange: (view: TopView) => void;
  totalTokens?: number;
  planTokenCap?: number;
  tasks?: ResolvedTask[];
  incompleteReviewCount?: number;
}

export function Header({ projects, activeProjectId, onProjectChange, activeBoardId, onBoardChange, activeView, onViewChange, totalTokens, planTokenCap, tasks, incompleteReviewCount }: Props) {
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const boards = activeProject?.boards ?? [];

  return (
    <header className={styles.header}>
      <span className={styles.appName}>Claude Code Dashboard</span>
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
          <span className={styles.tokenSummary}>
            {formatTokenCount(totalTokens)} tokens
            {planTokenCap != null && planTokenCap > 0
              ? ` (${formatUtilization((totalTokens / planTokenCap) * 100)})`
              : ''}
          </span>
        </>
      )}
    </header>
  );
}
