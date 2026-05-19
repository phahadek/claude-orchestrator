import { useState, useEffect, useCallback } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { projectsApi, type Project } from '../../api/projects';
import { ProjectFormModal, type ProjectFormValues } from './ProjectFormModal';
import { MilestonesSubPanel } from './MilestonesSubPanel';
import styles from './ProjectsSettingsPanel.module.css';

function toCreatePayload(values: ProjectFormValues) {
  return {
    name: values.name.trim(),
    projectDir: values.projectDir.trim(),
    contextUrl: values.contextUrl.trim() || null,
    githubRepo: values.githubRepo.trim() || null,
    taskSource: values.taskSource,
    autoLaunchEnabled: values.autoLaunchEnabled,
    autoLaunchMilestoneId: values.autoLaunchMilestoneId.trim() || null,
  };
}

function ProjectsSettingsPanelInner() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [drillIn, setDrillIn] = useState<Project | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [stubBusy, setStubBusy] = useState<string | null>(null);
  const [stubMessage, setStubMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await projectsApi.list();
      setProjects(data);
      // Refresh the drilled-in project view if its data changed.
      setDrillIn((current) => {
        if (!current) return current;
        return data.find((p) => p.id === current.id) ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleCreate(values: ProjectFormValues) {
    await projectsApi.create(toCreatePayload(values));
    setShowAdd(false);
    await reload();
  }

  async function handleUpdate(values: ProjectFormValues) {
    if (!editing) return;
    await projectsApi.update(editing.id, toCreatePayload(values));
    setEditing(null);
    await reload();
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    try {
      await projectsApi.delete(target.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project');
    }
  }

  async function handleCreateStub(p: Project) {
    setStubBusy(p.id);
    setStubMessage(null);
    try {
      const result = await projectsApi.createTasksYamlStub(p.id);
      setStubMessage(`Created ${result.path}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create tasks.yaml',
      );
    } finally {
      setStubBusy(null);
    }
  }

  if (drillIn) {
    return (
      <MilestonesSubPanel
        project={drillIn}
        onBack={() => setDrillIn(null)}
        onMilestonesChanged={() => void reload()}
      />
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h3 className={styles.sectionTitle}>Configured Projects</h3>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => setShowAdd(true)}
        >
          + Add project
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {stubMessage && <p className={styles.success}>{stubMessage}</p>}

      {loading ? (
        <p className={styles.muted}>Loading…</p>
      ) : projects.length === 0 ? (
        <p className={styles.muted}>
          No projects configured yet. Click <strong>+ Add project</strong> to
          create one.
        </p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Project Dir</th>
              <th>Task Source</th>
              <th># Milestones</th>
              <th>GitHub Repo</th>
              <th className={styles.actionsCol}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => setDrillIn(p)}
                    aria-label={`Open milestones for ${p.name}`}
                  >
                    {p.name}
                  </button>
                </td>
                <td className={styles.mono}>{p.projectDir}</td>
                <td>
                  <span className={styles.badge}>{p.taskSource}</span>
                  {p.taskSource === 'yaml' && (
                    <button
                      type="button"
                      className={styles.linkBtn}
                      disabled={stubBusy === p.id}
                      onClick={() => void handleCreateStub(p)}
                    >
                      {stubBusy === p.id
                        ? 'Creating…'
                        : 'Create empty tasks.yaml'}
                    </button>
                  )}
                </td>
                <td>{p.milestones.length}</td>
                <td className={styles.mono}>{p.githubRepo ?? '—'}</td>
                <td className={styles.actionsCol}>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => setEditing(p)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${styles.linkBtn} ${styles.danger}`}
                    onClick={() => setConfirmDelete(p)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showAdd && (
        <ProjectFormModal
          onCancel={() => setShowAdd(false)}
          onSubmit={handleCreate}
        />
      )}

      {editing && (
        <ProjectFormModal
          initialProject={editing}
          onCancel={() => setEditing(null)}
          onSubmit={handleUpdate}
        />
      )}

      {confirmDelete && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm delete project"
          onClick={() => setConfirmDelete(null)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete project?</h3>
            <p className={styles.muted}>
              This will remove the project <strong>{confirmDelete.name}</strong>{' '}
              and all of its milestones from the dashboard. The project files on
              disk are not touched.
            </p>
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btnPrimary} ${styles.danger}`}
                onClick={() => void handleConfirmDelete()}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProjectsSettingsPanel() {
  return (
    <ErrorBoundary name="ProjectsSettingsPanel">
      <ProjectsSettingsPanelInner />
    </ErrorBoundary>
  );
}
