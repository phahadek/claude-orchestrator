import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/projects';

export type AttentionTier2Type = 'aging' | 'blocked' | 'flat';

export interface AttentionTier2Signal {
  key: string;
  type: AttentionTier2Type;
  message: string;
}

export interface AttentionTier2Event extends AttentionTier2Signal {
  receivedAt: number;
}

interface MilestoneAttentionResponse {
  pendingCount: number;
  tier2: AttentionTier2Signal[];
}

const POLL_INTERVAL_MS = 60000;

export interface UseMilestoneAttentionParams {
  projectId: string | null;
  milestoneId: string | null;
  /** Bump to trigger a re-fetch in response to a push event, in addition to the poll backstop. */
  invalidationKey?: unknown;
}

export interface UseMilestoneAttentionResult {
  /** TIER-1: the nav badge's pending-decision count for this milestone. */
  pendingCount: number;
  /**
   * TIER-2: the newly-fired signals from the most recent poll, or null when
   * that poll surfaced nothing new. Deduped against a ref of already-fired
   * signal keys — the same condition (same key) never fires twice in a row;
   * a key drops out of the ref once its condition clears, so it can fire
   * again if the condition recurs later.
   */
  lastTier2Batch: { events: AttentionTier2Event[]; receivedAt: number } | null;
}

/**
 * REST-polls the milestone attention read-surface (nav badge count + tier-2
 * aging/blocked/flat signals). No new WS message type — mirrors
 * useMilestoneConvergence's poll-plus-invalidation-key shape.
 */
export function useMilestoneAttention({
  projectId,
  milestoneId,
  invalidationKey,
}: UseMilestoneAttentionParams): UseMilestoneAttentionResult {
  const [pendingCount, setPendingCount] = useState(0);
  const [lastTier2Batch, setLastTier2Batch] = useState<
    UseMilestoneAttentionResult['lastTier2Batch']
  >(null);
  const firedKeysRef = useRef<Set<string>>(new Set());
  const requestIdRef = useRef(0);

  const fetchAttention = useCallback(() => {
    if (!projectId || !milestoneId) {
      setPendingCount(0);
      firedKeysRef.current = new Set();
      return;
    }
    const requestId = ++requestIdRef.current;
    apiRequest<MilestoneAttentionResponse>(
      `/api/milestones/${encodeURIComponent(projectId)}/${encodeURIComponent(milestoneId)}/attention`,
    )
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setPendingCount(data.pendingCount);

        const currentKeys = new Set(data.tier2.map((s) => s.key));
        // A condition that cleared can re-fire if it recurs later.
        for (const key of firedKeysRef.current) {
          if (!currentKeys.has(key)) firedKeysRef.current.delete(key);
        }

        const fresh = data.tier2.filter((s) => !firedKeysRef.current.has(s.key));
        if (fresh.length === 0) return;
        for (const signal of fresh) firedKeysRef.current.add(signal.key);

        const receivedAt = Date.now();
        setLastTier2Batch({
          events: fresh.map((signal) => ({ ...signal, receivedAt })),
          receivedAt,
        });
      })
      .catch(() => {
        /* poll backstop — ignore transient failures */
      });
  }, [projectId, milestoneId]);

  useEffect(() => {
    fetchAttention();
  }, [fetchAttention, invalidationKey]);

  useEffect(() => {
    const interval = setInterval(fetchAttention, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchAttention]);

  return { pendingCount, lastTier2Batch };
}
