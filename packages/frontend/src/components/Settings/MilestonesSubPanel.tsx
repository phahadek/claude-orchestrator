import { useState, useEffect, useCallback } from 'react';
import type { FormEvent } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import {
  projectsApi,
  type Project,
  type ProjectMilestone,
  type SourceValidation,
} from '../../api/projects';
import { getTaskSourceShortLabel } from '../../utils/taskSourceLabel';
import styles from './ProjectsSettingsPanel.module.css';

interface Props {
  project: Project;
  onBack: () => void;
  onMilestonesChanged?: () => void;
}

interface MilestoneDraft {
  name: string;
  sourceId: string;
  displayOrder: number;
}

const EMPTY_DRAFT: MilestoneDraft = { name: '', sourceId: '', displayOrder: 0 };

function MilestonesSubPanelInner({
  project,
  onBack,
  onMilestonesChanged,
}: Props) {
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProjectMilestone | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<MilestoneDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ProjectMilestone | null>(
    null,
  );
  const [sourceValidation, setSourceValidation] =
    useState<SourceValidation | null>(null);
  const [sourceValidating, setSourceValidating] = useState(false);
  const [sourceValidationError, setSourceValidationError] = useState<
    string | null
  >(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await projectsApi.listMilestones(project.id);
      setMilestones(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load milestones',
      );
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openAdd() {
    const nextOrder =
      milestones.length === 0
        ? 0
        : Math.max(...milestones.map((m) => m.displayOrder)) + 1;
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT, displayOrder: nextOrder });
    setFormError(null);
    setShowForm(true);
  }

  function openEdit(m: ProjectMilestone) {
    setEditing(m);
    setDraft({
      name: m.name,
      sourceId: m.sourceId ?? '',
      displayOrder: m.displayOrder,
    });
    setFormError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
    setSourceValidation(null);
    setSourceValidating(false);
    setSourceValidationError(null);
  }

  async function validateSource(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const source = project.taskSource;
    if (source === 'yaml') return;
    setSourceValidating(true);
    setSourceValidationError(null);
    setSourceValidation(null);
    try {
      if (source === 'notion') {
        const result = await projectsApi.validateNotionBoard(trimmed);
        setSourceValidation(result);
        if (result.type === 'page') {
          if (result.childDatabaseId) {
            setSourceValidationError(
              `This is a Notion page, not a database. It contains one child database ("${result.childDatabaseTitle ?? result.childDatabaseId}"). Use it instead?`,
            );
          } else {
            setSourceValidationError(
              'This is a Notion page, not a database. Please paste the URL of a Notion database.',
            );
          }
        }
      } else if (source === 'github') {
        const n = parseInt(trimmed, 10);
        if (isNaN(n) || n <= 0 || String(n) !== trimmed) {
          setSourceValidationError(
            'GitHub milestone source ID must be a positive integer (the milestone number).',
          );
          return;
        }
        const result = await projectsApi.validateGithubMilestone(project.id, n);
        setSourceValidation(result);
      } else if (source === 'jira') {
        if (!/^[A-Z][A-Z0-9]*-\d+$/.test(trimmed)) {
          setSourceValidationError(
            'Jira Epic key must match the format PROJECT-123.',
          );
          return;
        }
        const result = await projectsApi.validateJiraEpic(project.id, trimmed);
        setSourceValidation(result);
      }
    } catch (err) {
      setSourceValidationError(
        err instanceof Error ? err.message : 'Validation failed',
      );
      setSourceValidation(null);
    } finally {
      setSourceValidating(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) {
      setFormError('Name is required');
      return;
    }
    if (sourceValidation?.type === 'page') {
      setFormError(
        'The source ID points to a Notion page, not a database. Please fix the field above.',
      );
      return;
    }
    if (sourceValidationError) {
      setFormError('Please fix the source ID field above before saving.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const trimmedSource = draft.sourceId.trim();
      // Prefer the normalized ID returned by validation (Notion: database UUID)
      const resolvedSourceId =
        trimmedSource === ''
          ? null
          : sourceValidation?.type === 'database'
            ? sourceValidation.id
            : trimmedSource;
      if (editing) {
        await projectsApi.updateMilestone(editing.id, {
          name: draft.name,
          sourceId: resolvedSourceId,
          displayOrder: draft.displayOrder,
        });
      } else {
        await projectsApi.createMilestone(project.id, {
          name: draft.name,
          sourceId: resolvedSourceId,
          displayOrder: draft.displayOrder,
        });
      }
      closeForm();
      await reload();
      onMilestonesChanged?.();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Failed to save milestone',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    try {
      await projectsApi.deleteMilestone(target.id);
      await reload();
      onMilestonesChanged?.();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete milestone',
      );
    }
  }

  const sourceLabel =
    project.taskSource === 'yaml'
      ? 'YAML milestone id'
      : project.taskSource === 'github'
        ? 'GitHub milestone number'
        : project.taskSource === 'jira'
          ? 'Jira Epic key'
          : 'Notion database URL or ID';
  const sourcePlaceholder =
    project.taskSource === 'yaml'
      ? 'm1'
      : project.taskSource === 'github'
        ? '1'
        : project.taskSource === 'jira'
          ? 'PROJ-1'
          : 'https://www.notion.so/workspace/My-Board-abc123…';

  return (
    <div className={styles.subPanel}>
      <div className={styles.subPanelHeader}>
        <button type="button" className={styles.backBtn} onClick={onBack}>
          ← Projects
        </button>
        <div className={styles.subPanelTitleGroup}>
          <h3 className={styles.sectionTitle}>{project.name} — Milestones</h3>
          <p className={styles.hint}>
            Source: {getTaskSourceShortLabel(project.taskSource)}
          </p>
        </div>
        {project.taskSource !== 'yaml' && (
          <button type="button" className={styles.btnPrimary} onClick={openAdd}>
            + Add milestone
          </button>
        )}
      </div>
      {project.taskSource === 'yaml' && (
        <p className={styles.hint}>
          Milestones for YAML projects are managed via <code>tasks.yaml</code>{' '}
          and synced automatically.
        </p>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {loading ? (
        <p className={styles.muted}>Loading…</p>
      ) : milestones.length === 0 ? (
        <p className={styles.muted}>No milestones yet for this project.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Source ID</th>
              <th>Display Order</th>
              <th className={styles.actionsCol}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className={styles.mono}>{m.sourceId ?? '—'}</td>
                <td>{m.displayOrder}</td>
                <td className={styles.actionsCol}>
                  {project.taskSource !== 'yaml' && (
                    <>
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => openEdit(m)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`${styles.linkBtn} ${styles.danger}`}
                        onClick={() => setConfirmDelete(m)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label={editing ? 'Edit milestone' : 'Add milestone'}
          onClick={closeForm}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>
              {editing ? 'Edit milestone' : 'Add milestone'}
            </h3>
            <form onSubmit={(e) => void handleSubmit(e)}>
              <div className={styles.formField}>
                <label htmlFor="ms-name" className={styles.formLabel}>
                  Name
                </label>
                <input
                  id="ms-name"
                  type="text"
                  className={styles.input}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  autoFocus
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="ms-source" className={styles.formLabel}>
                  {sourceLabel}
                </label>
                <input
                  id="ms-source"
                  type="text"
                  className={styles.input}
                  value={draft.sourceId}
                  onChange={(e) => {
                    setDraft({ ...draft, sourceId: e.target.value });
                    setSourceValidation(null);
                    setSourceValidationError(null);
                  }}
                  onBlur={(e) => void validateSource(e.target.value)}
                  placeholder={sourcePlaceholder}
                />
                {sourceValidating && (
                  <p className={styles.muted}>Validating…</p>
                )}
                {!sourceValidating && sourceValidationError && (
                  <p className={styles.serverError}>
                    {sourceValidationError}
                    {sourceValidation?.type === 'page' &&
                      sourceValidation.childDatabaseId && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() => {
                              setDraft({
                                ...draft,
                                sourceId:
                                  sourceValidation.childDatabaseId ?? '',
                              });
                              setSourceValidation(null);
                              setSourceValidationError(null);
                            }}
                          >
                            Use child database
                          </button>
                        </>
                      )}
                  </p>
                )}
                {!sourceValidating &&
                  !sourceValidationError &&
                  sourceValidation?.type === 'database' && (
                    <p className={styles.muted}>
                      ✓{' '}
                      {sourceValidation.title
                        ? sourceValidation.title
                        : 'Valid Notion database'}
                    </p>
                  )}
                {!sourceValidating &&
                  !sourceValidationError &&
                  sourceValidation?.type === 'github-milestone' && (
                    <p className={styles.muted}>
                      ✓ #{sourceValidation.number} — {sourceValidation.title} (
                      {sourceValidation.state})
                    </p>
                  )}
                {!sourceValidating &&
                  !sourceValidationError &&
                  sourceValidation?.type === 'jira-epic' && (
                    <p className={styles.muted}>
                      ✓ {sourceValidation.key} — {sourceValidation.summary}
                    </p>
                  )}
              </div>
              <div className={styles.formField}>
                <label htmlFor="ms-order" className={styles.formLabel}>
                  Display Order
                </label>
                <input
                  id="ms-order"
                  type="number"
                  className={styles.input}
                  value={draft.displayOrder}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      displayOrder: Number(e.target.value) || 0,
                    })
                  }
                />
              </div>
              {formError && <p className={styles.serverError}>{formError}</p>}
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={closeForm}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={styles.btnPrimary}
                  disabled={submitting}
                >
                  {submitting ? 'Saving…' : editing ? 'Save' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm delete milestone"
          onClick={() => setConfirmDelete(null)}
        >
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete milestone?</h3>
            <p className={styles.muted}>
              This will remove the milestone{' '}
              <strong>{confirmDelete.name}</strong> from{' '}
              <strong>{project.name}</strong>. This cannot be undone.
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

export function MilestonesSubPanel(props: Props) {
  return (
    <ErrorBoundary name="MilestonesSubPanel">
      <MilestonesSubPanelInner {...props} />
    </ErrorBoundary>
  );
}
