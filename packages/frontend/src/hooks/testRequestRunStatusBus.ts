import type { TestRequestRunStatusPayload } from '@claude-orchestrator/backend/src/ws/types';

const listeners = new Set<(payload: TestRequestRunStatusPayload) => void>();

export function publishTestRequestRunStatus(
  payload: TestRequestRunStatusPayload,
): void {
  for (const listener of listeners) listener(payload);
}

/**
 * Registers a listener for every published run-status payload; returns an
 * unsubscribe function.
 * @public consumed by the 'tests' TopView destination (frontend follow-on task).
 */
export function subscribeTestRequestRunStatus(
  listener: (payload: TestRequestRunStatusPayload) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
