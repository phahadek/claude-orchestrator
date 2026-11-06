import type { TestRequestRunStatusPayload } from '@claude-orchestrator/backend/src/ws/types';

const listeners = new Set<(payload: TestRequestRunStatusPayload) => void>();

export function publishTestRequestRunStatus(
  payload: TestRequestRunStatusPayload,
): void {
  for (const listener of listeners) listener(payload);
}

/** Registers a listener for every test_request_run_status broadcast; returns an unsubscribe function. */
export function subscribeToTestRequestRunStatus(
  listener: (payload: TestRequestRunStatusPayload) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
