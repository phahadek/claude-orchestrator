import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PLANNING_INTENT_KINDS } from '../planningIntentKinds';
import { registerStageProposalTools } from '../../mcp/tools/stageProposalTools';

// Every PLANNING_INTENT_KINDS entry gets a `mcp__orchestrator__<kind>` tool
// through registerStageProposalTools's 1:1 kind->tool mapping — except a
// small, explicitly-documented set of kinds registered by a bespoke tool
// elsewhere instead (mirroring config.ts's GROOM_MCP_TOOLS/OPS_MCP_TOOLS
// "added here explicitly" comments): gate.verify is staged by a gate-verify
// session through mcp/tools/verdictTools.ts, not the generic stage-proposal
// surface. Any other PLANNING_INTENT_KINDS entry missing from
// registerStageProposalTools's registration is a real omission — task.setType
// was exactly this gap (it existed as a KNOWN_INTENT_KINDS/apply-handler
// kind with no registered tool for any workflow) before this guard existed.
const KINDS_REGISTERED_BY_A_BESPOKE_TOOL = new Set(['gate.verify']);

function registeredStageProposalToolKinds(): Set<string> {
  const server = new McpServer({ name: 'guard-test', version: '1.0.0' });
  const registered: string[] = [];
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    registered.push(name);
    return (
      originalRegisterTool as unknown as (
        ...args: unknown[]
      ) => ReturnType<typeof server.registerTool>
    )(name, ...rest);
  }) as typeof server.registerTool;
  registerStageProposalTools(server, {
    sessionId: 'guard-session',
    projectId: 'guard-project',
  });
  return new Set(registered);
}

describe('PLANNING_INTENT_KINDS', () => {
  it('carries a non-empty entry for every planning workflow, including docs', () => {
    for (const workflow of [
      'groom',
      'design',
      'ops',
      'split',
      'docs',
    ] as const) {
      expect(Array.isArray(PLANNING_INTENT_KINDS[workflow])).toBe(true);
      expect(PLANNING_INTENT_KINDS[workflow].length).toBeGreaterThan(0);
    }
  });

  it('every kind across every workflow has a correspondingly registered stage-proposal tool (or a documented bespoke exception)', () => {
    const registered = registeredStageProposalToolKinds();
    for (const workflow of [
      'groom',
      'design',
      'ops',
      'split',
      'docs',
    ] as const) {
      for (const kind of PLANNING_INTENT_KINDS[workflow]) {
        const hasTool =
          registered.has(kind) ||
          KINDS_REGISTERED_BY_A_BESPOKE_TOOL.has(kind);
        expect(
          hasTool,
          `PLANNING_INTENT_KINDS.${workflow} lists "${kind}" but no ` +
            'stage-proposal tool registers it — it is unreachable from a ' +
            'dispatched session',
        ).toBe(true);
      }
    }
  });

  it('task.setType is a member of PLANNING_INTENT_KINDS.groom', () => {
    expect(PLANNING_INTENT_KINDS.groom).toContain('task.setType');
  });

  it('docs.notion.pageEdit is the staged-write path for a Notion-page Target surface', () => {
    expect(PLANNING_INTENT_KINDS.docs).toContain('notion.pageEdit');
  });

  it('the docs intent-kind set is not identical to the design set', () => {
    expect(new Set(PLANNING_INTENT_KINDS.docs)).not.toEqual(
      new Set(PLANNING_INTENT_KINDS.design),
    );
  });

  it('docs carries no task.* staging surface — a docs session reads its own task but does not write task status/body', () => {
    expect(PLANNING_INTENT_KINDS.docs.some((k) => k.startsWith('task.'))).toBe(
      false,
    );
  });
});
