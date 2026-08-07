import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';
import type { ConvergenceSnapshotRow } from '@claude-orchestrator/backend/src/db/types';

export interface UseConvergenceHistoryResult {
  history: ConvergenceSnapshotRow[];
  loading: boolean;
  error: string | null;
}

/**
 * Fetch of the convergence_snapshot series for the milestone's sparkline.
 * No `limit`/`since` params are sent — the route defaults the window to the
 * milestone's own lifetime (created_at through wrapped_at, or now), which is
 * a more meaningful bound than an arbitrary fixed row count.
 */
export function useConvergenceHistory(
  projectId: string | null,
  milestoneId: string | null,
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
      `/api/milestones/${encodeURIComponent(projectId)}/${encodeURIComponent(milestoneId)}/convergence/history`,
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
  }, [projectId, milestoneId]);

  return { history, loading, error };
}
