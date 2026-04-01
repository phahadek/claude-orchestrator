import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { ProjectSwitcher } from './ProjectSwitcher';
import styles from './Header.module.css';

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  onProjectChange: (projectId: string) => void;
}

export function Header({ projects, activeProjectId, onProjectChange }: Props) {
  return (
    <header className={styles.header}>
      <span className={styles.appName}>Claude Code Dashboard</span>
      <ProjectSwitcher
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectChange={onProjectChange}
      />
    </header>
  );
}
