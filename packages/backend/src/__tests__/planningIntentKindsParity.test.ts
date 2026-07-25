import { describe, it, expect } from 'vitest';
import {
  GROOM_ALLOWED_TOOLS,
  DESIGN_ALLOWED_TOOLS,
  OPS_ALLOWED_TOOLS,
} from '../config';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { PLANNING_INTENT_KINDS } from '../planning/planningIntentKinds';

const ORCHESTRATOR_MCP_PREFIX = 'mcp__orchestrator__';
const HEALTH_TOOL = orchestratorMcpToolName('health');
// gate.verify is a direct verdict call, not a staged-intent kind — it isn't
// in PLANNING_INTENT_KINDS.ops, so the ops guard below excludes it too (see
// config.ts's OPS_MCP_TOOLS comment).
const GATE_VERIFY_TOOL = orchestratorMcpToolName('gate.verify');

const WORKFLOWS: {
  name: 'groom' | 'design' | 'ops';
  allowedTools: string[];
  extraNonStagedTools: string[];
}[] = [
  { name: 'groom', allowedTools: GROOM_ALLOWED_TOOLS, extraNonStagedTools: [] },
  {
    name: 'design',
    allowedTools: DESIGN_ALLOWED_TOOLS,
    extraNonStagedTools: [],
  },
  {
    name: 'ops',
    allowedTools: OPS_ALLOWED_TOOLS,
    extraNonStagedTools: [GATE_VERIFY_TOOL],
  },
];

describe('planning workflow --allowed-tools parity with PLANNING_INTENT_KINDS', () => {
  it('design session allow-list grants mcp__orchestrator__decision_pickOne', () => {
    expect(DESIGN_ALLOWED_TOOLS).toContain(
      orchestratorMcpToolName('decision.pickOne'),
    );
  });

  it.each(WORKFLOWS)(
    '$name allow-list staged-intent MCP entries equal PLANNING_INTENT_KINDS.$name mapped through orchestratorMcpToolName',
    ({ name, allowedTools, extraNonStagedTools }) => {
      const stagedIntentTools = allowedTools
        .filter((t) => t.startsWith(ORCHESTRATOR_MCP_PREFIX))
        .filter((t) => t !== HEALTH_TOOL)
        .filter((t) => !extraNonStagedTools.includes(t));

      const expected = PLANNING_INTENT_KINDS[name].map(orchestratorMcpToolName);

      expect(new Set(stagedIntentTools)).toEqual(new Set(expected));
    },
  );
});
