/**
 * Tests for the flow->dispatch map (orchestration/flowArm.ts): groom/design/ops
 * dispatch their same-named isPlanningSession session type; gate-verify has no
 * session type of its own — it invokes the GateItemVerifier dispatch instead.
 */

import { describe, it, expect } from 'vitest';
import {
  FLOW_IDS,
  FLOW_DISPATCH,
  isFlowId,
  type FlowDispatch,
} from '../flowArm.js';

describe('FLOW_DISPATCH', () => {
  it('maps groom/design/ops to their same-named session type', () => {
    expect(FLOW_DISPATCH.groom).toEqual({
      kind: 'session',
      sessionType: 'groom',
    });
    expect(FLOW_DISPATCH.design).toEqual({
      kind: 'session',
      sessionType: 'design',
    });
    expect(FLOW_DISPATCH.ops).toEqual({ kind: 'session', sessionType: 'ops' });
  });

  it('maps gate-verify to the GateItemVerifier dispatch, not a session type', () => {
    const dispatch: FlowDispatch = FLOW_DISPATCH['gate-verify'];
    expect(dispatch).toEqual({ kind: 'gate-verify' });
  });

  it('has an entry for every FlowId', () => {
    for (const flow of FLOW_IDS) {
      expect(FLOW_DISPATCH[flow]).toBeDefined();
    }
  });
});

describe('isFlowId', () => {
  it('accepts the four known flows and rejects split and unknowns', () => {
    for (const flow of FLOW_IDS) {
      expect(isFlowId(flow)).toBe(true);
    }
    expect(isFlowId('split')).toBe(false);
    expect(isFlowId('bogus')).toBe(false);
  });
});
