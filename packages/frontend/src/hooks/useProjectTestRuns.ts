import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api/projects';
import { subscribeToTestRequestRunStatus } from './testRequestRunStatusBus';

const POLL_INTERVAL_MS = 15000;

export type ProjectTestRunOutcome =
  | 'passed'
  | 'failed-with-named-tests'
  | 'failed-with-no-report-acquired'
  | 'crashed-oom'
  | 'timed-out'
  | 'execution-failed'
  | 'running'
  | 'queued';

export type ProjectTestRunProducer =
  | 'session_request'
  | 'pr_gate'
  | 'base_health';

interface ProjectTestRunOutcomeCounts {
  passed: number;
  failed: number;
  skipped: number;
  error: number;
  other: number;
  total: number;
}

export interface ProjectTestRunEntry {
  id: string;
  projectId: string;
  sessionId: string | null;
  contentHash: string;
  state: string;
  producer: ProjectTestRunProducer | null;
  runOrigin: string;
  requestedAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  outcome: ProjectTestRunOutcome;
  nextAction: string;
  outcomeCounts: ProjectTestRunOutcomeCounts | null;
}

interface ProjectTestRunsResponse {
  runs: ProjectTestRunEntry[];
}

export interface UseProjectTestRunsResult {
  runs: ProjectTestRunEntry[];
  loading: boolean;
  error: string | null;
}

/**
 * REST-polls the project-scope test-run feed (queued/running/finished) —
 * mirrors useLaneHealthRollup's poll-plus-invalidation-key shape, but the
 * invalidation trigger is internal: a test_request_run_status WS broadcast
 * for this project bumps a local counter instead of the caller having to
 * thread one down.
 */
export function useProjectTestRuns(
  projectId: string | null,
): UseProjectTestRunsResult {
  const [runs, setRuns] = useState<ProjectTestRunEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidationKey, setInvalidationKey] = useState(0);
  const requestIdRef = useRef(0);

  const fetchRuns = useCallback(() => {
    if (!projectId) {
      setRuns([]);
      setError(null);
      setLoading(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    apiRequest<ProjectTestRunsResponse>(
      `/api/test-request-runs/project?projectId=${encodeURIComponent(projectId)}`,
    )
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setRuns(data.runs);
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
    fetchRuns();
  }, [fetchRuns, invalidationKey]);

  useEffect(() => {
    const interval = setInterval(fetchRuns, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  useEffect(() => {
    if (!projectId) return;
    return subscribeToTestRequestRunStatus((payload) => {
      if (payload.projectId !== projectId) return;
      setInvalidationKey((key) => key + 1);
    });
  }, [projectId]);

  return { runs, loading, error };
}
