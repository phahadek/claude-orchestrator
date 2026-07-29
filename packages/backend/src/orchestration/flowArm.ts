/**
 * Single-sourced FlowId enum + flow->dispatch map + read-path arm defaults
 * for the per-flow auto-dispatch arm model (Technical Architecture §
 * "Per-flow auto-dispatch arm model"). C1 (trigger evaluator) and the
 * Milestone panel toggle UI import FlowId/FLOW_IDS/DEFAULT_ARM from here
 * rather than duplicating the flow list.
 *
 * Note: session/sessionPredicates.ts's isPlanningSession also matches
 * 'split', which is not a flow and must not be added to FlowId — 'split' is
 * routed by groomFlip.ts, not by an arm.
 */
export type FlowId = 'groom' | 'gate-verify' | 'design' | 'ops';

export const FLOW_IDS: readonly FlowId[] = [
  'groom',
  'gate-verify',
  'design',
  'ops',
];

export function isFlowId(value: string): value is FlowId {
  return (FLOW_IDS as readonly string[]).includes(value);
}

/** Read-path default when no flow_arm row exists for (milestone, flow). */
export const DEFAULT_ARM: Record<FlowId, boolean> = {
  groom: true,
  'gate-verify': true,
  design: false,
  ops: false,
};

/**
 * How a flow is dispatched. groom/design/ops dispatch the same-named
 * isPlanningSession session type; gate-verify has no session type of its
 * own — it invokes the GateItemVerifier dispatch (gate/gateReconciler.ts's
 * scheduled tick, or the operator-triggered route in routes/gateState.ts).
 */
export type FlowDispatch =
  | { kind: 'session'; sessionType: 'groom' | 'design' | 'ops' }
  | { kind: 'gate-verify' };

export const FLOW_DISPATCH: Record<FlowId, FlowDispatch> = {
  groom: { kind: 'session', sessionType: 'groom' },
  design: { kind: 'session', sessionType: 'design' },
  ops: { kind: 'session', sessionType: 'ops' },
  'gate-verify': { kind: 'gate-verify' },
};
