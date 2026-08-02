/**
 * Tests for `gateSeed.getState`: returns gate_item/seed_item state scoped to
 * (project, milestone), and never surfaces the operator field or event
 * history those items' *_event tables carry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../projects/ProjectService', () => ({
  ProjectService: {
    getById: (id: string) =>
      id === 'proj-1'
        ? {
            id: 'proj-1',
            milestones: [
              {
                id: 'ms-uuid-1',
                name: 'Milestone One',
                canonicalShortId: 'M1',
              },
            ],
          }
        : undefined,
  },
}));

import { db } from '../../db/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerGateSeedReadTools } from './gateSeedReadTools';
import {
  insertItem as insertGateItem,
  appendEvent as appendGateEvent,
} from '../../gate/gateStore';
import {
  insertItem as insertSeedItem,
  appendEvent as appendSeedEvent,
} from '../../seed/seedStore';

const PROJECT_ID = 'proj-1';
const MILESTONE = 'M1';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item_event').run();
});

async function connectedClient() {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerGateSeedReadTools(server, { projectId: PROJECT_ID });
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

describe('gateSeed.getState', () => {
  it('returns gate/seed item state for the given project + milestone', async () => {
    const gateItem = insertGateItem({
      project: PROJECT_ID,
      milestone: MILESTONE,
      text: 'Verify the new endpoint returns 200',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-1', sourceTaskTitle: 'Task 1' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    const seedItem = insertSeedItem({
      project: PROJECT_ID,
      milestone: MILESTONE,
      spec: 'Seed a demo account',
      sources: [{ sourceTaskId: 'notion:task-2', sourceTaskTitle: 'Task 2' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });

    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'gateSeed.getState',
        arguments: { milestone: MILESTONE },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(result.gateItems).toEqual([
      {
        id: gateItem.id,
        milestone: MILESTONE,
        text: 'Verify the new endpoint returns 200',
        classification: 'Read-Only',
        state: 'open',
      },
    ]);
    expect(result.seedItems).toEqual([
      {
        id: seedItem.id,
        milestone: MILESTONE,
        spec: 'Seed a demo account',
        state: 'pending',
      },
    ]);
  });

  it('never returns the operator field or event-history rows', async () => {
    const gateItem = insertGateItem({
      project: PROJECT_ID,
      milestone: MILESTONE,
      text: 'Verify the new endpoint returns 200',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-1', sourceTaskTitle: 'Task 1' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendGateEvent(gateItem.id, {
      disposition: 'confirmed',
      operator: 'alice@example.com',
      at: '2024-01-02T00:00:00Z',
    });
    const seedItem = insertSeedItem({
      project: PROJECT_ID,
      milestone: MILESTONE,
      spec: 'Seed a demo account',
      sources: [{ sourceTaskId: 'notion:task-2', sourceTaskTitle: 'Task 2' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });
    appendSeedEvent(seedItem.id, {
      outcome: 'confirmed',
      operator: 'alice@example.com',
      at: '2024-01-02T00:00:00Z',
    });

    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'gateSeed.getState',
        arguments: { milestone: MILESTONE },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('operator');
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('confirmed');
    expect(serialized).not.toContain('events');
  });

  it('only returns items for the requested milestone', async () => {
    insertGateItem({
      project: PROJECT_ID,
      milestone: 'M2',
      text: 'Other milestone item',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:task-3', sourceTaskTitle: 'Task 3' }],
      updatedAt: '2024-01-01T00:00:00Z',
    });

    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'gateSeed.getState',
        arguments: { milestone: MILESTONE },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(result.gateItems).toEqual([]);
    expect(result.seedItems).toEqual([]);
  });

  it.each([
    ['the DB UUID', 'ms-uuid-1'],
    ['the canonical short id', 'M1'],
    ['the full display name', 'Milestone One'],
  ])(
    'returns the same items regardless of which milestone form is passed (%s)',
    async (_label, milestoneRef) => {
      const gateItem = insertGateItem({
        project: PROJECT_ID,
        milestone: MILESTONE,
        text: 'Verify the new endpoint returns 200',
        classification: 'Read-Only',
        sources: [{ sourceTaskId: 'notion:task-1', sourceTaskTitle: 'Task 1' }],
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const { client, close } = await connectedClient();
      const result = resultOf(
        (await client.callTool({
          name: 'gateSeed.getState',
          arguments: { milestone: milestoneRef },
        })) as { content: Array<{ type: string; text?: string }> },
      );
      await close();

      expect(result.gateItems).toEqual([
        {
          id: gateItem.id,
          milestone: MILESTONE,
          text: 'Verify the new endpoint returns 200',
          classification: 'Read-Only',
          state: 'open',
        },
      ]);
    },
  );

  it('raises a clear error for an unresolvable milestone rather than returning an empty result set', async () => {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'gateSeed.getState',
      arguments: { milestone: 'not-a-real-milestone' },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    await close();

    expect(result.isError).toBe(true);
    const parsed = resultOf(result as never);
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).toMatch(/not-a-real-milestone/);
  });
});
