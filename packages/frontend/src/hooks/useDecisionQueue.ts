import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { defaultGroupRejectOutcome } from '../components/groupRejectOutcome';

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

/**
 * Client-side mirror of decisionRanking.ts's classifyKindDirection +
 * hasNeedsAttentionBoost, minus the blocking-axis criterion (that needs the
 * milestone's convergence read-surface, which isn't available client-side).
 * Used only to place a live-arriving intent within the right tier of the
 * already-ranked list — never to re-rank the whole list, since a mismatch
 * on the blocking axis would put it in the wrong place relative to items
 * that differ on it.
 */
const PROGRESS_KINDS = new Set(['task.setStatus', 'review.dispute']);
const STRUCTURAL_KINDS = new Set([
  'task.updateBody',
  'task.setDependsOn',
  'task.patchBodySection',
  'task.setProperties',
  'task.setType',
  'task.move',
  'arch.updateUnit',
  'arch.supersedeUnit',
  'journal.setState',
]);
const SCOPE_ADD_KINDS = new Set([
  'task.create',
  'arch.createUnit',
  'gate.accrete',
  'seed.stage',
]);

function kindDirectionRank(kind: string): number {
  if (PROGRESS_KINDS.has(kind)) return 3;
  if (STRUCTURAL_KINDS.has(kind)) return 2;
  if (SCOPE_ADD_KINDS.has(kind)) return 1;
  return 0;
}

function hasNeedsAttentionBoost(intent: StagedIntent): boolean {
  if (intent.annotation && 'blocked' in intent.annotation && intent.annotation.blocked) {
    return true;
  }
  if (intent.advisory?.status === 'flagged') return true;
  if (intent.kind === 'decision.pickOne' && !intent.answer) return true;
  return false;
}

/** [kindDirection, needsAttention] — the portion of the backend rank key computable client-side. */
function partialRankTier(intent: StagedIntent): [number, number] {
  return [kindDirectionRank(intent.kind), hasNeedsAttentionBoost(intent) ? 1 : 0];
}

/**
 * Inserts a live-arriving intent at the top of its rank tier within an
 * already-ranked list, rather than at the array's end — the index of the
 * first existing item whose tier is no higher than the arrival's tier (i.e.
 * right before that tier's block begins).
 */
function insertAtTopOfTier(
  list: StagedIntent[],
  intent: StagedIntent,
): StagedIntent[] {
  const tier = partialRankTier(intent);
  const idx = list.findIndex((existing) => {
    const existingTier = partialRankTier(existing);
    return (
      existingTier[0] < tier[0] ||
      (existingTier[0] === tier[0] && existingTier[1] <= tier[1])
    );
  });
  if (idx === -1) return [...list, intent];
  const next = [...list];
  next.splice(idx, 0, intent);
  return next;
}

export interface DecisionQueueGroupDraft {
  outcome: StagedIntentRejectOutcome | null;
  reason: string;
}

export interface DecisionQueueOptions {
  /** Called with the ids of every staged intent a disposition just removed — a single onAnswered/onApplied/onRejected, a group approve/reject, or the clean-batch approve-all. Lets a caller (e.g. the milestone stack) re-select whatever is now topmost when the removed set included the current selection. */
  onRemoved?: (ids: string[]) => void;
}

/**
 * The shared partition/rank logic behind both operator decision surfaces:
 * fetch (scoped by session or milestone), live-update via the
 * staged_intent_changed WS bus, partition into groups/ungrouped, compute the
 * approve-by-standard clean-batch signal, and the group-level
 * approve/pushback/decline handlers. Session scope orders by created_at
 * DESC (newest first); milestone scope trusts the backend's already-ranked
 * ?milestone lens order and only adjusts it locally to place a live arrival
 * at the top of its rank tier (see insertAtTopOfTier).
 */
