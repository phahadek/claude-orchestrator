import { useState, useEffect, useCallback } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import {
  projectsApi,
  type Project,
  type OrchestratorConfig,
  type OrchestratorConfigResponse,
} from '../../api/projects';
import { ProjectFormModal, type ProjectFormValues } from './ProjectFormModal';
import { MilestonesSubPanel } from './MilestonesSubPanel';
import styles from './ProjectsSettingsPanel.module.css';

function ConfigReadOnly({ config }: { config: OrchestratorConfig }) {
  const fields: Array<{ label: string; value: string[] | string }> = [
    { label: 'autofix', value: config.autofix },
    { label: 'verify', value: config.verify },
    { label: 'ci_check_name', value: config.ci_check_name },
    { label: 'allowed_tools', value: config.allowed_tools },
    { label: 'bash_rules', value: config.bash_rules },
    { label: 'bootstrap_script', value: config.bootstrap_script },
  ];
  return (
    <table className={styles.table}>
      <tbody>
        {fields.map(({ label, value }) => (
          <tr key={label}>
            <th style={{ width: '40%' }}>{label}</th>
            <td className={styles.mono}>
              {Array.isArray(value) ? (
                value.length === 0 ? (
                  <span className={styles.muted}>(none)</span>
                ) : (
                  value.join(', ')
                )
              ) : (
                value || <span className={styles.muted}>(none)</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function toCreatePayload(values: ProjectFormValues) {
  const rawCfg = values.nonMilestoneSourceConfigRaw.trim();
  const nonMilestoneSourceConfig = rawCfg
    ? (JSON.parse(
        rawCfg,
      ) as import('../../api/projects').NonMilestoneSourceConfig)
    : null;
  return {
    name: values.name.trim(),
    projectDir: values.projectDir.trim(),
    contextUrl: values.contextUrl.trim() || null,
    githubRepo:
      values.gitMode !== 'local-only' ? values.githubRepo.trim() || null : null,
    taskSource: values.taskSource,
    gitMode: values.gitMode,
    autoLaunchEnabled: values.autoLaunchEnabled,
    autoLaunchMilestoneId: values.autoLaunchMilestoneId.trim() || null,
    autoMergeEnabled:
      values.gitMode !== 'local-only' ? values.autoMergeEnabled : false,
    nonMilestoneSourceConfig,
    dataResidencyConfirmed: values.dataResidencyConfirmed,
  };
}

function middleEllipsis(str: string, maxLen = 40): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 1) / 2);
  return str.slice(0, half) + '…' + str.slice(str.length - half);
}

interface ProjectsSettingsPanelProps {
  onProjectsChanged?: () => void;
}

function ProjectsSettingsPanelInner({
  onProjectsChanged,
}: ProjectsSettingsPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [drillIn, setDrillIn] = useState<Project | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  const [stubBusy, setStubBusy] = useState<string | null>(null);
  const [stubMessage, setStubMessage] = useState<string | null>(null);
  const [configFor, setConfigFor] = useState<Project | null>(null);
  const [configData, setConfigData] =
    useState<OrchestratorConfigResponse | null>(null);
  const [configLoading, setConfigLoading] = useState(false);

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
      onProjectsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [onProjectsChanged]);

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

  async function handleShowConfig(p: Project) {
    setConfigFor(p);
    setConfigData(null);
    setConfigLoading(true);
    try {
      const data = await projectsApi.getOrchestratorConfig(p.id);
      setConfigData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config');
      setConfigFor(null);
    } finally {
      setConfigLoading(false);
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
              <th>Git Mode</th>
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
                <td data-label="Project Dir" className={styles.mono}>
                  {middleEllipsis(p.projectDir)}
                </td>
                <td data-label="Task Source">
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
                <td data-label="Git Mode">
                  <span className={styles.badge}>{p.gitMode ?? 'github'}</span>
                </td>
                <td data-label="# Milestones">{p.milestones.length}</td>
                <td data-label="GitHub Repo" className={styles.mono}>
                  {p.gitMode === 'local-only' ? '—' : (p.githubRepo ?? '—')}
                </td>
                <td className={styles.actionsCol}>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => void handleShowConfig(p)}
                  >
                    Config
                  </button>
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

      {configFor && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label={`Orchestrator config for ${configFor.name}`}
          onClick={() => setConfigFor(null)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>
              Orchestrator config — {configFor.name}
            </h3>
            {configLoading ? (
              <p className={styles.muted}>Loading…</p>
            ) : configData ? (
              <>
                {!configData.present && (
                  <p className={styles.muted}>
                    No .claude-orchestrator.yml found — using defaults.
                  </p>
                )}
                <ConfigReadOnly config={configData.config} />
              </>
            ) : null}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setConfigFor(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
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

export function ProjectsSettingsPanel(props: ProjectsSettingsPanelProps) {
  return (
    <ErrorBoundary name="ProjectsSettingsPanel">
      <ProjectsSettingsPanelInner {...props} />
    </ErrorBoundary>
  );
}
