import { useState } from 'react';
import type { FormEvent } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import {
  projectsApi,
  type Project,
  type JiraProjectConfig,
} from '../../api/projects';
import styles from './ProjectsSettingsPanel.module.css';

const DEFAULT_READY_STATUSES = ['To Do', 'Ready'];
const DEFAULT_STATUS_MAPPING: Record<string, string> = {
  '🔲 Backlog': 'Backlog',
  '🗂️ Ready': 'To Do',
  '🔄 In Progress': 'In Progress',
  '👀 In Review': 'In Review',
  '✅ Done': 'Done',
};
const DEFAULT_TYPE_MAP: Record<string, string> = {
  Story: '📋 Planning',
  Task: '💻 Code',
  'Sub-task': '💻 Code',
  Bug: '💻 Code',
};

interface PairRow {
  id: number;
  key: string;
  value: string;
}

let _nextId = 0;
function newId() {
  return _nextId++;
}

function toPairRows(obj: Record<string, string>): PairRow[] {
  return Object.entries(obj).map(([key, value]) => ({ id: newId(), key, value }));
}

function fromPairRows(rows: PairRow[]): Record<string, string> | undefined {
  const filled = rows.filter((r) => r.key.trim());
  if (filled.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const r of filled) out[r.key.trim()] = r.value;
  return out;
}

function parseConfig(json: string | null): JiraProjectConfig {
  if (!json) return { host: '', project_key: '' };
  try {
    return JSON.parse(json) as JiraProjectConfig;
  } catch {
    return { host: '', project_key: '' };
  }
}

interface Props {
  project: Project;
  onBack: () => void;
  onSaved?: () => void;
}

