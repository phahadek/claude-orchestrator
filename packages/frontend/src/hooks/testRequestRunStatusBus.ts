import type { TestRequestRunStatusPayload } from '@claude-orchestrator/backend/src/ws/types';

/**
 * Lightweight pub/sub for `test_request_run_status` WS messages — mirrors
 * stagedIntentBus.ts's role: the app's one WebSocket connection is wired to
 * useSessionStore's dispatch in App.tsx, and this bus lets a deeply-nested
 * consumer (TaskCard, SessionPanel) react to live lane-run transitions
 * without threading the message through every intermediate component's
 * props.
 */
type Listener = (payload: TestRequestRunStatusPayload) => void;

const listeners = new Set<Listener>();

export function publishTestRequestRunStatus(
  payload: TestRequestRunStatusPayload,
): void {
  for (const listener of listeners) listener(payload);
}

export function subscribeTestRequestRunStatus(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
