/**
 * Tests for the verdict-delivery MCP tool surface: review.disposition,
 * flaky.confirm, gate.verify. Each tool delegates to the matching
 * AgentSession.recordXDisposition method rather than duplicating any
 * validation or event-emission logic here — these tests assert the
 * delegation, not the emission internals (covered by
 * session/__tests__/AgentSession.verdictTools.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerVerdictTools } from './verdictTools';
import type { AgentSession } from '../../session/AgentSession';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

function fakeSession() {
  return {
    recordReviewDisposition: vi.fn(),
    recordVerifiedFlakyDisposition: vi.fn(),
    recordGateVerifyDisposition: vi.fn(),
  } as unknown as AgentSession & {
    recordReviewDisposition: ReturnType<typeof vi.fn>;
    recordVerifiedFlakyDisposition: ReturnType<typeof vi.fn>;
    recordGateVerifyDisposition: ReturnType<typeof vi.fn>;
  };
}

async function connectedClient(
  getSession: () => AgentSession | undefined,
  workflow: PlanningWorkflow | null = null,
) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerVerdictTools(server, { sessionId: 'session-1', getSession, workflow });
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

function resultOf(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('verdict-delivery MCP tools — registration', () => {
  it('registers review.disposition and flaky.confirm for a non-planning session', async () => {
    const { client, close } = await connectedClient(() => fakeSession(), null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['flaky.confirm', 'review.disposition'].sort(),
    );
    await close();
  });

  it('registers only gate.verify for an ops session', async () => {
    const { client, close } = await connectedClient(() => fakeSession(), 'ops');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['gate.verify']);
    await close();
  });
});

describe('review.disposition', () => {
  it('delegates to session.recordReviewDisposition with the tool-call payload', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'review.disposition',
      arguments: {
        comment_id: 123,
        disposition: 'addressed',
        reason: 'fixed the null check',
      },
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordReviewDisposition).toHaveBeenCalledWith({
      comment_id: 123,
      disposition: 'addressed',
      reason: 'fixed the null check',
    });
    await close();
  });

  it('rejects a disposition outside the addressed/wont_fix/out_of_scope vocabulary', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'review.disposition',
      arguments: { comment_id: 1, disposition: 'maybe' },
    });
    expect(result.isError).toBe(true);
    expect(session.recordReviewDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('returns session_not_live when the session has ended', async () => {
    const { client, close } = await connectedClient(() => undefined);
    const result = await client.callTool({
      name: 'review.disposition',
      arguments: { comment_id: 1, disposition: 'wont_fix' },
    });
    expect(resultOf(result as never)).toEqual({ error: 'session_not_live' });
    await close();
  });
});

describe('flaky.confirm', () => {
  it('delegates to session.recordVerifiedFlakyDisposition', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: { gate: 'ci', reason: 'ran in isolation, passed clean' },
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordVerifiedFlakyDisposition).toHaveBeenCalledWith({
      gate: 'ci',
      reason: 'ran in isolation, passed clean',
    });
    await close();
  });

  it('rejects a gate outside ci/f2', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: { gate: 'staging', reason: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(session.recordVerifiedFlakyDisposition).not.toHaveBeenCalled();
    await close();
  });
});

describe('gate.verify', () => {
  it('delegates to session.recordGateVerifyDisposition', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'pass',
        evidence: { note: 'confirmed via audit_log' },
      },
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordGateVerifyDisposition).toHaveBeenCalledWith({
      gateItemId: 'item-1',
      disposition: 'pass',
      evidence: { note: 'confirmed via audit_log' },
      reclassify: undefined,
    });
    await close();
  });

  it('accepts a reclassify proposal to Human-Observation', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-2',
        disposition: 'needs-setup',
        reclassify: { to: 'Human-Observation', reason: 'renders a UI block' },
      },
    });
    expect(session.recordGateVerifyDisposition).toHaveBeenCalledWith({
      gateItemId: 'item-2',
      disposition: 'needs-setup',
      evidence: undefined,
      reclassify: { to: 'Human-Observation', reason: 'renders a UI block' },
    });
    await close();
  });

  it('rejects a reclassify target outside Human-Observation/needs-triage', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-3',
        disposition: 'needs-setup',
        reclassify: { to: 'Read-Only', reason: 'looks headless' },
      },
    });
    expect(result.isError).toBe(true);
    expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
    await close();
  });
});
