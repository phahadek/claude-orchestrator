import { useState, type ReactNode } from 'react';
import type { StagedIntent } from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import styles from './StagedIntentPanel.module.css';

interface Props {
  intent: StagedIntent;
  onApplied?: (intent: StagedIntent, result: unknown) => void;
  onRejected?: (intent: StagedIntent) => void;
  /**
   * Called when the server reports the intent no longer exists (already
   * applied/rejected elsewhere, or a stale client-side stub). Distinct from
   * onRejected because nothing was actually rejected — the panel just needs
   * to stop displaying a dead intent instead of getting stuck on an error.
   */
  onDismiss?: (intent: StagedIntent) => void;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

interface TaskMovePayload {
  taskName?: string;
  sourceMilestoneName?: string;
  targetMilestoneName?: string;
  originalDisposition?: 'archive' | 'defer';
  isLaterMove?: boolean;
  cascadeSet?: string[];
}

function isTaskMovePayload(payload: unknown): payload is TaskMovePayload {
  return (
    !!payload && typeof payload === 'object' && 'targetMilestoneName' in payload
  );
}

function renderTaskMovePayload(payload: TaskMovePayload): ReactNode {
  return (
    <div className={styles.text} data-testid="staged-intent-move-payload">
      <p>
        Move <strong>{payload.taskName ?? 'task'}</strong> from{' '}
        <strong>{payload.sourceMilestoneName ?? '—'}</strong> to{' '}
        <strong>{payload.targetMilestoneName ?? '—'}</strong>
      </p>
      <p>
        Original task:{' '}
        {payload.originalDisposition === 'defer'
          ? 'Deferred (tombstone)'
          : 'Archived (clean)'}
      </p>
      {payload.isLaterMove && (
        <div data-testid="staged-intent-cascade-set">
          {payload.cascadeSet && payload.cascadeSet.length > 0 ? (
            <>
              <p>{payload.cascadeSet.length} dependent task(s) move with it:</p>
              <ul>
                {payload.cascadeSet.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No dependents move with it.</p>
          )}
        </div>
      )}
    </div>
  );
}

function renderPayload(kind: string, payload: unknown): ReactNode {
  if (payload == null) return null;
  if (kind === 'task.move' && isTaskMovePayload(payload)) {
    return renderTaskMovePayload(payload);
  }
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
export function StagedIntentPanel({
  intent,
  onApplied,
  onRejected,
  onDismiss,
}: Props) {
  const [inFlight, setInFlight] = useState<'apply' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleApply = async () => {
    setInFlight('apply');
    setError(null);
    try {
      const { result } = await stagedIntentsApi.apply(intent.id);
      onApplied?.(intent, result);
    } catch (err) {
      if (isNotFoundError(err)) {
        onDismiss?.(intent);
        return;
      }
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
      if (isNotFoundError(err)) {
        onDismiss?.(intent);
        return;
      }
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

      <div className={styles.body}>
        {renderPayload(intent.kind, intent.payload)}
      </div>

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
