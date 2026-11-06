import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';
import type { TestRequestRunStatusPayload } from '@claude-orchestrator/backend/src/ws/types';
import { subscribeToTestRequestRunStatus } from './testRequestRunStatusBus';

export type TestLaneRunStatus =
  | TestRequestRunStatusPayload['status']
  | 'queued';

/**
 * Status of the latest test-lane run for one session: REST snapshot on mount,
 * refetched whenever a test_request_run_status for that session arrives.
 * Returns null when there is no run.
 */
export function useTestLaneRunStatus(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
): TestLaneRunStatus | null {
  const [status, setStatus] = useState<TestLaneRunStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!projectId || !sessionId) return undefined;
    let cancelled = false;
    let requestSeq = 0;

    const load = () => {
      const seq = ++requestSeq;
      apiRequest<{ run: { status: TestLaneRunStatus } | null }>(
        `/api/test-request-runs?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
      )
        .then((res) => {
          if (!cancelled && seq === requestSeq) {
            setStatus(res.run?.status ?? null);
          }
        })
        .catch(() => {
          /* transient failure — keep the last known status */
        });
    };

    load();
    const unsubscribe = subscribeToTestRequestRunStatus((payload) => {
      if (payload.projectId === projectId && payload.sessionId === sessionId) {
        load();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, sessionId]);

  return status;
}
