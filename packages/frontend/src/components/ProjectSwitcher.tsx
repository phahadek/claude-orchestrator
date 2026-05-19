import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import styles from './ProjectSwitcher.module.css';

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  onProjectChange: (projectId: string) => void;
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  onProjectChange,
}: Props) {
  if (projects.length <= 1) {
    return (
      <span className={styles.label}>{projects[0]?.name ?? 'No project'}</span>
    );
  }

  return (
    <select
      className={styles.select}
      value={activeProjectId ?? ''}
      onChange={(e) => onProjectChange(e.target.value)}
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
