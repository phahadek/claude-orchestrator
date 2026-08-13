import { useEffect, useState } from 'react';
import { apiRequest } from '../api/projects';
import type { TestRequestRunStatusPayload } from '@claude-orchestrator/backend/src/ws/types';
import { subscribeTestRequestRunStatus } from './testRequestRunStatusBus';

/**
 * The primary-outcome bucket a TaskCard/SessionPanel indicator renders.
 * 'blocked' is reported directly from the session's `test_request_cycle_exceeded`
 * pause reason (see params.pauseReason below) rather than from a lane run —
 * a cycle-limit-exceeded request never gets auto-approved, so it never
 * produces a `test_request_runs` row to report a status from; it is stuck at
 * `staged` forever until an operator intervenes.
 */
export type TestLaneOutcome = 'in-flight' | 'passed' | 'failed' | 'blocked';

export interface TestLaneRunStatus {
  outcome: TestLaneOutcome;
  /** The run's captured output — present only when outcome === 'failed'. */
  output?: string;
  /** Contextual detail for SessionPanel's fuller per-request view: set when the run's requestedAt-to-startedAt gap suggests it queued behind the per-project concurrency cap, or shared its execution with another session's identical-content request (coalescing). */
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}

// Below this, a running/passed/failed request started close enough to when
// it was requested that there's nothing noteworthy to surface — most runs
// admit near-instantly.
const ADMISSION_WAIT_NOTE_THRESHOLD_MS = 1500;

function toStatus(
  payload: TestRequestRunStatusPayload | null,
): TestLaneRunStatus | null {
  if (!payload) return null;
  const outcome: TestLaneOutcome =
    payload.status === 'running'
      ? 'in-flight'
      : payload.status === 'passed'
        ? 'passed'
        : 'failed';
  let note: string | undefined;
  if (payload.requestedAt != null) {
    const waitMs = payload.startedAt - payload.requestedAt;
    if (waitMs > ADMISSION_WAIT_NOTE_THRESHOLD_MS) {
      note = `Queued ${Math.round(waitMs / 1000)}s before starting — waiting on the project's test-lane concurrency cap, or coalesced with another in-flight identical run.`;
    }
  }
  return {
    outcome,
    output: payload.output,
    note,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
  };
}

/**
 * WS-driven governed test-lane run status for one session, following the
 * same REST-snapshot-on-mount + WS-delta-on-live-update pattern
 * useSessionStore/useDecisionQueue use elsewhere — no local optimistic
 * state, no polling. Returns null when there is no lane run to report (no
 * test.request has ever executed for this session) and the session isn't
 * cycle-blocked.
 */
export function useTestLaneRunStatus(params: {
  projectId: string | null | undefined;
  sessionId: string | null | undefined;
  /** The owning task/session's current pause reason, if any — pass `task.pauseReason` from TaskCard. Omit from SessionPanel, which doesn't own the pause banner. */
  pauseReason?: string | null;
}): TestLaneRunStatus | null {
  const { projectId, sessionId, pauseReason } = params;
  const [status, setStatus] = useState<TestLaneRunStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!projectId || !sessionId) return undefined;
    let cancelled = false;
    // A live WS delta always supersedes the mount-time REST snapshot — set
    // once a WS message for this (projectId, sessionId) arrives, so the
    // snapshot fetch's `.then` (which can resolve after a faster WS message,
    // since the two race independently) never clobbers fresher WS state with
    // what was already-stale data at the time the fetch was issued.
    let wsUpdateReceived = false;

    const unsubscribe = subscribeTestRequestRunStatus((payload) => {
      if (payload.projectId !== projectId || payload.sessionId !== sessionId) {
        return;
      }
      wsUpdateReceived = true;
      setStatus(toStatus(payload));
    });

    apiRequest<{ run: TestRequestRunStatusPayload | null }>(
      `/api/test-request-runs?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
    )
      .then((res) => {
        if (!cancelled && !wsUpdateReceived) setStatus(toStatus(res.run));
      })
      .catch(() => {
        /* no lane run yet for this session, or a transient fetch failure — leave status unset */
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, sessionId]);

  if (pauseReason === 'test_request_cycle_exceeded') {
    return { outcome: 'blocked' };
  }
  return status;
}
