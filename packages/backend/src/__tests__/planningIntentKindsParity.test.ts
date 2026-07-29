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
import { patchBodySectionPayloadSchema } from '../mcp/tools/schemas';

const ORCHESTRATOR_MCP_PREFIX = 'mcp__orchestrator__';
const HEALTH_TOOL = orchestratorMcpToolName('health');
// gate.verify is a direct verdict call, not a staged-intent kind — it isn't
// in PLANNING_INTENT_KINDS.ops, so the ops guard below excludes it too (see
// config.ts's OPS_MCP_TOOLS comment).
const GATE_VERIFY_TOOL = orchestratorMcpToolName('gate.verify');
// completeness.disposition / completeness.traceCoverage are direct
// write/read calls, not staged-intent kinds — they aren't in
// PLANNING_INTENT_KINDS.design, so the design guard below excludes them too
// (see config.ts's DESIGN_MCP_TOOLS comment).
const COMPLETENESS_TOOLS = [
  orchestratorMcpToolName('completeness.disposition'),
  orchestratorMcpToolName('completeness.traceCoverage'),
];
// groom.precheck is a read-only precheck, not a staged-intent kind — it
// isn't in PLANNING_INTENT_KINDS.groom, so the groom guard below excludes it
// too (see config.ts's GROOM_MCP_TOOLS comment).
const GROOM_PRECHECK_TOOL = orchestratorMcpToolName('groom.precheck');
// architecture.getUnit / architecture.queryUnits are read-only lookups, not
// staged-intent kinds — they aren't in PLANNING_INTENT_KINDS, so every
// workflow's guard below excludes them too (see
// mcp/tools/architectureReadTools.ts).
const ARCHITECTURE_READ_TOOLS = [
  orchestratorMcpToolName('architecture.getUnit'),
  orchestratorMcpToolName('architecture.queryUnits'),
];
// task.getById is a read-only task-summary lookup, not a staged-intent kind —
// it isn't in PLANNING_INTENT_KINDS, so every workflow's guard below excludes
// it too (see config.ts's TASK_READ_MCP_TOOLS comment).
const TASK_READ_TOOLS = [orchestratorMcpToolName('task.getById')];

const WORKFLOWS: {
  name: 'groom' | 'design' | 'ops';
  allowedTools: string[];
  extraNonStagedTools: string[];
}[] = [
  {
    name: 'groom',
    allowedTools: GROOM_ALLOWED_TOOLS,
    extraNonStagedTools: [
      GROOM_PRECHECK_TOOL,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
    ],
  },
  {
    name: 'design',
    allowedTools: DESIGN_ALLOWED_TOOLS,
    extraNonStagedTools: [
      ...COMPLETENESS_TOOLS,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
    ],
  },
  {
    name: 'ops',
    allowedTools: OPS_ALLOWED_TOOLS,
    extraNonStagedTools: [
      GATE_VERIFY_TOOL,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
    ],
  },
];

describe('planning workflow --allowed-tools parity with PLANNING_INTENT_KINDS', () => {
  it('design session allow-list grants mcp__orchestrator__decision_pickOne', () => {
    expect(DESIGN_ALLOWED_TOOLS).toContain(
      orchestratorMcpToolName('decision.pickOne'),
    );
  });

  it('the intent.withdraw tool is exposed under the CLI-sanitized underscore name, not the dotted kind', () => {
    // A hand-written `mcp__orchestrator__intent.withdraw` (dotted) entry, or
    // any other name that doesn't route through orchestratorMcpToolName,
    // would fail this — the CLI itself sanitizes dots to underscores, so the
    // model-facing name must always be derived, never hand-written (see
    // mcp/toolNaming.ts).
    const tool = orchestratorMcpToolName('intent.withdraw');
    expect(tool).toBe('mcp__orchestrator__intent_withdraw');
    expect(GROOM_ALLOWED_TOOLS).toContain(tool);
    expect(DESIGN_ALLOWED_TOOLS).toContain(tool);
    expect(OPS_ALLOWED_TOOLS).toContain(tool);
    expect(GROOM_ALLOWED_TOOLS).not.toContain(
      'mcp__orchestrator__intent.withdraw',
    );
  });

  it('groom and design session allow-lists grant the capability-request tool', () => {
    const tool = orchestratorMcpToolName('session.requestCapability');
    expect(GROOM_ALLOWED_TOOLS).toContain(tool);
    expect(DESIGN_ALLOWED_TOOLS).toContain(tool);
  });

  it('groom/design/ops session allow-lists grant the CLI-sanitized task_patchBodySection tool', () => {
    const tool = orchestratorMcpToolName('task.patchBodySection');
    expect(GROOM_ALLOWED_TOOLS).toContain(tool);
    expect(DESIGN_ALLOWED_TOOLS).toContain(tool);
    expect(OPS_ALLOWED_TOOLS).toContain(tool);
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

  it('task.patchBodySection MCP tool registers a payload schema mirroring the intent payload', async () => {
    const sessionId = 'parity-patchBodySection';
    insertSession({
      session_id: sessionId,
      task_id: null,
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
      session_type: 'groom',
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

    const tool = tools.find(
      (t) =>
        orchestratorMcpToolName(t.name) ===
        orchestratorMcpToolName('task.patchBodySection'),
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('payload');

    // The registered tool's payload schema is patchBodySectionPayloadSchema
    // itself, not a hand-rolled copy — assert against a representative
    // sample from each of its three operation variants.
    const samples = [
      { taskId: 't1', section: 'Context', operation: 'append', content: 'x' },
      {
        taskId: 't1',
        section: 'Context',
        operation: 'replace',
        find: 'x',
        replaceWith: 'y',
      },
      { taskId: 't1', section: 'Context', operation: 'remove' },
    ];
    for (const sample of samples) {
      expect(() => patchBodySectionPayloadSchema.parse(sample)).not.toThrow();
    }
  });
});
