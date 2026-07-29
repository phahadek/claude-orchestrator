import styles from './DecisionPanel.module.css';

interface Props {
  /** Every clean-triaged group id in scope (session-local, or pooled across a milestone's sessions). */
  cleanGroupIds: string[];
  /** cleanGroupIds minus the operator's per-group vetoes — the set the batch action actually commits. */
  includedCount: number;
  inFlight: boolean;
  error: string | null;
  onApprove: () => void;
}

/**
 * The approve-by-standard fast path: a single action that commits every
 * included clean-verdict group in one operator disposition (see
 * planning/triage.ts). Extracted unchanged from DecisionPanel's inline
 * clean-batch bar so MilestoneDecisionInbox can pool clean groups across an
 * entire milestone's sessions through the same element — the batch is
 * already group-based and milestone-aware server-side (commitBatch), so
 * pooling requires no API change here, only feeding it a wider group set.
 */
export function TriageBatchPanel({
  cleanGroupIds,
  includedCount,
  inFlight,
  error,
  onApprove,
}: Props) {
  if (cleanGroupIds.length === 0) return null;

  return (
    <div className={styles.group} data-testid="clean-batch-bar">
      <div className={styles.groupHeader}>
        <span>Clean verdict ({cleanGroupIds.length})</span>
      </div>
      <button
        type="button"
        className={styles.commitButton}
        disabled={includedCount === 0 || inFlight}
        onClick={onApprove}
        data-testid="approve-all-clean"
      >
        {inFlight ? 'Approving…' : `✓ Approve all clean (${includedCount})`}
      </button>
      {error && <div className={styles.groupError}>{error}</div>}
    </div>
  );
}
