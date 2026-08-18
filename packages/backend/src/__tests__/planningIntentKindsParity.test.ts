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
// gateSeed.getState is the read-only gate_item/seed_item state lookup a
// gate-verify (ops) session needs to gather evidence for the same item it
// verifies via gate.verify above — also a direct read, not a staged-intent
// kind, so it isn't in PLANNING_INTENT_KINDS.ops (see config.ts's
// OPS_MCP_TOOLS comment).
const GATESEED_GETSTATE_TOOL = orchestratorMcpToolName('gateSeed.getState');
// testHealth.getFlakyHistory is the read-only flagged_flaky_tests_rollup /
// base_health_remediation_test_tracking lookup registered unconditionally
// for any project-resolved session (see mcp/tools/testHealthReadTools.ts) —
// also a direct read, not a staged-intent kind, so it isn't in
// PLANNING_INTENT_KINDS. Unlike gateSeed.getState it IS CLI-allowed for
// every workflow (see config.ts's PROJECT_READ_MCP_TOOLS comment), so it
// lands in extraNonStagedTools rather than alwaysRegisteredNotAllowed below.
const TESTHEALTH_GETFLAKYHISTORY_TOOL = orchestratorMcpToolName(
  'testHealth.getFlakyHistory',
);
// deploy.verdict is the deploy-agentic-step spawner's verdict-reporting
// tool — a direct call straight to DeployOrchestrator.reportAgenticVerdict(),
// never a staged intent, so it isn't in PLANNING_INTENT_KINDS.ops (see
// config.ts's OPS_MCP_TOOLS comment).
const DEPLOY_VERDICT_TOOL = orchestratorMcpToolName('deploy.verdict');
// gate.reclassify / intent.dispositionStranded are also direct calls, never
// staged intents (see config.ts's OPS_MCP_TOOLS comment) — same precedent as
// deploy.verdict just above.
const GATE_RECLASSIFY_TOOL = orchestratorMcpToolName('gate.reclassify');
const STRANDED_INTENT_TOOL = orchestratorMcpToolName(
  'intent.dispositionStranded',
);
// pullRequest.getByTaskId is the read-only PR lookup registered
// unconditionally for any session resolving to a project — also a direct
// read, not a staged-intent kind, so it isn't in PLANNING_INTENT_KINDS (see
// config.ts's PROJECT_READ_MCP_TOOLS comment).
const PULLREQUEST_GETBYTASKID_TOOL = orchestratorMcpToolName(
  'pullRequest.getByTaskId',
);
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
const TASK_READ_TOOLS = [
  orchestratorMcpToolName('task.getById'),
  orchestratorMcpToolName('task.queryTasks'),
];
// session.getRecord / auditLog.query are the Tier-B capability-gated read
// tools (mcp/tools/sessionRecordReadTool.ts, mcp/tools/auditLogReadTools.ts),
// registered unconditionally like the tools above — not staged-intent kinds,
// so every workflow's guard below excludes them too (see config.ts's
// TIER_B_READ_MCP_TOOLS comment).
const TIER_B_READ_TOOLS = [
  orchestratorMcpToolName('session.getRecord'),
  orchestratorMcpToolName('auditLog.query'),
  orchestratorMcpToolName('sessionEvents.query'),
];

