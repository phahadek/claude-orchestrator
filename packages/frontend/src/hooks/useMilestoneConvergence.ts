import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/projects';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';

const POLL_INTERVAL_MS = 60000;

export interface UseMilestoneConvergenceParams {
  projectId: string | null;
  milestoneId: string | null;
  /**
   * Bump this (e.g. a composite of the last task/staged-intent/gate-item
   * event) to trigger a re-fetch in response to a push event, in addition to
   * the slow poll backstop.
   */
  invalidationKey?: unknown;
}

export interface UseMilestoneConvergenceResult {
  convergence: MilestoneConvergence | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * REST-fetches the milestone convergence read-surface and re-fetches on
 * caller-supplied invalidation events plus a slow poll backstop. No new WS
 * message type — this composes with the existing push events already
 * surfaced by useSessionStore.
 */
export function useMilestoneConvergence({
  projectId,
  milestoneId,
  invalidationKey,
}: UseMilestoneConvergenceParams): UseMilestoneConvergenceResult {
  const [convergence, setConvergence] = useState<MilestoneConvergence | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchConvergence = useCallback(() => {
    if (!projectId || !milestoneId) {
      setConvergence(null);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    apiRequest<MilestoneConvergence>(
      `/api/milestones/${encodeURIComponent(projectId)}/${encodeURIComponent(milestoneId)}/convergence`,
    )
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setConvergence(data);
        setError(null);
      })
      .catch((err) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);
      });
  }, [projectId, milestoneId]);

  useEffect(() => {
    fetchConvergence();
  }, [fetchConvergence, invalidationKey]);

  useEffect(() => {
    const interval = setInterval(fetchConvergence, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchConvergence]);

  return { convergence, loading, error, refetch: fetchConvergence };
}
