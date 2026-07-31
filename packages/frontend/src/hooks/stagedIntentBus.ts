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

/**
 * Twin bus for `session_turn_completed` — the session-level completeness
 * flip that never lands as a staged_intent row change, so it can't ride the
 * per-intent bus above. Carries only the sessionId; consumers flip
 * sessionComplete in place for their cached intents rather than treating it
 * as a per-intent snapshot.
 */
type TurnCompletedListener = (sessionId: string) => void;

const turnCompletedListeners = new Set<TurnCompletedListener>();

export function publishSessionTurnCompleted(sessionId: string): void {
  for (const listener of turnCompletedListeners) listener(sessionId);
}

export function subscribeSessionTurnCompleted(
  listener: TurnCompletedListener,
): () => void {
  turnCompletedListeners.add(listener);
  return () => turnCompletedListeners.delete(listener);
}
