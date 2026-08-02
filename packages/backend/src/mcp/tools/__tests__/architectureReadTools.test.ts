/**
 * Tests for `architecture.getUnit`: a known id returns the unit body
 * unchanged, and an unknown id — including a title-derived slug of the
 * production shape groom sessions actually pass — returns an explicit
 * isError not-found result rather than a silent "null".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/db.js', async () => {
  const { setupTestDb } = await import(
    '../../../../test/helpers/setupTestDb.js'
  );
  return { db: setupTestDb() };
});

import { db } from '../../../db/db.js';
import { createUnit } from '../../../architecture/ArchUnitStore.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerArchitectureReadTools } from '../architectureReadTools';

beforeEach(() => {
  db.prepare('DELETE FROM arch_unit_event').run();
  db.prepare('DELETE FROM arch_unit').run();
  db.prepare('DELETE FROM audit_log').run();
});

async function connectedClient() {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerArchitectureReadTools(server, { workflow: 'groom' });
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

describe('architecture.getUnit', () => {
  it('returns the unit body unchanged for a known id', async () => {
    const unit = createUnit({
      title: 'Session credential scope',
      kind: 'invariant',
      topic: 'session-auth',
      regions: ['packages/backend'],
      body: 'The full architecture unit body content, verbatim.',
      at: '2024-01-01T00:00:00Z',
    });

    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'architecture.getUnit',
      arguments: { id: unit.id },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    await close();

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0]?.text ?? 'null');
    expect(parsed).toMatchObject({
      id: unit.id,
      title: 'Session credential scope',
      body: 'The full architecture unit body content, verbatim.',
    });
  });

  it('returns an explicit isError not-found result for an unknown id, distinguishable from a successful read', async () => {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'architecture.getUnit',
      arguments: { id: 'session-credential-scope' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    await close();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toBe('null');
    expect(result.content[0]?.text).toMatch(/not found/i);
  });
});
