/**
 * Coverage for widening groom and ops to task.updateBody: task.create's own
 * tool description promises a two-step create-then-body flow, but that
 * second step was only reachable from design/split sessions. See
 * planningIntentKinds.ts for the single source of truth these lists derive
 * from.
 */

import { describe, it, expect } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { vi, beforeEach } from 'vitest';
import { db } from '../db/db';
import { GROOM_ALLOWED_TOOLS, OPS_ALLOWED_TOOLS } from '../config';
import { orchestratorMcpToolName } from '../mcp/toolNaming';
import { PLANNING_INTENT_KINDS } from '../planning/planningIntentKinds';
import { checkGroomingPromotionGate } from '../groom/groomGate';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerStageProposalTools } from '../mcp/tools/stageProposalTools';
import { getStagedIntent } from '../db/queries';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('PLANNING_INTENT_KINDS — groom/ops gain task.updateBody', () => {
  it('groom includes task.updateBody', () => {
    expect(PLANNING_INTENT_KINDS.groom).toContain('task.updateBody');
  });

  it('ops includes task.updateBody', () => {
    expect(PLANNING_INTENT_KINDS.ops).toContain('task.updateBody');
  });
});

describe('GROOM_ALLOWED_TOOLS / OPS_ALLOWED_TOOLS — CLI-sanitized task_updateBody', () => {
  it('GROOM_ALLOWED_TOOLS contains mcp__orchestrator__task_updateBody', () => {
    expect(GROOM_ALLOWED_TOOLS).toContain(
      orchestratorMcpToolName('task.updateBody'),
    );
  });

  it('OPS_ALLOWED_TOOLS contains mcp__orchestrator__task_updateBody', () => {
    expect(OPS_ALLOWED_TOOLS).toContain(
      orchestratorMcpToolName('task.updateBody'),
    );
  });
});

describe('a staged task.updateBody intent from a groom session', () => {
  it('persists with state = "staged" and is not auto-applied', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    registerStageProposalTools(server, {
      sessionId: 'session-groom-1',
      projectId: 'proj-1',
      kinds: PLANNING_INTENT_KINDS.groom,
    });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: 'task.updateBody',
      arguments: {
        payload: {
          taskId: 't-1',
          sections: {
            summary: 'a summary',
            dependencies: [],
            context: [],
            automatedCriteria: ['test 1'],
            manualCriteria: ['verify 1'],
          },
        },
      },
    });

    const text = (result as { content: Array<{ type: string; text?: string }> })
      .content[0]?.text;
    expect(typeof text).toBe('string');
    const intent = JSON.parse(text as string) as { id: string; kind: string };
    expect(intent.kind).toBe('task.updateBody');

    const row = getStagedIntent(intent.id);
    expect(row).toBeTruthy();
    expect(row?.state).toBe('staged');

    await client.close();
    await server.close();
  });
});

describe('Ready-path promotion gate — unaffected by task.updateBody availability', () => {
  it('a promotion staging no task.updateBody still passes the gate', () => {
    const result = checkGroomingPromotionGate(
      {
        size_check: { decision: 'n/a' },
        type_check: { decision: 'none' },
      },
      'notion:t-no-body-edit',
    );
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
