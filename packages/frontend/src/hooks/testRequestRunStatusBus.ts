import type { TestRequestRunStatusPayload } from '@claude-orchestrator/backend/src/ws/types';

const listeners = new Set<(payload: TestRequestRunStatusPayload) => void>();

export function publishTestRequestRunStatus(
  payload: TestRequestRunStatusPayload,
): void {
  for (const listener of listeners) listener(payload);
}