export function useDecisionQueue(
  scope: DecisionQueueScope,
  options?: DecisionQueueOptions,
) {
  const onRemovedRef = useRef(options?.onRemoved);
  onRemovedRef.current = options?.onRemoved;

  const scopeKey =
    scope.type === 'session'
      ? `session:${scope.sessionId}`
      : `milestone:${scope.projectId}:${scope.milestone}`;

  const [intents, setIntents] = useState<StagedIntent[]>([]);
  // Mirrors `intents` for read access from async handlers below (e.g. after
  // an `await`) without calling setState during another component's render
  // — computing removed ids inside a setIntents updater would do exactly
  // that, since updater functions run during React's render phase.
  const intentsRef = useRef(intents);
  intentsRef.current = intents;
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
            (a, b) => b.createdAt - a.createdAt,
          );
        }
        // Milestone scope: the backend's full convergence-ranking order
        // isn't recomputable client-side (the blocking axis needs the
        // milestone's convergence read-surface), so a live arrival is
        // placed at the top of its rank tier — computed from the kind/
        // needs-attention criteria alone — rather than appended at the
        // array's end. A refetch (e.g. on next mount) restores the exact
        // rank, including the blocking axis.
        return insertAtTopOfTier(withoutIntent, intent);
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
    onRemovedRef.current?.([intent.id]);
  }, []);

  // A session that hasn't signaled its proposal set complete for this turn
  // may still stage more intents — the milestone inbox (a ranked
  // act-on-this-now queue) suppresses those cards entirely until the owning
  // session goes complete. sessionComplete is fail-toward-incomplete (see
  // isSessionComplete): `null` means "no owning session" and is always
  // shown, `true` means the owning session has gone complete, and both
  // `false` and missing/undefined suppress the card. The session-scoped
  // DecisionPanel keeps them visible (read-only) instead, so it does not
  // filter here.
  const visibleIntents =
    scope.type === 'milestone'
      ? intents.filter(
          (intent) =>
            intent.sessionComplete === true || intent.sessionComplete === null,
        )
      : intents;

  const { groups, ungrouped } = useMemo(() => {
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
    return { groups, ungrouped };
  }, [visibleIntents]);

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
      const removedIds = intentsRef.current
        .filter((i) => i.groupId && committed.has(i.groupId))
        .map((i) => i.id);
      setIntents((prev) =>
        prev.filter((i) => !i.groupId || !committed.has(i.groupId)),
      );
      if (removedIds.length > 0) onRemovedRef.current?.(removedIds);
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

  const defaultDraftFor = useCallback(
    (groupId: string): DecisionQueueGroupDraft => ({
      outcome: defaultGroupRejectOutcome(groups.get(groupId) ?? []),
      reason: '',
    }),
    [groups],
  );

  const draftFor = useCallback(
    (groupId: string): DecisionQueueGroupDraft =>
      rejectDrafts[groupId] ?? defaultDraftFor(groupId),
    [rejectDrafts, defaultDraftFor],
  );

  const setDraft = useCallback(
    (groupId: string, patch: Partial<DecisionQueueGroupDraft>) => {
      setRejectDrafts((prev) => ({
        ...prev,
        [groupId]: {
          ...(prev[groupId] ?? defaultDraftFor(groupId)),
          ...patch,
        },
      }));
    },
    [defaultDraftFor],
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
        const removedIds = intentsRef.current
          .filter((i) => i.groupId === groupId)
          .map((i) => i.id);
        setIntents((prev) => prev.filter((i) => i.groupId !== groupId));
        if (removedIds.length > 0) onRemovedRef.current?.(removedIds);
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
      if (!reason) return;
      const outcome =
        draft.outcome ?? defaultGroupRejectOutcome(groups.get(groupId) ?? []);
      setGroupInFlight(groupId);
      clearGroupError(groupId);
      try {
        await stagedIntentsApi.rejectGroup(groupId, {
          outcome,
          reason,
        });
        const removedIds = intentsRef.current
          .filter((i) => i.groupId === groupId)
          .map((i) => i.id);
        setIntents((prev) => prev.filter((i) => i.groupId !== groupId));
        if (removedIds.length > 0) onRemovedRef.current?.(removedIds);
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
    [draftFor, clearGroupError, groups],
  );

  const handleRecoverGroup = useCallback(
    async (groupId: string) => {
      setGroupInFlight(groupId);
      clearGroupError(groupId);
      try {
        const { recovered } = await stagedIntentsApi.recoverGroup(groupId);
        setIntents((prev) => {
          const recoveredIds = new Set(recovered.map((i) => i.id));
          const withoutRecovered = prev.filter((i) => !recoveredIds.has(i.id));
          return [...withoutRecovered, ...recovered];
        });
      } catch (err) {
        setGroupErrors((prev) => ({
          ...prev,
          [groupId]:
            err instanceof Error ? err.message : 'Failed to recover group',
        }));
      } finally {
        setGroupInFlight(null);
      }
    },
    [clearGroupError],
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
    handleRecoverGroup,
    upsert,
    remove,
  };
}
