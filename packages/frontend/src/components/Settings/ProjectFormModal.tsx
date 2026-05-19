import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import type { Project, TaskSource } from '../../api/projects';
import styles from './ProjectsSettingsPanel.module.css';

export interface ProjectFormValues {
  name: string;
  projectDir: string;
  contextUrl: string;
  githubRepo: string;
  taskSource: TaskSource;
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string;
}

interface Props {
  initialProject?: Project | null;
  onCancel: () => void;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
}

const EMPTY: ProjectFormValues = {
  name: '',
  projectDir: '',
  contextUrl: '',
  githubRepo: '',
  taskSource: 'notion',
  autoLaunchEnabled: false,
  autoLaunchMilestoneId: '',
};

function fromProject(p: Project): ProjectFormValues {
  return {
    name: p.name,
    projectDir: p.projectDir,
    contextUrl: p.contextUrl ?? '',
    githubRepo: p.githubRepo ?? '',
    taskSource: p.taskSource,
    autoLaunchEnabled: p.autoLaunchEnabled,
    autoLaunchMilestoneId: p.autoLaunchMilestoneId ?? '',
  };
}

export function ProjectFormModal({ initialProject, onCancel, onSubmit }: Props) {
  const [values, setValues] = useState<ProjectFormValues>(() =>
    initialProject ? fromProject(initialProject) : EMPTY,
  );
  const [errors, setErrors] = useState<{ name?: string; projectDir?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    setValues(initialProject ? fromProject(initialProject) : EMPTY);
    setErrors({});
    setServerError(null);
  }, [initialProject]);

  function update<K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const nextErrors: { name?: string; projectDir?: string } = {};
    if (!values.name.trim()) nextErrors.name = 'Name is required';
    if (!values.projectDir.trim()) nextErrors.projectDir = 'Project Dir is required';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Failed to save project');
    } finally {
      setSubmitting(false);
    }
  }

  const isEdit = Boolean(initialProject);

  return (
    <div
      className={styles.modalOverlay}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'Edit project' : 'Add project'}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>{isEdit ? 'Edit project' : 'Add project'}</h3>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className={styles.formField}>
            <label htmlFor="proj-name" className={styles.formLabel}>Name</label>
            <input
              id="proj-name"
              type="text"
              className={styles.input}
              value={values.name}
              onChange={(e) => update('name', e.target.value)}
              autoFocus
            />
            {errors.name && <p className={styles.fieldError}>{errors.name}</p>}
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-dir" className={styles.formLabel}>Project Dir</label>
            <input
              id="proj-dir"
              type="text"
              className={styles.input}
              value={values.projectDir}
              onChange={(e) => update('projectDir', e.target.value)}
              placeholder="/absolute/path/to/repo"
            />
            {errors.projectDir && <p className={styles.fieldError}>{errors.projectDir}</p>}
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-source" className={styles.formLabel}>Task Source</label>
            <select
              id="proj-source"
              className={styles.input}
              value={values.taskSource}
              onChange={(e) => update('taskSource', e.target.value === 'yaml' ? 'yaml' : 'notion')}
            >
              <option value="notion">Notion</option>
              <option value="yaml">YAML (tasks.yaml in projectDir)</option>
            </select>
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-context" className={styles.formLabel}>Context URL (optional)</label>
            <input
              id="proj-context"
              type="text"
              className={styles.input}
              value={values.contextUrl}
              onChange={(e) => update('contextUrl', e.target.value)}
              placeholder="https://www.notion.so/…"
            />
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-repo" className={styles.formLabel}>GitHub Repo (optional)</label>
            <input
              id="proj-repo"
              type="text"
              className={styles.input}
              value={values.githubRepo}
              onChange={(e) => update('githubRepo', e.target.value)}
              placeholder="owner/repo"
            />
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-auto-launch" className={styles.formLabel}>
              <input
                id="proj-auto-launch"
                type="checkbox"
                checked={values.autoLaunchEnabled}
                onChange={(e) => update('autoLaunchEnabled', e.target.checked)}
              />
              {' '}Auto-launch Ready 💻 Code tasks
            </label>
          </div>

          {values.autoLaunchEnabled && initialProject && initialProject.milestones.length > 1 && (
            <div className={styles.formField}>
              <label htmlFor="proj-auto-launch-milestone" className={styles.formLabel}>
                Auto-launch milestone
              </label>
              <select
                id="proj-auto-launch-milestone"
                className={styles.input}
                value={values.autoLaunchMilestoneId}
                onChange={(e) => update('autoLaunchMilestoneId', e.target.value)}
              >
                <option value="">First configured milestone</option>
                {initialProject.milestones.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          )}

          {serverError && <p className={styles.serverError}>{serverError}</p>}

          <div className={styles.modalActions}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
