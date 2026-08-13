import { describe, it, expect } from 'vitest';
import { INVESTIGATE_ALLOWED_TOOLS } from '../config';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { INVESTIGATE_INTENT_KINDS } from '../planning/planningIntentKinds';

const ORCHESTRATOR_MCP_PREFIX = 'mcp__orchestrator__';
const HEALTH_TOOL = orchestratorMcpToolName('health');
const PULLREQUEST_GETBYTASKID_TOOL = orchestratorMcpToolName(
  'pullRequest.getByTaskId',
);
const ARCHITECTURE_READ_TOOLS = [
  orchestratorMcpToolName('architecture.getUnit'),
  orchestratorMcpToolName('architecture.queryUnits'),
];
const TASK_READ_TOOLS = [orchestratorMcpToolName('task.getById')];
const TIER_B_READ_TOOLS = [
  orchestratorMcpToolName('session.getRecord'),
  orchestratorMcpToolName('auditLog.query'),
  orchestratorMcpToolName('sessionEvents.query'),
];
const EXCLUDED_OPS_ONLY_TOOLS = [
  orchestratorMcpToolName('journal.setState'),
  orchestratorMcpToolName('gate.verify'),
  orchestratorMcpToolName('gateSeed.getState'),
  orchestratorMcpToolName('deploy.verdict'),
  orchestratorMcpToolName('gate.reclassify'),
  orchestratorMcpToolName('intent.dispositionStranded'),
  orchestratorMcpToolName('ops.prIntent'),
];

describe('investigate staged-intent-kind allowlist parity with INVESTIGATE_INTENT_KINDS', () => {
  it('contains exactly task.create, decision.pickOne, session.requestCapability, intent.withdraw', () => {
    expect(new Set(INVESTIGATE_INTENT_KINDS)).toEqual(
      new Set([
        'task.create',
        'decision.pickOne',
        'session.requestCapability',
        'intent.withdraw',
      ]),
    );
    expect(INVESTIGATE_INTENT_KINDS.length).toBe(4);
  });

  it('INVESTIGATE_ALLOWED_TOOLS staged-intent MCP entries equal INVESTIGATE_INTENT_KINDS mapped through orchestratorMcpToolName', () => {
    const extraNonStagedTools = [
      PULLREQUEST_GETBYTASKID_TOOL,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
      ...TIER_B_READ_TOOLS,
    ];
    const stagedIntentTools = INVESTIGATE_ALLOWED_TOOLS.filter((t) =>
      t.startsWith(ORCHESTRATOR_MCP_PREFIX),
    )
      .filter((t) => t !== HEALTH_TOOL)
      .filter((t) => !extraNonStagedTools.includes(t));

    const expected = INVESTIGATE_INTENT_KINDS.map(orchestratorMcpToolName);
    expect(new Set(stagedIntentTools)).toEqual(new Set(expected));
  });

  it('excludes every ops_journal/gate/deploy-specific tool name', () => {
    for (const tool of EXCLUDED_OPS_ONLY_TOOLS) {
      expect(INVESTIGATE_ALLOWED_TOOLS).not.toContain(tool);
    }
  });

  it('includes the Tier-B read tools and the architecture/task/PR read tools', () => {
    for (const tool of [
      ...TIER_B_READ_TOOLS,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
      PULLREQUEST_GETBYTASKID_TOOL,
    ]) {
      expect(INVESTIGATE_ALLOWED_TOOLS).toContain(tool);
    }
  });

  it('exposes intent.withdraw under the CLI-sanitized underscore name, not the dotted kind', () => {
    const tool = orchestratorMcpToolName('intent.withdraw');
    expect(tool).toBe('mcp__orchestrator__intent_withdraw');
    expect(INVESTIGATE_ALLOWED_TOOLS).toContain(tool);
    expect(INVESTIGATE_ALLOWED_TOOLS).not.toContain(
      'mcp__orchestrator__intent.withdraw',
    );
  });
});
