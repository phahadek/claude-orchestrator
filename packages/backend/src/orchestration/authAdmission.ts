import { EventEmitter } from 'node:events';
import {
  clearCliAuthLapse,
  getCliAuthLapse,
  setCliAuthLapse,
} from '../db/queries';
import type { ServerMessage } from '../ws/types';

/**
 * Account-wide "CLI auth lapsed" admission gate. Consulted next to
 * isUsageAdmitted() at the new-work call sites only (AutoLauncher,
 * DispatchTriggerEvaluator, OrphanedTaskSweeper's nudge path) — never on
 * respawnSession or operator-initiated actions. Set when a session is
 * parked on a CLI auth failure; cleared only by a successful refresh-path
 * probe (see AuthLapseProbe). Persisted so a restart doesn't reopen it.
 */
export interface AuthAdmissionResult {
  allowed: boolean;
  /** Present when allowed is false — ms timestamp the lapse was first recorded. */
  since?: number;
  reason?: 'cli_auth_lapsed';
}

/** Emitted (exactly once per lapsed → clear transition) when the lapse is cleared. */
const AUTH_RESTORED_EVENT = 'cli_auth_restored';

const emitter = new EventEmitter();
let _broadcast: ((msg: ServerMessage) => void) | null = null;

export function registerAuthLapseBroadcast(
  broadcast: (msg: ServerMessage) => void,
): void {
  _broadcast = broadcast;
}

export function onAuthRestored(listener: () => void): () => void {
  emitter.on(AUTH_RESTORED_EVENT, listener);
  return () => emitter.off(AUTH_RESTORED_EVENT, listener);
}

/** Reads the persisted state, so a restart re-reads it at boot. */
export function getAuthLapse(): { lapsed: boolean; since?: number } {
  const since = getCliAuthLapse();
  return since == null ? { lapsed: false } : { lapsed: true, since };
}

export function isAuthAdmitted(): AuthAdmissionResult {
  const since = getCliAuthLapse();
  if (since == null) return { allowed: true };
  return { allowed: false, since, reason: 'cli_auth_lapsed' };
}

/** Records an auth lapse (idempotent); broadcasts only on the clear → lapsed transition. */
export function recordAuthLapse(now: number = Date.now()): void {
  if (getCliAuthLapse() != null) return;
  setCliAuthLapse(now);
  _broadcast?.({ type: 'cli_auth_lapse', lapsed: true, since: now });
}

/** Clears the lapse. Returns true (and emits the restored event once) only if it was set. */
export function clearAuthLapse(): boolean {
  if (getCliAuthLapse() == null) return false;
  clearCliAuthLapse();
  _broadcast?.({ type: 'cli_auth_lapse', lapsed: false });
  emitter.emit(AUTH_RESTORED_EVENT);
  return true;
}
