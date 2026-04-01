import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { ProjectSwitcher } from './ProjectSwitcher';
import styles from './Header.module.css';

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  activeView: 'sessions' | 'prs';
  onViewChange: (view: 'sessions' | 'prs') => void;
}

export function Header({ projects, activeProjectId, onProjectChange, activeView, onViewChange }: Props) {
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
      </nav>
      <div className={styles.divider} />
      <ProjectSwitcher
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectChange={onProjectChange}
      />
    </header>
  );
}
