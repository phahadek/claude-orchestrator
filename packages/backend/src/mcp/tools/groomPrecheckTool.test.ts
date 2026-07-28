/**
 * Tests for the `groom.precheck` MCP tool: a read-only precheck that must
 * return the exact same violations a `task.setStatus` (status: "Ready")
 * stage attempt would surface, without staging anything. AC covered:
 *  - parity with the real stage-time check, on payloads that fail Files/paths,
 *    type_check, and an undispositioned binding constraint respectively
 *  - no staged_intent row, no gate/seed accretion marker, no audit event
 *  - the returned binding-constraint set is recomputed from submitted
 *    regions and widens as regions widen
 *  - a payload that passes the precheck then stages without needs_revision
 *  - the tool is registered only for a 'groom' workflow session
 *  - the implementation is not duplicated — the tool module imports and
 *    delegates to the same checkGroomingPromotionGate/checkReadiness the
 *    stage-time path (stagedIntents.ts's runStageTimeReadyChecks) calls
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const TASK_BODY = '## Summary\nok';

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    fetchTaskPage: vi.fn().mockResolvedValue(TASK_BODY),
  })),
}));

import { db } from '../../db/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerGroomPrecheckTool } from './groomPrecheckTool';
import { registerStageProposalTools } from './stageProposalTools';
import { orchestratorMcpToolName } from '../toolNaming';
import { recordAccretionMarker as recordGateMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedMarker } from '../../seed/seedStore';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

const PROJECT_ID = 'proj-1';
const SESSION_ID = 'session-1';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
  db.prepare('DELETE FROM audit_log').run();
});

async function connectedPrecheckClient(
  workflow: PlanningWorkflow | null = 'groom',
) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  // Registered unconditionally so the server always advertises the tools
  // capability — mirrors orchestratorMcpServer.ts's real registration, where
  // the health tool is always present alongside any workflow-scoped tools.
  server.registerTool('health', {}, async () => ({ content: [] }));
  registerGroomPrecheckTool(server, { projectId: PROJECT_ID, workflow });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function connectedStageClient() {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerStageProposalTools(server, {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function resultOf(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content');
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Fails simultaneously on Files/paths (an empty entry list for a Code task),
 * type_check (flagged with no disposition), and an undispositioned binding
 * constraint (regions resolve to two catalog entries, neither dispositioned).
 */
const MULTI_FAILURE_PAYLOAD = {
  taskId: 'notion:multi-fail',
  groomingGate: {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'flagged', signals: ['api key'] },
    type: '💻 Code',
    filesPathsEntries: [],
    regions: { packages: [], files: ['packages/backend/src/tasks/foo.ts'] },
  },
};

describe('groom.precheck — registration', () => {
  it('registers only for a groom workflow session', async () => {
    const groom = await connectedPrecheckClient('groom');
    expect(
      (await groom.client.listTools()).tools
        .map((t) => t.name)
        .filter((n) => n !== 'health'),
    ).toEqual(['groom.precheck']);
    await groom.close();

    for (const workflow of [null, 'design', 'ops', 'split'] as const) {
      const other = await connectedPrecheckClient(workflow);
      expect(
        (await other.client.listTools()).tools
          .map((t) => t.name)
          .filter((n) => n !== 'health'),
      ).toEqual([]);
      await other.close();
    }
  });
});

describe('groom.precheck — parity with the stage-time check', () => {
  it('matches the stage-time annotation exactly for a payload failing Files/paths, type_check, and an undispositioned binding constraint at once', async () => {
    const stageClient = await connectedStageClient();
    const staged = resultOf(
      await stageClient.client.callTool({
        name: 'task.setStatus',
        arguments: {
          payload: { ...MULTI_FAILURE_PAYLOAD, status: 'Ready' },
        },
      }) as { content: Array<{ type: string; text?: string }> },
    );
    expect(staged.state).toBe('needs_revision');
    const annotation = staged.annotation as { blocked: true; reasons: string[] };
    expect(annotation.blocked).toBe(true);
    expect('reasons' in annotation).toBe(true);
    await stageClient.close();

    const precheckClient = await connectedPrecheckClient('groom');
    const precheck = resultOf(
      await precheckClient.client.callTool({
        name: 'groom.precheck',
        arguments: MULTI_FAILURE_PAYLOAD,
      }) as { content: Array<{ type: string; text?: string }> },
    );
    await precheckClient.close();

    expect(precheck.allowed).toBe(false);
    expect(precheck.gateReasons).toEqual(annotation.reasons);

    const reasons = precheck.gateReasons as string[];
    expect(reasons.some((r) => r.includes('Files / paths'))).toBe(true);
    expect(reasons.some((r) => r.includes('type_check'))).toBe(true);
    expect(
      reasons.some((r) => r.includes('binding constraint')),
    ).toBe(true);
  });
});

