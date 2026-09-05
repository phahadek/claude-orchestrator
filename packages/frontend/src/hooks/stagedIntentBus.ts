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
 * Lightweight pub/sub for `session_completeness` WS messages — the live
 * correction for a session's completeness (see resolveSessionCompleteForDisplay
 * on the backend), which supersedes each of that session's staged intents'
 * frozen `sessionComplete` snapshot. Kept alongside the staged-intent bus
 * since both back useDecisionQueue's milestone-scope visibility filter, and
 * both are populated by the same App.tsx WS dispatch wiring.
 */
export interface SessionCompletenessChange {
  sessionId: string;
  complete: boolean;
}

type CompletenessListener = (change: SessionCompletenessChange) => void;

const completenessListeners = new Set<CompletenessListener>();

export function publishSessionCompletenessChange(
  change: SessionCompletenessChange,
): void {
  for (const listener of completenessListeners) listener(change);
}

export function subscribeSessionCompletenessChange(
  listener: CompletenessListener,
): () => void {
  completenessListeners.add(listener);
  return () => completenessListeners.delete(listener);
}
