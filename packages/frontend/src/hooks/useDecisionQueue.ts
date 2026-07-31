import { useState, useEffect, useCallback } from 'react';
import type {
  StagedIntent,
  StagedIntentRejectOutcome,
} from '../api/stagedIntents';
import {
  stagedIntentsApi,
  UNATTRIBUTED_MILESTONE_BUCKET,
} from '../api/stagedIntents';
import { subscribeStagedIntentChange } from './stagedIntentBus';
import { triageVerdict } from '../components/triageVerdict';

/** Which lens the queue fetches through — the only thing that differs between the session DecisionPanel and MilestoneDecisionInbox. */
export type DecisionQueueScope =
  | { type: 'session'; sessionId: string }
  | { type: 'milestone'; projectId: string; milestone: string };

const TERMINAL_STATES = new Set([
  'committed',
  'rejected',
  'superseded',
  'withdrawn',
]);

export interface DecisionQueueGroupDraft {
  outcome: StagedIntentRejectOutcome | null;
  reason: string;
}

/**
 * The shared partition/rank logic behind both operator decision surfaces:
 * fetch (scoped by session or milestone), live-update via the
 * staged_intent_changed WS bus, partition into groups/ungrouped, compute the
 * approve-by-standard clean-batch signal, and the group-level
 * approve/pushback/decline handlers. Session scope preserves the historical
 * DecisionPanel ordering (created_at ASC); milestone scope trusts the
 * backend's already-ranked ?milestone lens order and never re-sorts it.
 */
export function useDecisionQueue(scope: DecisionQueueScope) {
  const scopeKey =
    scope.type === 'session'
      ? `session:${scope.sessionId}`
      : `milestone:${scope.projectId}:${scope.milestone}`;

  const [intents, setIntents] = useState<StagedIntent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({});
  const [groupInFlight, setGroupInFlight] = useState<string | null>(null);
  const [rejectDrafts, setRejectDrafts] = useState<
    Record<string, DecisionQueueGroupDraft>
  >({});
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
    const fetch =
      scope.type === 'session'
        ? stagedIntentsApi.listBySession(scope.sessionId)
        : stagedIntentsApi.listByMilestone(scope.projectId, scope.milestone);
    fetch
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    return subscribeStagedIntentChange((intent) => {
      const matches =
        scope.type === 'session'
          ? intent.sessionId === scope.sessionId
          : (intent.milestone ?? UNATTRIBUTED_MILESTONE_BUCKET) ===
            scope.milestone;
      if (!matches) return;
      setIntents((prev) => {
        const withoutIntent = prev.filter((i) => i.id !== intent.id);
        if (intent.state && TERMINAL_STATES.has(intent.state)) {
          return withoutIntent;
        }
        if (scope.type === 'session') {
          return [...withoutIntent, intent].sort(
            (a, b) => a.createdAt - b.createdAt,
          );
        }
        // Milestone scope: the backend's convergence-ranking order isn't
        // recomputable client-side, so a live change is appended rather than
        // reordered. A refetch (e.g. on next mount) restores the true rank.
        return [...withoutIntent, intent];
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

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

  // A session that hasn't signaled its proposal set complete for this turn
  // may still stage more intents — the milestone inbox (a ranked
  // act-on-this-now queue) suppresses those cards entirely until the owning
  // session goes complete. The session-scoped DecisionPanel keeps them
  // visible (read-only) instead, so it does not filter here.
  const visibleIntents =
    scope.type === 'milestone'
      ? intents.filter((intent) => intent.sessionComplete !== false)
      : intents;

  const groups = new Map<string, StagedIntent[]>();
  const ungrouped: StagedIntent[] = [];
  for (const intent of visibleIntents) {
    if (intent.groupId) {
      const arr = groups.get(intent.groupId) ?? [];
      arr.push(intent);
      groups.set(intent.groupId, arr);
    } else {
      ungrouped.push(intent);
    }
  }

  const groupEntries = [...groups.entries()];
  const cleanGroupIds = groupEntries
    .filter(([, groupIntents]) => triageVerdict(groupIntents) === 'clean')
    .map(([groupId]) => groupId);
  const includedCleanGroupIds = cleanGroupIds.filter(
    (groupId) => !batchExcluded[groupId],
  );

  const toggleBatchExcluded = useCallback((groupId: string) => {
    setBatchExcluded((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  }, []);

  const handleApproveAllClean = useCallback(async () => {
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
  }, [includedCleanGroupIds]);

  const draftFor = useCallback(
    (groupId: string): DecisionQueueGroupDraft =>
      rejectDrafts[groupId] ?? { outcome: null, reason: '' },
    [rejectDrafts],
  );

  const setDraft = useCallback(
    (groupId: string, patch: Partial<DecisionQueueGroupDraft>) => {
      setRejectDrafts((prev) => ({
        ...prev,
        [groupId]: {
          ...(prev[groupId] ?? { outcome: null, reason: '' }),
          ...patch,
        },
      }));
    },
    [],
  );

  const clearGroupError = useCallback((groupId: string) => {
    setGroupErrors((prev) => {
      if (!(groupId in prev)) return prev;
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
  }, []);

  const handleApproveGroup = useCallback(
    async (groupId: string) => {
      setGroupInFlight(groupId);
      clearGroupError(groupId);
      try {
        await stagedIntentsApi.approveGroup(groupId);
        setIntents((prev) => prev.filter((i) => i.groupId !== groupId));
      } catch (err) {
        setGroupErrors((prev) => ({
          ...prev,
          [groupId]:
            err instanceof Error ? err.message : 'Failed to approve group',
        }));
      } finally {
        setGroupInFlight(null);
      }
    },
    [clearGroupError],
  );

  const handleRejectGroup = useCallback(
    async (groupId: string) => {
      const draft = draftFor(groupId);
      const reason = draft.reason.trim();
      if (!reason || !draft.outcome) return;
      setGroupInFlight(groupId);
      clearGroupError(groupId);
      try {
        await stagedIntentsApi.rejectGroup(groupId, {
          outcome: draft.outcome,
          reason,
        });
        setIntents((prev) => prev.filter((i) => i.groupId !== groupId));
      } catch (err) {
        setGroupErrors((prev) => ({
          ...prev,
          [groupId]:
            err instanceof Error ? err.message : 'Failed to reject group',
        }));
      } finally {
        setGroupInFlight(null);
      }
    },
    [draftFor, clearGroupError],
  );

  // Whole-panel signal for the session-scoped DecisionPanel: a session's
  // completeness is uniform across its own intents (it is a property of the
  // session, not the individual intent), so any one incomplete intent means
  // the session is still filing.
  const sessionIncomplete = visibleIntents.some(
    (intent) => intent.sessionComplete === false,
  );

  return {
    intents: visibleIntents,
    loaded,
    groups,
    groupEntries,
    ungrouped,
    sessionIncomplete,
    cleanGroupIds,
    includedCleanGroupIds,
    batchExcluded,
    toggleBatchExcluded,
    batchInFlight,
    batchError,
    batchExceptions,
    handleApproveAllClean,
    groupInFlight,
    groupErrors,
    draftFor,
    setDraft,
    handleApproveGroup,
    handleRejectGroup,
    upsert,
    remove,
  };
}
