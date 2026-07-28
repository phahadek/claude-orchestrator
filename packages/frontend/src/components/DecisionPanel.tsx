import { useState, useEffect, useCallback } from 'react';
import type {
  StagedIntent,
  StagedIntentRejectOutcome,
} from '../api/stagedIntents';
import { stagedIntentsApi } from '../api/stagedIntents';
import { subscribeStagedIntentChange } from '../hooks/stagedIntentBus';
import { StagedIntentPanel } from './StagedIntentPanel';
import { DecisionPickOnePanel } from './DecisionPickOnePanel';
import { triageVerdict, taskIdFor } from './triageVerdict';
import styles from './DecisionPanel.module.css';

interface Props {
  sessionId: string;
}

const TERMINAL_STATES = new Set([
  'committed',
  'rejected',
  'superseded',
  'withdrawn',
]);

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
  const [rejectDrafts, setRejectDrafts] = useState<
    Record<string, { outcome: StagedIntentRejectOutcome; reason: string }>
  >({});
  const [collapsed, setCollapsed] = useState(false);
  const [batchExcluded, setBatchExcluded] = useState<Record<string, boolean>>(
    {},
  );
  const [batchInFlight, setBatchInFlight] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchExceptions, setBatchExceptions] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setCollapsed(false);
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

  // approve-by-standard (planning/triage.ts): a group's recorded triage
  // verdict is a signal on that group, not a routing decision — every group
  // renders through the same per-group element below, whether or not its
  // Ready-flip carries a 'clean' verdict. A clean group is additionally
  // eligible for the "approve all clean" batch fast path (veto-able via
  // batchExcluded), which is only ever an action over these flagged groups —
  // never a container that replaces their individual disposition controls.
  const groupEntries = [...groups.entries()];
  const cleanGroupIds = groupEntries
    .filter(([, groupIntents]) => triageVerdict(groupIntents) === 'clean')
    .map(([groupId]) => groupId);
  const includedCleanGroupIds = cleanGroupIds.filter(
    (groupId) => !batchExcluded[groupId],
  );

  const toggleBatchExcluded = (groupId: string) => {
    setBatchExcluded((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const handleApproveAllClean = async () => {
    if (includedCleanGroupIds.length === 0) return;
    setBatchInFlight(true);
    setBatchError(null);
    try {
      const result = await stagedIntentsApi.commitBatch(
        includedCleanGroupIds,
        undefined,
      );
      const committed = new Set(result.committed);
      setIntents((prev) =>
        prev.filter((i) => !i.groupId || !committed.has(i.groupId)),
      );
      const nextExceptions: Record<string, string> = {};
      for (const exc of result.exceptions) {
        nextExceptions[exc.groupId] = exc.error;
      }
      setBatchExceptions(nextExceptions);
    } catch (err) {
      setBatchError(
        err instanceof Error ? err.message : 'Failed to approve clean set',
      );
    } finally {
      setBatchInFlight(false);
    }
  };

  const draftFor = (groupId: string) =>
    rejectDrafts[groupId] ?? { outcome: 'pushback' as const, reason: '' };

  const setDraft = (
    groupId: string,
    patch: Partial<{ outcome: StagedIntentRejectOutcome; reason: string }>,
  ) => {
    setRejectDrafts((prev) => ({
      ...prev,
      [groupId]: { ...draftFor(groupId), ...patch },
    }));
  };

  // The grooming outcome is one atomic approval unit: approve, pushback, or
  // decline the whole group in a single operator action — no per-item
  // approve/reject step. Both handlers below dispatch through the group-level
  // routes, which apply/reject every live member together (all-or-nothing on
  // approve — a member whose gate fails commits none of its siblings).
  const handleApproveGroup = async (groupId: string) => {
    setGroupInFlight(groupId);
    setGroupError(null);
    try {
      await stagedIntentsApi.approveGroup(groupId);
      setIntents((prev) => prev.filter((i) => i.groupId !== groupId));
    } catch (err) {
      setGroupError(
        err instanceof Error ? err.message : 'Failed to approve group',
      );
    } finally {
      setGroupInFlight(null);
    }
  };

  const handleRejectGroup = async (groupId: string) => {
    const draft = draftFor(groupId);
    const reason = draft.reason.trim();
    if (!reason) return;
    setGroupInFlight(groupId);
    setGroupError(null);
    try {
      await stagedIntentsApi.rejectGroup(groupId, {
        outcome: draft.outcome,
        reason,
      });
      setIntents((prev) => prev.filter((i) => i.groupId !== groupId));
    } catch (err) {
      setGroupError(
        err instanceof Error ? err.message : 'Failed to reject group',
      );
    } finally {
      setGroupInFlight(null);
    }
  };

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
          {groups.size > 0
            ? `${intents.length} intent${intents.length === 1 ? '' : 's'} across ${groups.size} group${groups.size === 1 ? '' : 's'}`
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

      {cleanGroupIds.length > 0 && (
        <div className={styles.group} data-testid="clean-batch-bar">
          <div className={styles.groupHeader}>
            <span>Clean verdict ({cleanGroupIds.length})</span>
          </div>
          <button
            type="button"
            className={styles.commitButton}
            disabled={includedCleanGroupIds.length === 0 || batchInFlight}
            onClick={() => void handleApproveAllClean()}
            data-testid="approve-all-clean"
          >
            {batchInFlight
              ? 'Approving…'
              : `✓ Approve all clean (${includedCleanGroupIds.length})`}
          </button>
          {batchError && <div className={styles.groupError}>{batchError}</div>}
        </div>
      )}

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
