import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import type {
  Project,
  TaskSource,
  GitMode,
  GithubMilestone,
  GithubTaskSourceConfig,
} from '../../api/projects';
import { projectsApi } from '../../api/projects';
import styles from './ProjectsSettingsPanel.module.css';

export interface ProjectFormValues {
  name: string;
  projectDir: string;
  contextUrl: string;
  githubRepo: string;
  taskSource: TaskSource;
  gitMode: GitMode;
  autoLaunchEnabled: boolean;
  autoLaunchMilestoneId: string;
  autoMergeEnabled: boolean;
  nonMilestoneSourceConfigRaw: string;
  dataResidencyConfirmed: boolean;
  githubOwnerRepo: string;
  githubDefaultMilestone: number | null;
  baseBranch: string;
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
  gitMode: 'github',
  autoLaunchEnabled: false,
  autoLaunchMilestoneId: '',
  autoMergeEnabled: false,
  nonMilestoneSourceConfigRaw: '',
  dataResidencyConfirmed: false,
  githubOwnerRepo: '',
  githubDefaultMilestone: null,
  baseBranch: 'dev',
};

const OWNER_REPO_RE = /^[^/]+\/[^/]+$/;

function parseGithubConfig(
  taskSourceConfig: string | null,
): GithubTaskSourceConfig | null {
  if (!taskSourceConfig) return null;
  try {
    return JSON.parse(taskSourceConfig) as GithubTaskSourceConfig;
  } catch {
    return null;
  }
}

function fromProject(p: Project): ProjectFormValues {
  const githubCfg = parseGithubConfig(p.taskSourceConfig ?? null);
  return {
    name: p.name,
    projectDir: p.projectDir,
    contextUrl: p.contextUrl ?? '',
    githubRepo: p.githubRepo ?? '',
    taskSource: p.taskSource,
    gitMode: p.gitMode ?? 'github',
    autoLaunchEnabled: p.autoLaunchEnabled,
    autoLaunchMilestoneId: p.autoLaunchMilestoneId ?? '',
    autoMergeEnabled: p.autoMergeEnabled,
    nonMilestoneSourceConfigRaw: p.nonMilestoneSourceConfig
      ? JSON.stringify(p.nonMilestoneSourceConfig)
      : '',
    dataResidencyConfirmed: p.dataResidencyConfirmed ?? false,
    githubOwnerRepo: githubCfg ? `${githubCfg.owner}/${githubCfg.repo}` : '',
    githubDefaultMilestone: githubCfg?.defaultMilestone ?? null,
    baseBranch: p.baseBranch ?? 'dev',
  };
}

