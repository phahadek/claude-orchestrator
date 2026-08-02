import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';
import type { ConvergenceSnapshotRow } from '@claude-orchestrator/backend/src/db/types';

/** Recent-enough for the sparkline without dragging in a milestone's entire (never-pruned) history. */
const DEFAULT_LIMIT = 60;

export interface UseConvergenceHistoryResult {
  history: ConvergenceSnapshotRow[];
  loading: boolean;
  error: string | null;
}

/**
 * Bounded fetch of the convergence_snapshot series for the milestone's
 * sparkline — always passes `limit` so the request stays a bounded window,
 * never the route's unbounded default.
 */
export function useConvergenceHistory(
  projectId: string | null,
  milestoneId: string | null,
  limit: number = DEFAULT_LIMIT,
): UseConvergenceHistoryResult {
  const [history, setHistory] = useState<ConvergenceSnapshotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !milestoneId) {
      setHistory([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiRequest<ConvergenceSnapshotRow[]>(
      `/api/milestones/${encodeURIComponent(projectId)}/${encodeURIComponent(milestoneId)}/convergence/history?limit=${limit}`,
    )
      .then((data) => {
        if (cancelled) return;
        setHistory(data);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setHistory([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, milestoneId, limit]);

  return { history, loading, error };
}
