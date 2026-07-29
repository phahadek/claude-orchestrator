import type { StagedIntent } from '../api/stagedIntents';

/**
 * Lightweight pub/sub for `staged_intent_changed` WS messages. The app's one
 * WebSocket connection is wired to useSessionStore's dispatch in App.tsx;
 * this bus lets a deeply-nested consumer (SessionPanel's decision panel)
 * react to live proposal changes without threading the value through every
 * intermediate component's props.
 */
type Listener = (intent: StagedIntent) => void;

const listeners = new Set<Listener>();

export function publishStagedIntentChange(intent: StagedIntent): void {
  for (const listener of listeners) listener(intent);
}

export function subscribeStagedIntentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
