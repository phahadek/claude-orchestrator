import { useEffect, useState } from 'react';
import type { StagedIntent } from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import { taskIdFor } from './triageVerdict';
import { StagedIntentPanel } from './StagedIntentPanel';
import styles from './DecisionPanel.module.css';

interface Props {
  /** Clean-verdict groups only — the caller filters non-clean rows out to the standard per-item decision surface. */
  groups: [string, StagedIntent[]][];
  /** Called with the groupIds that fully committed, so the caller can drop their intents from state. */
  onCommitted: (groupIds: string[]) => void;
}

/**
 * The approve-by-standard decision surface for one triaged interactive-type
 * batch's clean rows: default-approved (pre-checked), veto-able (uncheck to
 * exclude), and committed on a single operator disposition. Each Ready-flip
 * still applies individually server-side, so a clean row whose apply fails
 * its gate surfaces here as a per-row exception rather than aborting the
 * rest of the batch.
 */
export function TriageBatchPanel({ groups, onCommitted }: Props) {
  const [vetoed, setVetoed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [milestoneLabel, setMilestoneLabel] = useState('');
  const [inFlight, setInFlight] = useState(false);
  const [exceptions, setExceptions] = useState<Record<string, string>>({});
  const [batchError, setBatchError] = useState<string | null>(null);

  useEffect(() => {
    setVetoed((prev) => {
      const liveIds = new Set(groups.map(([groupId]) => groupId));
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const groupId of liveIds) {
        next[groupId] = prev[groupId] ?? false;
        if (!(groupId in prev)) changed = true;
      }
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [groups]);

  if (groups.length === 0) return null;

  const includedGroupIds = groups
    .map(([groupId]) => groupId)
    .filter((groupId) => !vetoed[groupId]);

  const toggleVeto = (groupId: string) => {
    setVetoed((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const toggleExpanded = (groupId: string) => {
    setExpanded((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const handleCommit = async () => {
    if (includedGroupIds.length === 0) return;
    setInFlight(true);
    setBatchError(null);
    try {
      const result = await stagedIntentsApi.commitBatch(
        includedGroupIds,
        milestoneLabel.trim() || undefined,
      );
      onCommitted(result.committed);
      const nextExceptions: Record<string, string> = {};
      for (const exc of result.exceptions) {
        nextExceptions[exc.groupId] = exc.error;
      }
      setExceptions(nextExceptions);
    } catch (err) {
      setBatchError(
        err instanceof Error ? err.message : 'Failed to commit batch',
      );
    } finally {
      setInFlight(false);
    }
  };

  return (
    <div className={styles.group} data-testid="triage-batch-panel">
      <div className={styles.groupHeader}>
        <span>Clean triage batch ({groups.length})</span>
      </div>
      <input
        type="text"
        placeholder="Milestone label (e.g. M12)"
        value={milestoneLabel}
        onChange={(e) => setMilestoneLabel(e.target.value)}
        data-testid="triage-batch-milestone-input"
      />
      {groups.map(([groupId, intents]) => (
        <div key={groupId} data-testid={`triage-row-${groupId}`}>
          <label className={styles.groupHeader}>
            <input
              type="checkbox"
              checked={!vetoed[groupId]}
              onChange={() => toggleVeto(groupId)}
              data-testid={`triage-veto-${groupId}`}
            />
            <span>{taskIdFor(intents) ?? groupId}</span>
            {exceptions[groupId] && (
              <span className={styles.groupError}>{exceptions[groupId]}</span>
            )}
          </label>
          <button
            type="button"
            className={styles.expandButton}
            onClick={() => toggleExpanded(groupId)}
            data-testid={`triage-expand-${groupId}`}
            aria-expanded={!!expanded[groupId]}
          >
            {expanded[groupId] ? '▾ Hide detail' : '▸ Show detail'}
          </button>
          {expanded[groupId] && (
            <div data-testid={`triage-detail-${groupId}`}>
              {intents.map((intent) => (
                <StagedIntentPanel
                  key={intent.id}
                  intent={intent}
                  hideActions
                />
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className={styles.commitButton}
        disabled={includedGroupIds.length === 0 || inFlight}
        onClick={() => void handleCommit()}
        data-testid="triage-batch-commit"
      >
        {inFlight
          ? 'Committing…'
          : `Commit clean set (${includedGroupIds.length})`}
      </button>
      {batchError && <div className={styles.groupError}>{batchError}</div>}
    </div>
  );
}
