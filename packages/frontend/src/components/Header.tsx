import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { ProjectSwitcher } from './ProjectSwitcher';
import styles from './Header.module.css';

export type TopView = 'sessions' | 'prs' | 'settings';

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  activeBoardId: string | null;
  onBoardChange: (boardId: string) => void;
  activeView: TopView;
  onViewChange: (view: TopView) => void;
}

export function Header({ projects, activeProjectId, onProjectChange, activeBoardId, onBoardChange, activeView, onViewChange }: Props) {
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const boards = activeProject?.boards ?? [];

  return (
    <header className={styles.header}>
      <span className={styles.appName}>Claude Code Dashboard</span>
      <nav className={styles.nav}>
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
    </header>
  );
}
