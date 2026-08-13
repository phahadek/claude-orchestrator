import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/projects';
import type { LaneHealthRollup } from '@claude-orchestrator/backend/src/db/queries';

const POLL_INTERVAL_MS = 60000;

export interface UseLaneHealthRollupParams {
  projectId: string | null;
  /** Bump to trigger a re-fetch in response to a push event, in addition to the poll backstop. */
  invalidationKey?: unknown;
}

export interface UseLaneHealthRollupResult {
  rollup: LaneHealthRollup | null;
  loading: boolean;
  error: string | null;
}

/**
 * REST-polls the project-scoped lane-health rollup (pass rate, timeout
 * rate, queue-wait vs execution-time distributions) — mirrors
 * useMilestoneAttention's poll-plus-invalidation-key shape. Fleet-scoped
 * (by project, not milestone) since test_request_runs carries no milestone
 * column.
 */
export function useLaneHealthRollup({
  projectId,
  invalidationKey,
}: UseLaneHealthRollupParams): UseLaneHealthRollupResult {
  const [rollup, setRollup] = useState<LaneHealthRollup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchRollup = useCallback(() => {
    if (!projectId) {
      setRollup(null);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    apiRequest<LaneHealthRollup>(
      `/api/milestones/${encodeURIComponent(projectId)}/lane-health`,
    )
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setRollup(data);
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
  }, [projectId]);

  useEffect(() => {
    fetchRollup();
  }, [fetchRollup, invalidationKey]);

  useEffect(() => {
    const interval = setInterval(fetchRollup, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchRollup]);

  return { rollup, loading, error };
}
