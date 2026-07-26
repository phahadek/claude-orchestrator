/**
 * Tests for the stage-proposal MCP tool surface: one tool per staged-intent
 * kind, each schema-validating its input at the tool-call boundary and
 * delegating to the exact same `stageIntent` chokepoint the human-facing
 * POST /staged-intents route writes through — no parallel validation path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerStageProposalTools } from './stageProposalTools';
import { getStagedIntent, listStagedIntentsByGroup } from '../../db/queries';

const SESSION_ID = 'session-1';
const PROJECT_ID = 'proj-1';

async function connectedClient(kinds?: readonly string[]): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerStageProposalTools(server, {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    kinds,
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

function parseIntentResult(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content');
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('stage-proposal MCP tools — registration', () => {
  it('registers exactly the 13 stage-proposal tool names', async () => {
    const { client, close } = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'arch.createUnit',
        'arch.supersedeUnit',
        'arch.updateUnit',
        'decision.pickOne',
        'gate.accrete',
        'journal.setState',
        'seed.stage',
        'session.requestCapability',
        'task.create',
        'task.setDependsOn',
        'task.setProperties',
        'task.setStatus',
        'task.updateBody',
      ].sort(),
    );
    await close();
  });

  it('registers only the kinds passed in the optional kinds filter', async () => {
    const { client, close } = await connectedClient([
      'task.setStatus',
      'task.create',
    ]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['task.create', 'task.setStatus'].sort(),
    );
    await close();
  });
});

describe('stage-proposal MCP tools — delegation', () => {
  it('task.create stages a task.create intent scoped to the session/project', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'task.create',
      arguments: { payload: { title: 'New task' } },
    });
    const intent = parseIntentResult(
      result as { content: Array<{ type: string; text?: string }> },
    );
    expect(intent.kind).toBe('task.create');
    expect(intent.projectId).toBe(PROJECT_ID);
    expect(intent.sessionId).toBe(SESSION_ID);
    expect(getStagedIntent(intent.id as string)).toBeTruthy();
    await close();
  });

  it('task.setDependsOn threads groupId so correlated intents commit atomically', async () => {
    const { client, close } = await connectedClient();
    const createResult = await client.callTool({
      name: 'task.updateBody',
      arguments: {
        payload: {
          taskId: 't-1',
          sections: {
            summary: 's',
            dependencies: [],
            context: [],
            automatedCriteria: [],
            manualCriteria: [],
          },
        },
        groupId: 'group-1',
      },
    });
    const dependsResult = await client.callTool({
      name: 'task.setDependsOn',
      arguments: {
        payload: { taskId: 't-1', dependsOn: [] },
        groupId: 'group-1',
      },
    });
    const created = parseIntentResult(
      createResult as { content: Array<{ type: string; text?: string }> },
    );
    const depends = parseIntentResult(
      dependsResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(created.groupId).toBe('group-1');
    expect(depends.groupId).toBe('group-1');
    const grouped = listStagedIntentsByGroup('group-1');
    expect(grouped.map((r) => r.id).sort()).toEqual(
      [created.id, depends.id].sort(),
    );
    await close();
  });

  it('decision.pickOne rejects a group (a question stages no write) via the command layer', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'decision.pickOne',
      arguments: {
        payload: {
          prompt: 'Which approach?',
          options: [
            { label: 'A', description: 'first option' },
            { label: 'B', description: 'second option' },
          ],
          allowFreeForm: false,
        },
        groupId: 'group-1',
        decisionProposal: 'a substantive reason this needs a decision',
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    await close();
  });
});

describe('stage-proposal MCP tools — schema validation', () => {
  it('task.updateBody rejects an incomplete TaskBodySections set', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'task.updateBody',
      arguments: {
        payload: {
          taskId: 't-1',
          sections: { summary: 'missing everything else' },
        },
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    await close();
  });

  it('task.updateBody accepts a complete TaskBodySections set', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'task.updateBody',
      arguments: {
        payload: {
          taskId: 't-1',
          sections: {
            summary: 'a summary',
            dependencies: [],
            context: [{ type: 'paragraph', text: 'hello' }],
            automatedCriteria: ['test 1'],
            manualCriteria: ['verify 1'],
          },
        },
      },
    });
    const intent = parseIntentResult(
      result as { content: Array<{ type: string; text?: string }> },
    );
    expect(intent.kind).toBe('task.updateBody');
    await close();
  });

  it('task.setStatus rejects an invalid status enum value', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'task.setStatus',
      arguments: { payload: { taskId: 't-1', status: 'Not-A-Status' } },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    await close();
  });

  it('gate.accrete rejects an invalid classification enum value', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'gate.accrete',
      arguments: {
        payload: {
          sourceTask: {
            id: 't-1',
            title: 'Task',
            project: 'proj-1',
            milestone: 'm-1',
          },
          items: [{ text: 'an item' }],
          classification: 'not-a-real-tier',
        },
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    await close();
  });
});
