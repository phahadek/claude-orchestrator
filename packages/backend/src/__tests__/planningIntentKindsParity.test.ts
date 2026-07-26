import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  GROOM_ALLOWED_TOOLS,
  DESIGN_ALLOWED_TOOLS,
  OPS_ALLOWED_TOOLS,
} from '../config';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { buildMcpServer } from '../mcp/orchestratorMcpServer';
import { SessionManager } from '../session/SessionManager';
import { insertSession } from '../db/queries';
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

  it('groom and design session allow-lists grant the capability-request tool', () => {
    const tool = orchestratorMcpToolName('session.requestCapability');
    expect(GROOM_ALLOWED_TOOLS).toContain(tool);
    expect(DESIGN_ALLOWED_TOOLS).toContain(tool);
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

  it.each(WORKFLOWS)(
    '$name MCP server registers exactly its allow-list mcp__orchestrator__ entries',
    async ({ name, allowedTools }) => {
      const sessionId = `parity-${name}`;
      insertSession({
        session_id: sessionId,
        task_id: null,
        task_url: null,
        project_context_url: null,
        project_id: 'proj-1',
        status: 'running',
        started_at: Date.now(),
        session_type: name,
      });

      const server = buildMcpServer(sessionId, new SessionManager());
      const [serverTransport, clientTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      await client.close();
      await server.close();

      const registered = new Set(
        tools.map((t) => orchestratorMcpToolName(t.name)),
      );
      const expected = new Set(
        allowedTools.filter((t) => t.startsWith(ORCHESTRATOR_MCP_PREFIX)),
      );
      expect(registered).toEqual(expected);
    },
  );
});
