export const GATE_STATE_ORDER = [
  'open',
  'runnable',
  'pass',
  'fail',
  'deferred',
  'pending-approval',
  'pending',
  'discarded',
];
export const GATE_DONE_STATES = ['pass', 'deferred', 'discarded'];

/** Mirrors the backend's reopenGateItem guard (gateService.ts) — reopen only applies to a resolved item. */
export const REOPEN_BLOCKED_STATES = new Set([
  'open',
  'runnable',
  'pending-approval',
  'pending',
]);
