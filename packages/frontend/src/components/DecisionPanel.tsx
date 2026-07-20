import { useState, useEffect, useCallback } from 'react';
import type { StagedIntent } from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import { subscribeStagedIntentChange } from '../hooks/stagedIntentBus';
import { StagedIntentPanel } from './StagedIntentPanel';
import styles from './DecisionPanel.module.css';

interface Props {
  sessionId: string;
}

const TERMINAL_STATES = new Set(['committed', 'rejected', 'superseded']);

/**
 * The operator decision surface for a live session: staged/approved
 * proposals correlated to this session_id, grouped by groupId, rendered
 * beside the transcript. REST (stagedIntentsApi) is the fetch/apply source
 * of truth; the staged_intent_changed WS message (via stagedIntentBus) only
 * triggers an in-place update so the panel never needs a manual refetch.
 */
export function DecisionPanel({ sessionId }: Props) {
  const [intents, setIntents] = useState<StagedIntent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupInFlight, setGroupInFlight] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    stagedIntentsApi
      .listBySession(sessionId)
      .then((fetched) => {
        if (!cancelled) {
          setIntents(fetched);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    return subscribeStagedIntentChange((intent) => {
      if (intent.sessionId !== sessionId) return;
      setIntents((prev) => {
        const withoutIntent = prev.filter((i) => i.id !== intent.id);
        if (intent.state && TERMINAL_STATES.has(intent.state)) {
          return withoutIntent;
        }
        return [...withoutIntent, intent].sort(
          (a, b) => a.createdAt - b.createdAt,
        );
      });
    });
  }, [sessionId]);

  const upsert = useCallback((intent: StagedIntent) => {
    setIntents((prev) => {
      const idx = prev.findIndex((i) => i.id === intent.id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = intent;
      return next;
    });
  }, []);

  const remove = useCallback((intent: StagedIntent) => {
    setIntents((prev) => prev.filter((i) => i.id !== intent.id));
  }, []);

  if (!loaded || intents.length === 0) return null;

  const groups = new Map<string, StagedIntent[]>();
  const ungrouped: StagedIntent[] = [];
  for (const intent of intents) {
    if (intent.groupId) {
      const arr = groups.get(intent.groupId) ?? [];
      arr.push(intent);
      groups.set(intent.groupId, arr);
    } else {
      ungrouped.push(intent);
    }
  }

  const handleCommitGroup = async (groupId: string) => {
    setGroupInFlight(groupId);
    setGroupError(null);
    try {
      await stagedIntentsApi.commitGroup(groupId);
      setIntents((prev) => prev.filter((i) => i.groupId !== groupId));
    } catch (err) {
      setGroupError(
        err instanceof Error ? err.message : 'Failed to commit group',
      );
    } finally {
      setGroupInFlight(null);
    }
  };

  return (
    <div className={styles.panel} data-testid="decision-panel">
      <div className={styles.heading}>Proposals ({intents.length})</div>

      {[...groups.entries()].map(([groupId, groupIntents]) => {
        const allApproved = groupIntents.every((i) => i.state === 'approved');
        return (
          <div key={groupId} className={styles.group}>
            <div className={styles.groupHeader}>
              <span>Group {groupId}</span>
              <button
                type="button"
                className={styles.commitButton}
                disabled={!allApproved || groupInFlight === groupId}
                onClick={() => void handleCommitGroup(groupId)}
              >
                {groupInFlight === groupId
                  ? 'Committing…'
                  : 'Commit group'}
              </button>
            </div>
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
              />
            ))}
          </div>
        );
      })}

      {ungrouped.map((intent) => (
        <StagedIntentPanel
          key={intent.id}
          intent={intent}
          onApplied={remove}
          onRejected={remove}
          onDismiss={remove}
          onApproved={upsert}
        />
      ))}
    </div>
  );
}
