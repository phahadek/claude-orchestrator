import { useCallback, useEffect, useState } from 'react';
import { codeAutoApprovedApi } from '../api/stagedIntents';
import type { CodeAutoApprovedFeedEntry } from '@claude-orchestrator/backend/src/routes/stagedIntents';
import { projectsApi } from '../api/projects';
import { subscribeCodeAutoApproveChange } from '../hooks/stagedIntentBus';
import styles from './FlowArmToggle.module.css';

interface Props {
  projectId: string | null;
  /** Driven by the project_code_auto_approve_changed WS event via the project prop. */
  enabled: boolean;
  /** Bumped by the caller on task / staged-intent WS events so the feed refetches. */
  refreshKey?: string;
}

interface EvidenceCondition {
  id?: string;
  passed?: boolean;
  detail?: string;
}

function clearedKey(projectId: string): string {
  return `codeAutoApprove.clearedAt.${projectId}`;
}

function conditionsOf(evidence: unknown): EvidenceCondition[] {
  const c = (evidence as { conditions?: unknown } | null)?.conditions;
  return Array.isArray(c) ? (c as EvidenceCondition[]) : [];
}

export function CodeAutoApproveSection({
  projectId,
  enabled: initialEnabled,
  refreshKey = '',
}: Props) {
  const [liveEnabled, setLiveEnabled] = useState(initialEnabled);
  const enabled = liveEnabled;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<CodeAutoApprovedFeedEntry[]>([]);
  const [clearedAt, setClearedAt] = useState(0);
  const [busyTask, setBusyTask] = useState<string | null>(null);

  useEffect(() => {
    setLiveEnabled(initialEnabled);
  }, [initialEnabled, projectId]);

  useEffect(
    () =>
      subscribeCodeAutoApproveChange((change) => {
        if (change.projectId === projectId) {
          setLiveEnabled(change.codeAutoApproveEnabled);
        }
      }),
    [projectId],
  );

  useEffect(() => {
    setClearedAt(
      projectId ? Number(localStorage.getItem(clearedKey(projectId)) ?? 0) : 0,
    );
  }, [projectId]);

  const load = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return codeAutoApprovedApi
      .feed(projectId, clearedAt || undefined)
      .then(setEntries)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [projectId, clearedAt]);

  useEffect(() => {
    setEntries([]);
    void load();
  }, [load, refreshKey]);

  if (!projectId) return null;

  const handleToggle = () => {
    setError(null);
    setPending(true);
    projectsApi
      .update(projectId, { codeAutoApproveEnabled: !enabled })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setPending(false));
  };

  const handleClear = () => {
    const now = Date.now();
    localStorage.setItem(clearedKey(projectId), String(now));
    setClearedAt(now);
  };

  const handleRevert = (entry: CodeAutoApprovedFeedEntry) => {
    if (!entry.taskId) return;
    setError(null);
    setBusyTask(entry.taskId);
    codeAutoApprovedApi
      .revert(projectId, entry.taskId, entry.groupId)
      .then(load)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusyTask(null));
  };

  return (
    <div className={styles.container} data-testid="code-auto-approve-section">
      <div className={styles.header}>
        <span className={styles.title}>Code auto-approve</span>
      </div>
      {error && (
        <div className={styles.error} data-testid="code-auto-approve-error">
          {error}
        </div>
      )}
      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.flowLabel}>
            auto-approve Code Ready flips
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Toggle Code auto-approve"
            disabled={pending}
            className={`${styles.toggle} ${enabled ? styles.toggleArmed : ''}`}
            data-testid="code-auto-approve-switch"
            onClick={handleToggle}
          >
            <span className={styles.toggleText}>{enabled ? 'On' : 'Off'}</span>
          </button>
        </div>
      </div>

      <div className={styles.header}>
        <span className={styles.title}>
          Auto-approved ({entries.length}
          {clearedAt ? ' since last cleared' : ''})
        </span>
        {entries.length > 0 && (
          <button
            type="button"
            data-testid="code-auto-approve-clear"
            onClick={handleClear}
          >
            Clear
          </button>
        )}
      </div>
      <div className={styles.rows} data-testid="code-auto-approve-feed">
        {entries.map((entry) => (
          <div
            key={entry.auditId}
            className={styles.row}
            data-testid={`code-auto-approve-entry-${entry.auditId}`}
          >
            <div>
              <div>{entry.taskName ?? entry.taskId ?? entry.groupId}</div>
              <div>
                standard {entry.standardVersion ?? '?'} / tripwire{' '}
                {entry.tripwireVersion ?? '?'}
                {entry.advisoryFlagged && (
                  <span data-testid="code-auto-approve-advisory-badge">
                    {' '}
                    ⚠ advisory flagged
                  </span>
                )}
                {entry.revertedAt && ' (reverted)'}
              </div>
              <ul>
                {conditionsOf(entry.evidence).map((c, i) => (
                  <li key={c.id ?? i}>
                    {c.passed ? '✓' : '✗'} {c.id}
                    {c.detail ? `: ${c.detail}` : ''}
                  </li>
                ))}
              </ul>
            </div>
            {entry.revertible && !entry.revertedAt && (
              <button
                type="button"
                disabled={busyTask === entry.taskId}
                data-testid={`code-auto-approve-revert-${entry.auditId}`}
                onClick={() => handleRevert(entry)}
              >
                Revert to Backlog
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
