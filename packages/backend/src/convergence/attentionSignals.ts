import {
  listStagedIntentsByMilestone,
  listConvergenceSnapshotHistory,
  listTaskPauseReasons,
  isSessionComplete,
} from '../db/queries';
import { parsePauseReason, type PauseReasonStruct } from '../db/pauseReason';
import { resolveMilestoneForTaskId } from '../projects/milestoneResolver';
import { runtimeSettings } from '../config';
import type { ConvergenceSnapshotRow, StagedIntentRow } from '../db/types';
import type { SessionManager } from '../session/SessionManager';

/**
 * The Milestone view's two-tier operator-attention read-surface (Product
 * Design Doc § UI layout § Milestone view). TIER-1 is the nav badge's
 * `pendingCount`; TIER-2 is `tier2`, one entry per condition that's genuine
 * trouble rather than routine pending — aging, blocked/stalled, or flat
 * convergence. Each entry's `key` is stable for the same underlying
 * condition across polls, so the frontend can dedup re-fires the same way
 * useNotifications.ts already dedups WS-driven notifications.
 */

type AttentionTier2Type = 'aging' | 'blocked' | 'flat';

export interface AttentionTier2Signal {
  key: string;
  type: AttentionTier2Type;
  message: string;
}

export interface MilestoneAttentionSignals {
  pendingCount: number;
  tier2: AttentionTier2Signal[];
}

/**
 * The single definition of "is this staged intent's owning session done
 * turning" for display purposes (see isSessionComplete in db/queries.ts —
 * true once the session has staged something since its last stop and its
 * turn has ended). Turn-in-flight is read off the live AgentSession
 * instance when one exists in this process; absent that, the session is
 * presumed not mid-turn (no live handle to prove otherwise), matching
 * rowToApi's existing fallback. Both the milestone nav badge
 * (computeMilestoneAttentionSignals below) and the decision-inbox's
 * per-intent `sessionComplete` field (routes/stagedIntents.ts rowToApi)
 * derive from this one function so they can't independently drift on what
 * "complete" means.
 */
export function resolveSessionCompleteForDisplay(
  sessionId: string,
  sessionManager: SessionManager | undefined,
): boolean {
  const turnInFlight =
    sessionManager?.getLiveSession?.(sessionId)?.hasActiveTurn() ?? false;
  return isSessionComplete(sessionId, turnInFlight);
}

/**
 * Whether a staged intent belongs on the milestone-scoped actionable
 * surfaces (nav badge count, decision inbox): true for human-staged intents
 * (no owning session) and for intents whose owning session has gone
 * complete; false while the owning session's turn is still in flight.
 */
export function isMilestoneActionable(
  row: Pick<StagedIntentRow, 'session_id'>,
  sessionManager: SessionManager | undefined,
): boolean {
  if (!row.session_id) return true;
  return resolveSessionCompleteForDisplay(row.session_id, sessionManager);
}

function agingThresholdMs(): number {
  return runtimeSettings.milestone_attention_aging_threshold_seconds * 1000;
}

function flatWindowMs(): number {
  return (
    runtimeSettings.milestone_attention_flat_convergence_window_seconds * 1000
  );
}

/**
 * Pure: which pending staged decisions have sat longer than `thresholdMs`.
 * gate.verify rows are excluded — they're session-less mirrors of a gate
 * item's own verify cadence, not staged planning intents left waiting on an
 * operator, so the 24h planning-aging threshold doesn't apply to them.
 */
export function detectAgingSignals(
  pending: { id: string; created_at: number; kind: string }[],
  now: number,
  thresholdMs: number,
): AttentionTier2Signal[] {
  return pending
    .filter((row) => row.kind !== 'gate.verify')
    .filter((row) => now - row.created_at > thresholdMs)
    .map((row) => {
      const ageHours = Math.round((now - row.created_at) / 3_600_000);
      return {
        key: `aging:${row.id}`,
        type: 'aging' as const,
        message: `Decision pending ${ageHours}h — past the ${Math.round(thresholdMs / 3_600_000)}h aging threshold`,
      };
    });
}

/**
 * Pure: `rows` must already be filtered to task ids belonging to the target
 * milestone (task_pause_reasons has no milestone column, so that
 * resolution happens in the caller via resolveMilestoneForTaskId).
 */
export function detectBlockedSignals(
  rows: { task_id: string; parsed: PauseReasonStruct }[],
): AttentionTier2Signal[] {
  return rows
    .filter(
      (row) =>
        row.parsed.severity === 'needs_attention' ||
        row.parsed.severity === 'terminal',
    )
    .map((row) => ({
      key: `blocked:${row.task_id}:${row.parsed.reason}`,
      type: 'blocked' as const,
      message: `${row.task_id} blocked — ${row.parsed.reason}${row.parsed.detail ? `: ${row.parsed.detail}` : ''}`,
    }));
}

/** Pure: no burndown progress (distance_to_green) over the trailing `windowMs`. */
export function detectFlatSignal(
  history: ConvergenceSnapshotRow[],
  now: number,
  windowMs: number,
  key: string,
): AttentionTier2Signal[] {
  if (history.length === 0) return [];
  const latest = history[history.length - 1];
  if (latest.status === 'green') return [];

  const windowStart = now - windowMs;
  if (new Date(history[0].ts).getTime() > windowStart) {
    // Not enough retained history yet to prove staleness over the full window.
    return [];
  }

  // Baseline: the most recent snapshot at or before the window start.
  let baseline = history[0];
  for (const snapshot of history) {
    if (new Date(snapshot.ts).getTime() > windowStart) break;
    baseline = snapshot;
  }

  if (latest.distance_to_green >= baseline.distance_to_green) {
    return [
      {
        key: `flat:${key}`,
        type: 'flat',
        message: `Convergence flat — distanceToGreen unchanged at ${latest.distance_to_green} over the last ${Math.round(windowMs / 3_600_000)}h`,
      },
    ];
  }
  return [];
}

export function computeMilestoneAttentionSignals(
  projectId: string,
  milestone: string,
  sessionManager: SessionManager | undefined,
  now: number = Date.now(),
): MilestoneAttentionSignals {
  // Only intents the decision inbox would actually render count toward the
  // badge — an intent whose owning session is still mid-turn is excluded
  // from both the count and the tier-2 signals derived from it (see
  // isMilestoneActionable above).
  const pending = listStagedIntentsByMilestone(projectId, milestone).filter(
    (row) => isMilestoneActionable(row, sessionManager),
  );

  const blockedRows = listTaskPauseReasons()
    .filter(
      (row) => resolveMilestoneForTaskId(projectId, row.task_id) === milestone,
    )
    .map((row) => ({
      task_id: row.task_id,
      parsed: parsePauseReason(row.pause_reason),
    }))
    .filter(
      (row): row is { task_id: string; parsed: PauseReasonStruct } =>
        row.parsed !== null,
    );

  const history = listConvergenceSnapshotHistory(projectId, milestone);

  return {
    pendingCount: pending.length,
    tier2: [
      ...detectAgingSignals(pending, now, agingThresholdMs()),
      ...detectBlockedSignals(blockedRows),
      ...detectFlatSignal(
        history,
        now,
        flatWindowMs(),
        `${projectId}:${milestone}`,
      ),
    ],
  };
}