describe('groom.precheck — no side effects', () => {
  it('writes no staged_intent row, accretion marker, or audit event', async () => {
    const { client, close } = await connectedPrecheckClient('groom');
    await client.callTool({
      name: 'groom.precheck',
      arguments: MULTI_FAILURE_PAYLOAD,
    });
    await close();

    expect(
      db.prepare('SELECT COUNT(*) as n FROM staged_intent').get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) as n FROM gate_accretion').get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) as n FROM seed_accretion').get(),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) as n FROM audit_log').get()).toEqual({
      n: 0,
    });
  });
});

describe('groom.precheck — recomputed binding-constraint set', () => {
  it('widens as the submitted regions widen', async () => {
    const { client, close } = await connectedPrecheckClient('groom');

    const narrow = resultOf(
      await client.callTool({
        name: 'groom.precheck',
        arguments: {
          taskId: 'notion:regions-narrow',
          groomingGate: {
            regions: {
              packages: [],
              files: ['packages/backend/src/tasks/foo.ts'],
            },
          },
        },
      }) as { content: Array<{ type: string; text?: string }> },
    );
    expect(narrow.bindingConstraintIds).toEqual([
      'authority-vs-drift',
      'command-vocabulary-closed',
    ]);

    const widened = resultOf(
      await client.callTool({
        name: 'groom.precheck',
        arguments: {
          taskId: 'notion:regions-widened',
          groomingGate: {
            regions: {
              packages: [],
              files: [
                'packages/backend/src/tasks/foo.ts',
                'packages/backend/src/groom/bar.ts',
              ],
            },
          },
        },
      }) as { content: Array<{ type: string; text?: string }> },
    );
    expect(widened.bindingConstraintIds).toEqual([
      'authority-vs-drift',
      'command-vocabulary-closed',
      'grooming-guards-server-derived',
      'split-detect-confirm-route',
    ]);

    await close();
  });
});

describe('groom.precheck — a clean payload then stages without needs_revision', () => {
  it('reports allowed:true, and the same payload stages as "staged" not "needs_revision"', async () => {
    const taskId = 'notion:clean-payload';
    recordGateMarker({
      sourceTaskId: taskId,
      project: PROJECT_ID,
      milestone: 'M1',
      decision: 'none',
      reason: 'no runtime-observable behaviour change',
      accretedAt: new Date(0).toISOString(),
    });
    recordSeedMarker({
      sourceTaskId: taskId,
      project: PROJECT_ID,
      milestone: 'M1',
      decision: 'none',
      accretedAt: new Date(0).toISOString(),
    });

    const cleanGroomingGate = {
      size_check: { decision: 'no_split' },
      type_check: { decision: 'none' },
      type: '💻 Code',
      filesPathsEntries: [
        { raw: 'packages/backend/src/foo.ts', isNew: true, existsInRepo: false },
      ],
      dependsOnTasks: [],
      regions: { packages: [], files: [] },
    };

    const { client, close } = await connectedPrecheckClient('groom');
    const precheck = resultOf(
      await client.callTool({
        name: 'groom.precheck',
        arguments: { taskId, groomingGate: cleanGroomingGate },
      }) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(precheck.allowed).toBe(true);
    expect(precheck.gateReasons).toEqual([]);
    expect(precheck.readinessViolations).toEqual([]);

    const stageClient = await connectedStageClient();
    const staged = resultOf(
      await stageClient.client.callTool({
        name: 'task.setStatus',
        arguments: {
          payload: { taskId, status: 'Ready', groomingGate: cleanGroomingGate },
        },
      }) as { content: Array<{ type: string; text?: string }> },
    );
    await stageClient.close();

    expect(staged.state).toBe('staged');
    expect(staged.annotation).toBeNull();
  });
});

describe('groom.precheck — model-facing tool name', () => {
  it('exposes the underscore form derived from orchestratorMcpToolName, not a hand-written name', () => {
    expect(orchestratorMcpToolName('groom.precheck')).toBe(
      'mcp__orchestrator__groom_precheck',
    );
  });
});

describe('groom.precheck — single implementation, no second copy', () => {
  it('delegates to checkGroomingPromotionGate and checkReadiness rather than reimplementing gate logic', () => {
    const source = readFileSync(
      join(__dirname, 'groomPrecheckTool.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /import\s*{\s*checkGroomingPromotionGate\s*}\s*from\s*'\.\.\/\.\.\/groom\/groomGate'/,
    );
    expect(source).toMatch(
      /import\s*{\s*checkReadiness\s*}\s*from\s*'\.\.\/\.\.\/tasks\/readinessGate'/,
    );
    // No locally-defined gate/readiness check function — the whole point is
    // that groomGate.ts / readinessGate.ts remain the sole implementation.
    expect(source).not.toMatch(/^function is[A-Z]/m);
    expect(source).not.toMatch(/^function check[A-Z]/m);
  });
});