const WORKFLOWS: {
  name: 'groom' | 'design' | 'ops';
  allowedTools: string[];
  extraNonStagedTools: string[];
  /**
   * gateSeed.getState the server registers unconditionally for any
   * project-resolved session (see buildMcpServer's doc comment), but which
   * stays out of GROOM_ALLOWED_TOOLS/DESIGN_ALLOWED_TOOLS on purpose — a
   * groom/design session must never be CLI-permitted to call it, only ever
   * see it listed (see orchestrator-config.test.ts's "never a mutating
   * gate/seed tool" guard). Not present for ops: there it's a genuine
   * OPS_MCP_TOOLS entry, so it's already in allowedTools.
   */
  alwaysRegisteredNotAllowed: string[];
}[] = [
  {
    name: 'groom',
    allowedTools: GROOM_ALLOWED_TOOLS,
    extraNonStagedTools: [
      GROOM_PRECHECK_TOOL,
      GATESEED_GETSTATE_TOOL,
      TESTHEALTH_GETFLAKYHISTORY_TOOL,
      PULLREQUEST_GETBYTASKID_TOOL,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
      ...TIER_B_READ_TOOLS,
    ],
    alwaysRegisteredNotAllowed: [GATESEED_GETSTATE_TOOL],
  },
  {
    name: 'design',
    allowedTools: DESIGN_ALLOWED_TOOLS,
    extraNonStagedTools: [
      ...COMPLETENESS_TOOLS,
      GATESEED_GETSTATE_TOOL,
      TESTHEALTH_GETFLAKYHISTORY_TOOL,
      PULLREQUEST_GETBYTASKID_TOOL,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
      ...TIER_B_READ_TOOLS,
    ],
    alwaysRegisteredNotAllowed: [GATESEED_GETSTATE_TOOL],
  },
  {
    name: 'ops',
    allowedTools: OPS_ALLOWED_TOOLS,
    extraNonStagedTools: [
      GATESEED_GETSTATE_TOOL,
      TESTHEALTH_GETFLAKYHISTORY_TOOL,
      DEPLOY_VERDICT_TOOL,
      GATE_RECLASSIFY_TOOL,
      STRANDED_INTENT_TOOL,
      PULLREQUEST_GETBYTASKID_TOOL,
      ...ARCHITECTURE_READ_TOOLS,
      ...TASK_READ_TOOLS,
      ...TIER_B_READ_TOOLS,
    ],
    alwaysRegisteredNotAllowed: [],
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

  it('gate.verify is a genuine PLANNING_INTENT_KINDS.ops staged-intent kind, granted to ops sessions', () => {
    const tool = orchestratorMcpToolName('gate.verify');
    expect(PLANNING_INTENT_KINDS.ops).toContain('gate.verify');
    expect(OPS_ALLOWED_TOOLS).toContain(tool);
  });

  it('gate.reclassify and intent.dispositionStranded are exposed to ops sessions under their CLI-sanitized underscore names', () => {
    expect(GATE_RECLASSIFY_TOOL).toBe('mcp__orchestrator__gate_reclassify');
    expect(STRANDED_INTENT_TOOL).toBe(
      'mcp__orchestrator__intent_dispositionStranded',
    );
    expect(OPS_ALLOWED_TOOLS).toContain(GATE_RECLASSIFY_TOOL);
    expect(OPS_ALLOWED_TOOLS).toContain(STRANDED_INTENT_TOOL);
    expect(GROOM_ALLOWED_TOOLS).not.toContain(GATE_RECLASSIFY_TOOL);
    expect(DESIGN_ALLOWED_TOOLS).not.toContain(GATE_RECLASSIFY_TOOL);
  });

  it('groom session allow-list grants the CLI-sanitized task_setType tool, and only groom', () => {
    const tool = orchestratorMcpToolName('task.setType');
    expect(tool).toBe('mcp__orchestrator__task_setType');
    expect(PLANNING_INTENT_KINDS.groom).toContain('task.setType');
    expect(GROOM_ALLOWED_TOOLS).toContain(tool);
    expect(DESIGN_ALLOWED_TOOLS).not.toContain(tool);
    expect(OPS_ALLOWED_TOOLS).not.toContain(tool);
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
    async ({ name, allowedTools, alwaysRegisteredNotAllowed }) => {
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
      const expected = new Set([
        ...allowedTools.filter((t) => t.startsWith(ORCHESTRATOR_MCP_PREFIX)),
        ...alwaysRegisteredNotAllowed,
      ]);
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
