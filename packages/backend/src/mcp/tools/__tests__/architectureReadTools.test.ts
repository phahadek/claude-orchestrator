/**
 * Tests for `architecture.getUnit`: a known id returns the unit body
 * unchanged, and an unknown id — including a title-derived slug of the
 * production shape groom sessions actually pass — returns an explicit
 * isError not-found result rather than a silent "null".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/db.js', async () => {
  const { setupTestDb } =
    await import('../../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../../db/db.js';
import {
  createUnit,
  supersedeUnit,
} from '../../../architecture/ArchUnitStore.js';
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
    })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
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
    })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    await close();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toBe('null');
    expect(result.content[0]?.text).toMatch(/not found/i);
  });

  it('names the binding-constraint confusion for a non-uuid id copied verbatim from the digest', async () => {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'architecture.getUnit',
      arguments: { id: 'pr-no-self-merge' },
    })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    await close();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/binding-constraint/i);
  });

  it('still returns isError true (never a body, never the literal null) for a well-formed uuid that does not exist', async () => {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'architecture.getUnit',
      arguments: { id: '00000000-0000-4000-8000-000000000000' },
    })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    await close();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toBe('null');
    expect(result.content[0]?.text).toMatch(/not found/i);
    expect(result.content[0]?.text).not.toMatch(/binding-constraint/i);
  });
});

describe('architecture.queryUnits', () => {
  async function callQueryUnits(args: Record<string, unknown>) {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'architecture.queryUnits',
      arguments: args,
    })) as { content: Array<{ type: string; text?: string }> };
    await close();
    return JSON.parse(result.content[0]?.text ?? 'null');
  }

  it('returns a bare array for a successful topic query', async () => {
    createUnit({
      title: 'Session credential scope',
      kind: 'invariant',
      topic: 'session-auth',
      regions: ['packages/backend'],
      body: 'body',
      at: '2024-01-01T00:00:00Z',
    });

    const parsed = await callQueryUnits({ topic: 'session-auth' });
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ topic: 'session-auth' });
  });

  it('names the available topics for a topic not in the vocabulary at all', async () => {
    createUnit({
      title: 'Session credential scope',
      kind: 'invariant',
      topic: 'session-auth',
      regions: ['packages/backend'],
      body: 'body',
      at: '2024-01-01T00:00:00Z',
    });

    const parsed = await callQueryUnits({ topic: 'docs' });
    expect(parsed.units).toEqual([]);
    expect(parsed.topic).toMatchObject({ value: 'docs', recognized: false });
    expect(parsed.topic.availableTopics).toEqual(['session-auth']);
  });

  it('distinguishes a topic that exists but has no active units from one that is not recognized', async () => {
    const unit = createUnit({
      title: 'Deferred design note',
      kind: 'reference',
      topic: 'deferred-topic',
      regions: ['packages/backend'],
      body: 'body',
      at: '2024-01-01T00:00:00Z',
    });
    supersedeUnit(
      unit.id,
      {
        title: 'Replacement note',
        kind: unit.kind,
        topic: 'other-topic',
        regions: unit.regions,
        body: unit.body,
        at: '2024-01-02T00:00:00Z',
      },
      '2024-01-02T00:00:00Z',
    );

    const parsed = await callQueryUnits({ topic: 'deferred-topic' });
    expect(parsed.units).toEqual([]);
    expect(parsed.topic).toEqual({ value: 'deferred-topic', recognized: true });
    expect(parsed.topic.availableTopics).toBeUndefined();
  });

  it('names the available regions for a region that substring-matches nothing stored', async () => {
    createUnit({
      title: 'Session credential scope',
      kind: 'invariant',
      topic: 'session-auth',
      regions: ['packages/backend/src/auth'],
      body: 'body',
      at: '2024-01-01T00:00:00Z',
    });

    const parsed = await callQueryUnits({ region: 'packages/frontend' });
    expect(parsed.units).toEqual([]);
    expect(parsed.region).toMatchObject({
      value: 'packages/frontend',
      recognized: false,
    });
    expect(parsed.region.availableRegions).toEqual([
      'packages/backend/src/auth',
    ]);
  });

  it('distinguishes a region that substring-matches something from one that matches nothing, when other filters still yield zero', async () => {
    createUnit({
      title: 'Session credential scope',
      kind: 'invariant',
      topic: 'session-auth',
      regions: ['packages/backend/src/auth'],
      body: 'body',
      at: '2024-01-01T00:00:00Z',
    });

    const parsed = await callQueryUnits({
      region: 'packages/backend/src/auth',
      kind: 'decision',
    });
    expect(parsed.units).toEqual([]);
    expect(parsed.region).toEqual({
      value: 'packages/backend/src/auth',
      recognized: true,
    });
    expect(parsed.region.availableRegions).toBeUndefined();
  });
});
