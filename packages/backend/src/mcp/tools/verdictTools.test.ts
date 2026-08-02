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
import { VERIFIER_RECLASSIFY_TARGETS } from '../../session/AgentSession';
import { gateVerifyReclassifyToSchema } from './schemas';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

function fakeSession() {
  return {
    recordReviewDisposition: vi.fn(),
    recordVerifiedFlakyDisposition: vi.fn(),
    recordGateVerifyDisposition: vi
      .fn()
      .mockReturnValue({ id: 'staged-1', milestone: 'M1' }),
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
  registerVerdictTools(server, {
    sessionId: 'session-1',
    getSession,
    workflow,
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
        evidence: {
          expected: 'The endpoint records an audit_log row on success.',
          found: 'audit_log shows one matching row from the last run.',
          query: 'auditLog.query projectId=proj-1 action=widget_created',
        },
      },
    });
    expect(resultOf(result as never)).toEqual({
      status: 'ok',
      id: 'staged-1',
      milestone: 'M1',
    });
    expect(session.recordGateVerifyDisposition).toHaveBeenCalledWith({
      gateItemId: 'item-1',
      disposition: 'pass',
      evidence: {
        expected: 'The endpoint records an audit_log row on success.',
        found: 'audit_log shows one matching row from the last run.',
        query: 'auditLog.query projectId=proj-1 action=widget_created',
      },
      reclassify: undefined,
    });
    await close();
  });

  it('surfaces a not-found gateItemId (e.g. a short/truncated form) as an error, not a bare ok', async () => {
    const session = fakeSession();
    session.recordGateVerifyDisposition.mockImplementation(() => {
      throw new Error(
        'no gate item "short-id" — gateItemId must be the full gate_item id',
      );
    });
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'short-id',
        disposition: 'pass',
        evidence: { expected: 'x', found: 'y', query: 'z' },
      },
    });
    expect(result.isError).toBe(true);
    expect(resultOf(result as never).error).toMatch(/full gate_item id/);
    await close();
  });

  it('rejects evidence missing expected/found/query', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'pass',
        evidence: { expected: 'x', found: 'y' },
      },
    });
    expect(result.isError).toBe(true);
    expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('rejects an evidence line over the single-line cap', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'pass',
        evidence: {
          expected: 'x'.repeat(300),
          found: 'y',
          query: 'z',
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('rejects evidence.source when disposition is pass', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'pass',
        evidence: {
          expected: 'x',
          found: 'y',
          query: 'z',
          source: 'packages/backend/src/gate/gateStore.ts:12',
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('rejects evidence.source when disposition is needs-setup', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'needs-setup',
        evidence: {
          expected: 'x',
          found: 'nothing found',
          query: 'z',
          source: 'packages/backend/src/gate/gateStore.ts:12',
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('accepts evidence.source when disposition is fail', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'fail',
        evidence: {
          expected: 'x',
          found: 'the record shows the opposite',
          query: 'z',
          source: 'packages/backend/src/gate/gateStore.ts:12',
        },
      },
    });
    expect(resultOf(result as never)).toEqual({
      status: 'ok',
      id: 'staged-1',
      milestone: 'M1',
    });
    expect(session.recordGateVerifyDisposition).toHaveBeenCalledWith({
      gateItemId: 'item-1',
      disposition: 'fail',
      evidence: {
        expected: 'x',
        found: 'the record shows the opposite',
        query: 'z',
        source: 'packages/backend/src/gate/gateStore.ts:12',
      },
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

  it('accepts a reclassify proposal to Opportunistic', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-4',
        disposition: 'needs-setup',
        reclassify: {
          to: 'Opportunistic',
          reason: 'the triggering condition has not happened yet',
        },
      },
    });
    expect(session.recordGateVerifyDisposition).toHaveBeenCalledWith({
      gateItemId: 'item-4',
      disposition: 'needs-setup',
      evidence: undefined,
      reclassify: {
        to: 'Opportunistic',
        reason: 'the triggering condition has not happened yet',
      },
    });
    await close();
  });

  it.each(['Read-Only', 'Prod-Mutating'])(
    'rejects a reclassify target of %s',
    async (to) => {
      const session = fakeSession();
      const { client, close } = await connectedClient(() => session, 'ops');
      const result = await client.callTool({
        name: 'gate.verify',
        arguments: {
          gateItemId: 'item-3',
          disposition: 'needs-setup',
          reclassify: { to, reason: 'looks headless' },
        },
      });
      expect(result.isError).toBe(true);
      expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
      await close();
    },
  );

  it('keeps VERIFIER_RECLASSIFY_TARGETS and gateVerifyReclassifyToSchema in sync', () => {
    expect(new Set(gateVerifyReclassifyToSchema.options)).toEqual(
      VERIFIER_RECLASSIFY_TARGETS,
    );
  });
});
