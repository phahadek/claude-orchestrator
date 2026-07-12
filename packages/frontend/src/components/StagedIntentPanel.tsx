import { useState, type ReactNode } from 'react';
import type { StagedIntent } from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import styles from './StagedIntentPanel.module.css';

interface Props {
  intent: StagedIntent;
  onApplied?: (intent: StagedIntent, result: unknown) => void;
  onRejected?: (intent: StagedIntent) => void;
}

function renderPayload(payload: unknown): ReactNode {
  if (payload == null) return null;
  if (typeof payload === 'string')
    return <p className={styles.text}>{payload}</p>;
  return (
    <pre className={styles.payload}>{JSON.stringify(payload, null, 2)}</pre>
  );
}

/**
 * The shared staged-intent display: renders a pending intent (kind + payload)
 * with human-gated Apply/Reject controls. Apply always dispatches through the
 * general command/stage surface (never a bespoke per-producer write); Reject
 * discards the intent. Producer-specific rendering lives entirely in payload.
 */
export function StagedIntentPanel({ intent, onApplied, onRejected }: Props) {
  const [inFlight, setInFlight] = useState<'apply' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleApply = async () => {
    setInFlight('apply');
    setError(null);
    try {
      const { result } = await stagedIntentsApi.apply(intent.id);
      onApplied?.(intent, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply intent');
    } finally {
      setInFlight(null);
    }
  };

  const handleReject = async () => {
    setInFlight('reject');
    setError(null);
    try {
      await stagedIntentsApi.reject(intent.id);
      onRejected?.(intent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject intent');
    } finally {
      setInFlight(null);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.kind}>{intent.kind}</span>
        {intent.groupId && (
          <span className={styles.groupBadge} data-testid="staged-intent-group">
            {intent.groupId}
          </span>
        )}
      </div>

      <div className={styles.body}>{renderPayload(intent.payload)}</div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.permissionButtons}>
        <button
          type="button"
          className={styles.approveButton}
          disabled={inFlight !== null}
          onClick={handleApply}
        >
          {inFlight === 'apply' ? 'Applying...' : '✓ Apply'}
        </button>
        <button
          type="button"
          className={styles.denyButton}
          disabled={inFlight !== null}
          onClick={handleReject}
        >
          {inFlight === 'reject' ? 'Rejecting...' : '✕ Reject'}
        </button>
      </div>
    </div>
  );
}
