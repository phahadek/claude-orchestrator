import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';

type AttentionTier2Type =
  | 'aging'
  | 'blocked'
  | 'flat'
  | 'base_break'
  | 'flow_health_regression';

interface AttentionTier2Signal {
  key: string;
  type: AttentionTier2Type;
  message: string;
}

interface FlowHealthSnapshotRow {
  id: string;
  ts: string;
  window_start: number;
  window_end: number;
  sample_count: number;
  p50_wall_clock_ms: number | null;
  status: 'ok' | 'regressed';
  excluded_artifact_count: number;
}

export interface FlowHealthResponse {
  history: FlowHealthSnapshotRow[];
  signal: AttentionTier2Signal | null;
}

const POLL_INTERVAL_MS = 60000;

/**
 * REST-polls the fleet-wide flow-health snapshot trend + edge-triggered
 * regression signal (GET /api/milestones/:project/flow-health). The
 * endpoint isn't actually project-scoped — flow_health_regression_snapshot
 * carries no project column — so any active project id works; this mirrors
 * useMilestoneAttention's poll shape for the nav badge (1 while the signal
 * is firing, 0 once it clears).
 */
export function useFlowHealthAttention(projectId: string | null): {
  data: FlowHealthResponse | null;
  attentionCount: number;
} {
  const [data, setData] = useState<FlowHealthResponse | null>(null);

  const fetchFlowHealth = useCallback(() => {
    if (!projectId) {
      setData(null);
      return;
    }
    apiRequest<FlowHealthResponse>(
      `/api/milestones/${encodeURIComponent(projectId)}/flow-health`,
    )
      .then(setData)
      .catch(() => {
        /* poll backstop — ignore transient failures */
      });
  }, [projectId]);

  useEffect(() => {
    fetchFlowHealth();
  }, [fetchFlowHealth]);

  useEffect(() => {
    const interval = setInterval(fetchFlowHealth, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchFlowHealth]);

  return { data, attentionCount: data?.signal ? 1 : 0 };
}