export function ProjectFormModal({
  initialProject,
  onCancel,
  onSubmit,
}: Props) {
  const [values, setValues] = useState<ProjectFormValues>(() =>
    initialProject ? fromProject(initialProject) : EMPTY,
  );
  const [errors, setErrors] = useState<{
    name?: string;
    projectDir?: string;
    nonMilestoneSourceConfigRaw?: string;
    githubOwnerRepo?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [githubMilestones, setGithubMilestones] = useState<GithubMilestone[]>(
    [],
  );
  const [milestonesLoading, setMilestonesLoading] = useState(false);

  useEffect(() => {
    setValues(initialProject ? fromProject(initialProject) : EMPTY);
    setErrors({});
    setServerError(null);
    setGithubMilestones([]);
  }, [initialProject]);

  // Lazy-load milestones when editing a github-source project
  useEffect(() => {
    if (
      values.taskSource !== 'github' ||
      !initialProject ||
      !initialProject.taskSourceConfig
    ) {
      return;
    }
    setMilestonesLoading(true);
    projectsApi
      .listGithubMilestones(initialProject.id)
      .then((ms) => setGithubMilestones(ms))
      .catch(() => setGithubMilestones([]))
      .finally(() => setMilestonesLoading(false));
  }, [values.taskSource, initialProject]);

  function update<K extends keyof ProjectFormValues>(
    key: K,
    value: ProjectFormValues[K],
  ) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const nextErrors: {
      name?: string;
      projectDir?: string;
      nonMilestoneSourceConfigRaw?: string;
      githubOwnerRepo?: string;
    } = {};
    if (!values.name.trim()) nextErrors.name = 'Name is required';
    if (!values.projectDir.trim())
      nextErrors.projectDir = 'Project Dir is required';
    const rawCfg = values.nonMilestoneSourceConfigRaw.trim();
    if (rawCfg) {
      try {
        const parsed = JSON.parse(rawCfg) as unknown;
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          nextErrors.nonMilestoneSourceConfigRaw = 'Must be a JSON object';
        } else {
          const obj = parsed as Record<string, unknown>;
          if (
            (obj.notionDatabaseId !== undefined &&
              typeof obj.notionDatabaseId !== 'string') ||
            (obj.milestoneId !== undefined &&
              typeof obj.milestoneId !== 'string')
          ) {
            nextErrors.nonMilestoneSourceConfigRaw =
              'Must have shape {notionDatabaseId?: string; milestoneId?: string}';
          }
        }
      } catch {
        nextErrors.nonMilestoneSourceConfigRaw = 'Invalid JSON';
      }
    }
    if (values.taskSource === 'github') {
      const ownerRepo = values.githubOwnerRepo.trim();
      if (!ownerRepo) {
        nextErrors.githubOwnerRepo = 'Repository is required (owner/repo)';
      } else if (!OWNER_REPO_RE.test(ownerRepo)) {
        nextErrors.githubOwnerRepo = 'Must be in owner/repo format';
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    setServerError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : 'Failed to save project',
      );
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
        <h3 className={styles.modalTitle}>
          {isEdit ? 'Edit project' : 'Add project'}
        </h3>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className={styles.formField}>
            <label htmlFor="proj-name" className={styles.formLabel}>
              Name
            </label>
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
            <label htmlFor="proj-dir" className={styles.formLabel}>
              Project Dir
            </label>
            <input
              id="proj-dir"
              type="text"
              className={styles.input}
              value={values.projectDir}
              onChange={(e) => update('projectDir', e.target.value)}
              placeholder="/absolute/path/to/repo"
            />
            {errors.projectDir && (
              <p className={styles.fieldError}>{errors.projectDir}</p>
            )}
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-base-branch" className={styles.formLabel}>
              Base Branch
            </label>
            <input
              id="proj-base-branch"
              type="text"
              className={styles.input}
              value={values.baseBranch}
              onChange={(e) => update('baseBranch', e.target.value)}
              placeholder="main"
            />
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-source" className={styles.formLabel}>
              Task Source
            </label>
            <select
              id="proj-source"
              className={styles.input}
              value={values.taskSource}
              onChange={(e) => {
                const val = e.target.value as TaskSource;
                const valid: TaskSource[] = [
                  'notion',
                  'yaml',
                  'github',
                  'jira',
                ];
                update('taskSource', valid.includes(val) ? val : 'notion');
              }}
            >
              <option value="notion">Notion</option>
              <option value="yaml">YAML (tasks.yaml in projectDir)</option>
              <option value="github">GitHub Issues</option>
              <option value="jira">Jira</option>
            </select>
          </div>

          {values.taskSource === 'github' && (
            <>
              <div className={styles.formField}>
                <label
                  htmlFor="proj-github-owner-repo"
                  className={styles.formLabel}
                >
                  Repository
                </label>
                <input
                  id="proj-github-owner-repo"
                  type="text"
                  className={styles.input}
                  value={values.githubOwnerRepo}
                  onChange={(e) => update('githubOwnerRepo', e.target.value)}
                  placeholder="owner/repo"
                />
                {errors.githubOwnerRepo && (
                  <p className={styles.fieldError}>{errors.githubOwnerRepo}</p>
                )}
              </div>

              <div className={styles.formField}>
                <label
                  htmlFor="proj-github-milestone"
                  className={styles.formLabel}
                >
                  Default Milestone
                </label>
                {!isEdit ? (
                  <p className={styles.fieldHelp}>
                    Save the project first, then re-open to select a milestone.
                  </p>
                ) : (
                  <>
                    <select
                      id="proj-github-milestone"
                      className={styles.input}
                      value={
                        values.githubDefaultMilestone !== null
                          ? String(values.githubDefaultMilestone)
                          : ''
                      }
                      onChange={(e) =>
                        update(
                          'githubDefaultMilestone',
                          e.target.value ? Number(e.target.value) : null,
                        )
                      }
                      disabled={milestonesLoading}
                    >
                      <option value="">
                        {milestonesLoading ? 'Loading…' : 'All milestones'}
                      </option>
                      {githubMilestones.map((m) => (
                        <option key={m.id} value={String(m.id)}>
                          {m.title}
                        </option>
                      ))}
                    </select>
                    <p className={styles.fieldHelp}>
                      Leave empty to fetch all Ready issues in the repo,
                      regardless of milestone.
                    </p>
                  </>
                )}
              </div>
            </>
          )}

          <div className={styles.formField}>
            <label htmlFor="proj-git-mode" className={styles.formLabel}>
              Git Mode
            </label>
            <select
              id="proj-git-mode"
              className={styles.input}
              value={values.gitMode}
              onChange={(e) =>
                update(
                  'gitMode',
                  e.target.value === 'local-only' ? 'local-only' : 'github',
                )
              }
            >
              <option value="github">
                GitHub (default) — PR-based workflow
              </option>
              <option value="local-only">Local only — no GitHub remote</option>
            </select>
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-context" className={styles.formLabel}>
              Context URL (optional)
            </label>
            <input
              id="proj-context"
              type="text"
              className={styles.input}
              value={values.contextUrl}
              onChange={(e) => update('contextUrl', e.target.value)}
              placeholder="https://www.notion.so/…"
            />
          </div>

          {values.gitMode !== 'local-only' && (
            <div className={styles.formField}>
              <label htmlFor="proj-repo" className={styles.formLabel}>
                GitHub Repo (optional)
              </label>
              <input
                id="proj-repo"
                type="text"
                className={styles.input}
                value={values.githubRepo}
                onChange={(e) => update('githubRepo', e.target.value)}
                placeholder="owner/repo"
              />
            </div>
          )}

          <div className={styles.formField}>
            <label htmlFor="proj-auto-launch" className={styles.formLabel}>
              <input
                id="proj-auto-launch"
                type="checkbox"
                checked={values.autoLaunchEnabled}
                onChange={(e) => update('autoLaunchEnabled', e.target.checked)}
              />{' '}
              Auto-launch Ready 💻 Code tasks
            </label>
          </div>

          {values.autoLaunchEnabled &&
            initialProject &&
            initialProject.milestones.length > 1 && (
              <div className={styles.formField}>
                <label
                  htmlFor="proj-auto-launch-milestone"
                  className={styles.formLabel}
                >
                  Auto-launch milestone
                </label>
                <select
                  id="proj-auto-launch-milestone"
                  className={styles.input}
                  value={values.autoLaunchMilestoneId}
                  onChange={(e) =>
                    update('autoLaunchMilestoneId', e.target.value)
                  }
                >
                  <option value="">First configured milestone</option>
                  {initialProject.milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

          {values.gitMode !== 'local-only' && (
            <div className={styles.formField}>
              <label htmlFor="proj-auto-merge" className={styles.formLabel}>
                <input
                  id="proj-auto-merge"
                  type="checkbox"
                  checked={values.autoMergeEnabled}
                  onChange={(e) => update('autoMergeEnabled', e.target.checked)}
                />{' '}
                Auto-merge approved PRs when CI is green
              </label>
            </div>
          )}

          <div className={styles.formField}>
            <label htmlFor="proj-nm-source" className={styles.formLabel}>
              Non-milestone task source (optional)
            </label>
            <input
              id="proj-nm-source"
              type="text"
              className={styles.input}
              value={values.nonMilestoneSourceConfigRaw}
              onChange={(e) =>
                update('nonMilestoneSourceConfigRaw', e.target.value)
              }
              placeholder={
                values.taskSource === 'yaml'
                  ? '{"milestoneId":"backlog"}'
                  : '{"notionDatabaseId":"<database-id>"}'
              }
            />
            <p className={styles.fieldHelp}>
              JSON config for the non-milestone task pool.
              {values.taskSource === 'yaml'
                ? ' For YAML projects: {"milestoneId": "…"}'
                : ' For Notion projects: {"notionDatabaseId": "…"}'}
            </p>
            {errors.nonMilestoneSourceConfigRaw && (
              <p className={styles.fieldError}>
                {errors.nonMilestoneSourceConfigRaw}
              </p>
            )}
          </div>

          <div className={styles.formField}>
            <label htmlFor="proj-zdr" className={styles.formLabel}>
              <input
                id="proj-zdr"
                type="checkbox"
                checked={values.dataResidencyConfirmed}
                onChange={(e) =>
                  update('dataResidencyConfirmed', e.target.checked)
                }
              />{' '}
              I confirm Zero Data Retention (ZDR) is enabled for this Anthropic
              account
            </label>
            <p className={styles.fieldHelp}>
              This is a user attestation — the orchestrator cannot
              programmatically verify ZDR. In corporate mode, sessions will not
              launch unless this box is checked. Toggling this setting is
              recorded in the audit log.
            </p>
          </div>

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
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