function JiraProjectConfigPanelInner({ project, onBack, onSaved }: Props) {
  const cfg = parseConfig(project.taskSourceConfig ?? null);

  const [projectKey, setProjectKey] = useState(cfg.project_key ?? '');
  const [host, setHost] = useState(cfg.host ?? '');
  const [epicField, setEpicField] = useState(cfg.epic_field ?? '');
  const [defaultJql, setDefaultJql] = useState(cfg.default_jql ?? '');
  const [readyStatuses, setReadyStatuses] = useState<string[]>(
    cfg.ready_statuses ?? [...DEFAULT_READY_STATUSES],
  );
  const [statusRows, setStatusRows] = useState<PairRow[]>(() =>
    toPairRows(cfg.status_mapping ?? DEFAULT_STATUS_MAPPING),
  );
  const [typeRows, setTypeRows] = useState<PairRow[]>(() =>
    toPairRows(cfg.type_mapping ?? DEFAULT_TYPE_MAP),
  );
  const [newStatusInput, setNewStatusInput] = useState('');
  const [projectKeyError, setProjectKeyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const isUnconfigured = !projectKey.trim();

  function addReadyStatus() {
    const trimmed = newStatusInput.trim();
    if (!trimmed || readyStatuses.includes(trimmed)) return;
    setReadyStatuses((prev) => [...prev, trimmed]);
    setNewStatusInput('');
  }

  function removeReadyStatus(s: string) {
    setReadyStatuses((prev) => prev.filter((x) => x !== s));
  }

  function updateStatusRow(id: number, field: 'key' | 'value', val: string) {
    setStatusRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)),
    );
  }

  function updateTypeRow(id: number, field: 'key' | 'value', val: string) {
    setTypeRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)),
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!projectKey.trim()) {
      setProjectKeyError('Project key is required');
      return;
    }
    setProjectKeyError(null);
    setSaving(true);
    setError(null);
    setSaved(false);

    const config: JiraProjectConfig = {
      project_key: projectKey.trim(),
      host: host.trim(),
    };
    if (epicField) config.epic_field = epicField;
    if (defaultJql.trim()) config.default_jql = defaultJql.trim();
    if (readyStatuses.length > 0) config.ready_statuses = readyStatuses;
    const sm = fromPairRows(statusRows);
    if (sm) config.status_mapping = sm;
    const tm = fromPairRows(typeRows);
    if (tm) config.type_mapping = tm;

    try {
      await projectsApi.update(project.id, {
        taskSourceConfig: JSON.stringify(config),
      });
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.subPanel}>
      <div className={styles.subPanelHeader}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          ← Back
        </button>
        <div className={styles.subPanelTitleGroup}>
          <h3 className={styles.sectionTitle}>
            Jira Config — {project.name}
          </h3>
        </div>
      </div>

      {isUnconfigured && (
        <p className={styles.warning}>
          This Jira project has no project key configured. It will produce
          broken JQL and cannot fetch tasks until you set one below.
        </p>
      )}

      {error && <p className={styles.error}>{error}</p>}
      {saved && <p className={styles.success}>Saved.</p>}

      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className={styles.formField}>
          <label htmlFor="jira-project-key" className={styles.formLabel}>
            Project Key <span style={{ color: '#f38ba8' }}>*</span>
          </label>
          <input
            id="jira-project-key"
            type="text"
            className={styles.input}
            value={projectKey}
            onChange={(e) => {
              setProjectKey(e.target.value);
              if (projectKeyError) setProjectKeyError(null);
            }}
            placeholder="PROJ"
            autoFocus
          />
          {projectKeyError && (
            <p className={styles.fieldError}>{projectKeyError}</p>
          )}
          <p className={styles.fieldHelp}>
            The Jira project key used to scope JQL queries (e.g. PROJ, ACME).
          </p>
        </div>

        <div className={styles.formField}>
          <label htmlFor="jira-host" className={styles.formLabel}>
            Host (optional)
          </label>
          <input
            id="jira-host"
            type="text"
            className={styles.input}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="https://your-org.atlassian.net"
          />
          <p className={styles.fieldHelp}>
            Overrides the global JIRA_HOST env var for this project.
          </p>
        </div>

        <div className={styles.formField}>
          <label htmlFor="jira-epic-field" className={styles.formLabel}>
            Epic Field
          </label>
          <select
            id="jira-epic-field"
            className={styles.input}
            value={epicField}
            onChange={(e) => setEpicField(e.target.value)}
          >
            <option value="">Auto-detect (recommended)</option>
            <option value="parent">parent — Jira next-gen / Cloud</option>
            <option value="Epic Link">Epic Link — classic Jira</option>
          </select>
          <p className={styles.fieldHelp}>
            Forces the JQL field for Epic parent lookups. Leave as auto-detect
            unless you see errors fetching epic children.
          </p>
        </div>

        <div className={styles.formField}>
          <label htmlFor="jira-default-jql" className={styles.formLabel}>
            Default JQL (optional)
          </label>
          <textarea
            id="jira-default-jql"
            className={styles.input}
            rows={3}
            value={defaultJql}
            onChange={(e) => setDefaultJql(e.target.value)}
            placeholder={
              projectKey.trim()
                ? `project = "${projectKey.trim()}" AND status in ("To Do","Ready") ORDER BY priority DESC`
                : 'project = "PROJ" AND status in ("To Do","Ready") ORDER BY priority DESC'
            }
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8125rem' }}
          />
          <p className={styles.fieldHelp}>
            Full JQL override for fetchReadyTasks. When set, ready_statuses is
            ignored for the default (no-milestone) query.
          </p>
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel}>Ready Statuses</label>
          <p className={styles.fieldHelp}>
            Jira status names that mark an issue as ready to launch. Defaults:{' '}
            {DEFAULT_READY_STATUSES.join(', ')}.
          </p>
          <div className={styles.chipList}>
            {readyStatuses.map((s) => (
              <span key={s} className={styles.chip}>
                {s}
                <button
                  type="button"
                  className={styles.chipDeleteBtn}
                  onClick={() => removeReadyStatus(s)}
                  aria-label={`Remove ${s}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              type="text"
              className={styles.input}
              value={newStatusInput}
              onChange={(e) => setNewStatusInput(e.target.value)}
              placeholder="Add status…"
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addReadyStatus();
                }
              }}
            />
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={addReadyStatus}
              style={{ flexShrink: 0 }}
            >
              Add
            </button>
          </div>
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel}>Status Mapping</label>
          <p className={styles.fieldHelp}>
            Maps orchestrator display statuses to Jira status names.
          </p>
          <table className={styles.pairTable}>
            <thead>
              <tr>
                <th>Orchestrator Status</th>
                <th>Jira Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {statusRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="text"
                      className={styles.input}
                      value={row.key}
                      onChange={(e) =>
                        updateStatusRow(row.id, 'key', e.target.value)
                      }
                      placeholder="🔲 Backlog"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className={styles.input}
                      value={row.value}
                      onChange={(e) =>
                        updateStatusRow(row.id, 'value', e.target.value)
                      }
                      placeholder="Backlog"
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`${styles.linkBtn} ${styles.danger}`}
                      onClick={() =>
                        setStatusRows((prev) =>
                          prev.filter((r) => r.id !== row.id),
                        )
                      }
                      aria-label="Remove row"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() =>
              setStatusRows((prev) => [
                ...prev,
                { id: newId(), key: '', value: '' },
              ])
            }
            style={{ marginTop: 4, fontSize: '0.75rem', padding: '3px 10px' }}
          >
            + Add row
          </button>
        </div>

        <div className={styles.formField}>
          <label className={styles.formLabel}>Type Mapping</label>
          <p className={styles.fieldHelp}>
            Maps Jira issue type names to orchestrator type strings.
          </p>
          <table className={styles.pairTable}>
            <thead>
              <tr>
                <th>Jira Issue Type</th>
                <th>Orchestrator Type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {typeRows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="text"
                      className={styles.input}
                      value={row.key}
                      onChange={(e) =>
                        updateTypeRow(row.id, 'key', e.target.value)
                      }
                      placeholder="Story"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className={styles.input}
                      value={row.value}
                      onChange={(e) =>
                        updateTypeRow(row.id, 'value', e.target.value)
                      }
                      placeholder="📋 Planning"
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`${styles.linkBtn} ${styles.danger}`}
                      onClick={() =>
                        setTypeRows((prev) =>
                          prev.filter((r) => r.id !== row.id),
                        )
                      }
                      aria-label="Remove row"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() =>
              setTypeRows((prev) => [
                ...prev,
                { id: newId(), key: '', value: '' },
              ])
            }
            style={{ marginTop: 4, fontSize: '0.75rem', padding: '3px 10px' }}
          >
            + Add row
          </button>
        </div>

        {error && <p className={styles.serverError}>{error}</p>}

        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={onBack}
            disabled={saving}
          >
            Back
          </button>
          <button type="submit" className={styles.btnPrimary} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function JiraProjectConfigPanel(props: Props) {
  return (
    <ErrorBoundary name="JiraProjectConfigPanel">
      <JiraProjectConfigPanelInner {...props} />
    </ErrorBoundary>
  );
}
