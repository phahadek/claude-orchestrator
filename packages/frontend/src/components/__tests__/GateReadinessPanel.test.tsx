import { describe, it, expect } from 'vitest';
import {
  GATE_STATE_ORDER,
  GATE_DONE_STATES,
  REOPEN_BLOCKED_STATES,
} from '../GateReadinessPanel';

/** The backend's resolved-state vocabulary (gate/gateService.ts RESOLVED_STATES). */
const BACKEND_RESOLVED_STATES = ['pass', 'deferred', 'discarded'];

describe('GateReadinessPanel state vocabulary', () => {
  it('includes pending and discarded in the state order', () => {
    expect(GATE_STATE_ORDER).toContain('pending');
    expect(GATE_STATE_ORDER).toContain('discarded');
  });

  it('matches the backend RESOLVED_STATES membership exactly', () => {
    expect(new Set(GATE_DONE_STATES)).toEqual(new Set(BACKEND_RESOLVED_STATES));
  });

  it('blocks reopen on pending, matching the backend REOPEN_BLOCKED_STATES guard', () => {
    expect(REOPEN_BLOCKED_STATES.has('pending')).toBe(true);
  });
});
