import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/projects';
import { subscribeToTestRequestRunStatus } from './testRequestRunStatusBus';

const POLL_INTERVAL_MS = 15000;

export const DEFAULT_HEALTH_WINDOW_DAYS = 30;
export const MAX_HEALTH_WINDOW_DAYS = 90;

interface TestRunBandCounts {
  executed_passed: number;
  executed_failed: number;
  executed_failed_all_excused: number;
  oom_or_timeout: number;
  no_verdict: number;
  nothing_exercised: number;
  reused: number;
}

export interface PassRateTrendDay {
  day: string;
  bands: TestRunBandCounts;
  failedExcusalNotRetained: number;
  excusedBySource: Record<string, number>;
  passRate: number | null;
}

interface PassRateTrend {
  project: string;
  windowDays: number;
  runKinds: Record<string, PassRateTrendDay[]>;
}

export interface QueueWaitDay {
  day: string;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  sampleCount: number;
}

interface QueueWaitDistribution {
  project: string;
  windowDays: number;
  days: QueueWaitDay[];
}

export interface BaselineTestSummary {
  testId: string;
  name: string;
  medianDurationMs: number;
  lastDurationMs: number;
  sampleCount: number;
}

interface SlowAndRegressed {
  slowest: BaselineTestSummary[];
  regressed: BaselineTestSummary[];
}

export interface LaneOccupancyBucket {
  t: number;
  peakRunning: number;
  peakQueued: number;
}

export interface LaneOccupancyLane {
  lane: 'full' | 'targeted';
  capacity: number;
  buckets: LaneOccupancyBucket[];
}

interface LaneOccupancy {
  project: string;
  windowDays: number;
  bucketMs: number;
  lanes: LaneOccupancyLane[];
}

export interface UseProjectTestHealthResult {
  laneOccupancy: LaneOccupancy | null;
  passRate: PassRateTrend | null;
  queueWait: QueueWaitDistribution | null;
  slowAndRegressed: SlowAndRegressed | null;
  loading: boolean;
  error: string | null;
}

/**
 * Polls the three test-analytics Health endpoints and refetches on any
 * test_request_run_status bus event for the project (useProjectTestRuns shape).
 */
export function useProjectTestHealth(
  projectId: string | null,
  windowDays: number = DEFAULT_HEALTH_WINDOW_DAYS,
): UseProjectTestHealthResult {
  const [passRate, setPassRate] = useState<PassRateTrend | null>(null);
  const [queueWait, setQueueWait] = useState<QueueWaitDistribution | null>(
    null,
  );
  const [slowAndRegressed, setSlowAndRegressed] =
    useState<SlowAndRegressed | null>(null);
  const [laneOccupancy, setLaneOccupancy] = useState<LaneOccupancy | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidationKey, setInvalidationKey] = useState(0);
  const requestIdRef = useRef(0);

  const fetchHealth = useCallback(() => {
    if (!projectId) {
      setPassRate(null);
      setQueueWait(null);
      setSlowAndRegressed(null);
      setLaneOccupancy(null);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    const base = `/api/milestones/${encodeURIComponent(projectId)}/test-analytics`;
    const window = Math.min(MAX_HEALTH_WINDOW_DAYS, Math.max(1, windowDays));
    Promise.all([
      apiRequest<PassRateTrend>(`${base}/pass-rate-trend?window=${window}`),
      apiRequest<QueueWaitDistribution>(`${base}/queue-wait?window=${window}`),
      apiRequest<SlowAndRegressed>(`${base}/slow-and-regressed`),
      apiRequest<LaneOccupancy>(`${base}/lane-occupancy?window=${window}`),
    ])
      .then(([trend, wait, slow, occupancy]) => {
        if (requestIdRef.current !== requestId) return;
        setLaneOccupancy(occupancy);
        setPassRate(trend);
        setQueueWait(wait);
        setSlowAndRegressed(slow);
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
  }, [projectId, windowDays]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth, invalidationKey]);

  useEffect(() => {
    const interval = setInterval(fetchHealth, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  useEffect(() => {
    if (!projectId) return;
    return subscribeToTestRequestRunStatus((payload) => {
      if (payload.projectId !== projectId) return;
      setInvalidationKey((key) => key + 1);
    });
  }, [projectId]);

  return {
    laneOccupancy,
    passRate,
    queueWait,
    slowAndRegressed,
    loading,
    error,
  };
}
