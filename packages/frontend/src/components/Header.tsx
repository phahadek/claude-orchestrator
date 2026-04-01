import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { ProjectSwitcher } from './ProjectSwitcher';
import styles from './Header.module.css';

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  onProjectChange: (projectId: string) => void;
  prPanelVisible: boolean;
  onTogglePrPanel: () => void;
}

export function Header({ projects, activeProjectId, onProjectChange, prPanelVisible, onTogglePrPanel }: Props) {
  return (
    <header className={styles.header}>
      <span className={styles.appName}>Claude Code Dashboard</span>
      <nav className={styles.nav}>
        <button
          type="button"
          className={`${styles.navLink}${prPanelVisible ? ` ${styles.navLinkActive}` : ''}`}
          onClick={onTogglePrPanel}
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
