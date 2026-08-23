/**
 * Single-sourced FlowId enum + flow->dispatch map + read-path arm defaults
 * for the per-flow auto-dispatch arm model (Technical Architecture §
 * "Per-flow auto-dispatch arm model"). C1 (trigger evaluator) and the
 * Milestone panel's FlowArmToggle import FlowId/FLOW_IDS/DEFAULT_ARM from
 * here rather than duplicating the flow list.
 *
 * Note: session/sessionPredicates.ts's isPlanningSession also matches
 * 'split', which is not a flow and must not be added to FlowId — 'split' is
 * routed by groomFlip.ts, not by an arm.
 */
export type FlowId =
  | 'groom'
  | 'gate-verify'
  | 'design'
  | 'ops'
  | 'docs'
  | 'investigate';

export const FLOW_IDS: readonly FlowId[] = [
  'groom',
  'gate-verify',
  'design',
  'ops',
  'docs',
  'investigate',
];

export function isFlowId(value: string): value is FlowId {
  return (FLOW_IDS as readonly string[]).includes(value);
}

/**
 * Read-path default when no flow_arm row exists for (milestone, flow).
 *
 * Every flow defaults to disarmed. Arming is an explicit per-milestone
 * operator decision made via the FlowArmToggle UI, not something a new
 * milestone inherits. (Reversed from the groom/gate-verify-armed-by-default
 * shipped in the original per-flow arm model design; see that page's
 * amended decision record.)
 */
export const DEFAULT_ARM: Record<FlowId, boolean> = {
  groom: false,
  'gate-verify': false,
  design: false,
  ops: false,
  docs: false,
  investigate: false,
};

/**
 * How a flow is dispatched. groom/design/ops dispatch the same-named
 * isPlanningSession session type; gate-verify has no session type of its
 * own — it invokes the GateItemVerifier dispatch (gate/gateReconciler.ts's
 * scheduled tick, or the operator-triggered route in routes/gateState.ts).
 * investigate is likewise sibling to gate-verify, not a `{kind:'session',
 * sessionType}` variant — its dispatch doesn't go through
 * DispatchTriggerEvaluator's per-project Notion-task-board candidate scan;
 * it scans committed investigation_report rows instead (see
 * investigation/investigationReconciler.ts's scheduled tick, or the
 * operator-triggered route in routes/investigate.ts).
 */
export type FlowDispatch =
  | { kind: 'session'; sessionType: 'groom' | 'design' | 'ops' | 'docs' }
  | { kind: 'gate-verify' }
  | { kind: 'investigate' };

export const FLOW_DISPATCH: Record<FlowId, FlowDispatch> = {
  groom: { kind: 'session', sessionType: 'groom' },
  design: { kind: 'session', sessionType: 'design' },
  ops: { kind: 'session', sessionType: 'ops' },
  docs: { kind: 'session', sessionType: 'docs' },
  'gate-verify': { kind: 'gate-verify' },
  investigate: { kind: 'investigate' },
};
