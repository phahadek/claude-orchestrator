import { useState, useEffect } from 'react';
import { StagedIntentPanel } from './StagedIntentPanel';
import { DecisionPickOnePanel } from './DecisionPickOnePanel';
import { TriageBatchPanel } from './TriageBatchPanel';
import { taskIdFor } from './triageVerdict';
import { useDecisionQueue } from '../hooks/useDecisionQueue';
import styles from './DecisionPanel.module.css';

interface Props {
  sessionId: string;
}

/**
 * The operator decision surface for a live session: staged/approved
 * proposals correlated to this session_id, grouped by groupId, rendered
 * beside the transcript. REST (stagedIntentsApi) is the fetch/apply source
 * of truth; the staged_intent_changed WS message (via stagedIntentBus) only
 * triggers an in-place update so the panel never needs a manual refetch.
 * The fetch/partition/rank/batch logic lives in useDecisionQueue, shared
 * with MilestoneDecisionInbox — this component only supplies the session
 * scope and its own JSX.
 */
export function DecisionPanel({ sessionId }: Props) {
  const {
    intents,
    loaded,
    groupEntries,
    ungrouped,
    cleanGroupIds,
    includedCleanGroupIds,
    batchExcluded,
    toggleBatchExcluded,
    batchInFlight,
    batchError,
    batchExceptions,
    handleApproveAllClean,
    groupInFlight,
    groupError,
    draftFor,
    setDraft,
    handleApproveGroup,
    handleRejectGroup,
    upsert,
    remove,
  } = useDecisionQueue({ type: 'session', sessionId });
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(false);
  }, [sessionId]);

  if (!loaded || intents.length === 0) return null;

  if (collapsed) {
    return (
      <div
        className={styles.collapsedBar}
        data-testid="decision-panel"
        data-collapsed="true"
      >
        <button
          type="button"
          className={styles.expandButton}
          onClick={() => setCollapsed(false)}
          aria-label={`Show ${intents.length} pending proposal${intents.length === 1 ? '' : 's'}`}
        >
          ▲ Proposals ({intents.length})
        </button>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-testid="decision-panel">
      <div className={styles.headingRow}>
        <div className={styles.heading}>
          Proposals (
          {groupEntries.length > 0
            ? `${intents.length} intent${intents.length === 1 ? '' : 's'} across ${groupEntries.length} group${groupEntries.length === 1 ? '' : 's'}`
            : intents.length}
          )
        </div>
        <button
          type="button"
          className={styles.dismissButton}
          onClick={() => setCollapsed(true)}
          aria-label="Dismiss proposals panel"
        >
          ✕
        </button>
      </div>

      <TriageBatchPanel
        cleanGroupIds={cleanGroupIds}
        includedCount={includedCleanGroupIds.length}
        inFlight={batchInFlight}
        error={batchError}
        onApprove={() => void handleApproveAllClean()}
      />

      {groupEntries.map(([groupId, groupIntents]) => {
        const draft = draftFor(groupId);
        const inFlight = groupInFlight === groupId;
        const isClean = cleanGroupIds.includes(groupId);
        return (
          <div key={groupId} className={styles.group}>
            <div className={styles.groupHeader}>
              <span>Group {groupId}</span>
              {isClean && (
                <label>
                  <input
                    type="checkbox"
                    checked={!batchExcluded[groupId]}
                    onChange={() => toggleBatchExcluded(groupId)}
                    aria-label={`Include ${taskIdFor(groupIntents) ?? groupId} in approve all clean`}
                    data-testid={`clean-batch-include-${groupId}`}
                  />
                  <span
                    className={styles.cleanBadge}
                    data-testid={`clean-badge-${groupId}`}
                  >
                    Clean
                  </span>
                </label>
              )}
            </div>
            {batchExceptions[groupId] && (
              <div className={styles.groupError}>
                {batchExceptions[groupId]}
              </div>
            )}
            {groupError && groupInFlight === null && (
              <div className={styles.groupError}>{groupError}</div>
            )}
            {groupIntents.map((intent) => (
              <StagedIntentPanel
                key={intent.id}
                intent={intent}
                onApplied={remove}
                onRejected={remove}
                onDismiss={remove}
                onApproved={upsert}
                hideActions
              />
            ))}
            <div className={styles.groupActions}>
              <button
                type="button"
                className={styles.commitButton}
                disabled={inFlight}
                onClick={() => void handleApproveGroup(groupId)}
              >
                {inFlight ? 'Approving…' : '✓ Approve groom'}
              </button>
              <div
                className={styles.outcomeToggle}
                role="radiogroup"
                aria-label="Reject outcome"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.outcome === 'pushback'}
                  className={
                    draft.outcome === 'pushback'
                      ? styles.outcomeOptionActive
                      : styles.outcomeOption
                  }
                  onClick={() => setDraft(groupId, { outcome: 'pushback' })}
                >
                  Pushback
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.outcome === 'decline'}
                  className={
                    draft.outcome === 'decline'
                      ? styles.outcomeOptionActive
                      : styles.outcomeOption
                  }
                  onClick={() => setDraft(groupId, { outcome: 'decline' })}
                >
                  Decline
                </button>
              </div>
              <textarea
                className={styles.reasonInput}
                placeholder={
                  draft.outcome === 'pushback'
                    ? 'What should the session revise?'
                    : 'Why is this being declined?'
                }
                value={draft.reason}
                onChange={(e) => setDraft(groupId, { reason: e.target.value })}
              />
              <button
                type="button"
                className={styles.denyButton}
                disabled={inFlight || !draft.reason.trim()}
                onClick={() => void handleRejectGroup(groupId)}
              >
                {inFlight
                  ? 'Submitting…'
                  : draft.outcome === 'pushback'
                    ? '↩ Pushback groom'
                    : '✕ Decline groom'}
              </button>
            </div>
          </div>
        );
      })}

      {ungrouped.map((intent) =>
        intent.kind === 'decision.pickOne' ? (
          <DecisionPickOnePanel
            key={intent.id}
            intent={intent}
            onAnswered={remove}
            onDismiss={remove}
          />
        ) : (
          <StagedIntentPanel
            key={intent.id}
            intent={intent}
            onApplied={remove}
            onRejected={remove}
            onDismiss={remove}
            onApproved={upsert}
          />
        ),
      )}
    </div>
  );
}
