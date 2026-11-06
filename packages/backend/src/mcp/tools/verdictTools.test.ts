/**
 * Tests for the verdict-delivery MCP tool surface: review.disposition,
 * review.verdict, gate.verify, deploy.verdict. Each tool delegates to the matching
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
    worktreePath: '/fake/worktree',
    recordReviewDisposition: vi.fn(),
    recordReviewVerdict: vi.fn(),
    recordGateVerifyDisposition: vi
      .fn()
      .mockReturnValue({ id: 'staged-1', milestone: 'M1' }),
    recordDeployAgenticVerdict: vi.fn(),
  } as unknown as AgentSession & {
    recordReviewDisposition: ReturnType<typeof vi.fn>;
    recordReviewVerdict: ReturnType<typeof vi.fn>;
    recordGateVerifyDisposition: ReturnType<typeof vi.fn>;
    recordDeployAgenticVerdict: ReturnType<typeof vi.fn>;
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
  it('registers review.disposition and review.verdict, and no flaky.confirm, for a non-planning session', async () => {
    const { client, close } = await connectedClient(() => fakeSession(), null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['review.disposition', 'review.verdict'].sort(),
    );
    await close();
  });

  it('registers gate.verify and deploy.verdict for an ops session', async () => {
    const { client, close } = await connectedClient(() => fakeSession(), 'ops');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'deploy.verdict',
      'gate.verify',
    ]);
    await close();
  });

  it("gate.verify's description states the full-uuid gateItemId requirement", async () => {
    const { client, close } = await connectedClient(() => fakeSession(), 'ops');
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'gate.verify');
    expect(tool?.description).toMatch(/full gate item uuid/i);
    expect(tool?.description).toMatch(/8-character short form/i);
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

describe('review.verdict', () => {
  const validArgs = {
    verdict: 'approved',
    dimensions: [{ name: 'Diff vs Context spec', passed: true, notes: 'ok' }],
    summary: 'Looks good.',
  };

  it('delegates to session.recordReviewVerdict with the tool-call payload', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'review.verdict',
      arguments: validArgs,
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordReviewVerdict).toHaveBeenCalledWith({
      verdict: 'approved',
      dimensions: validArgs.dimensions,
      summary: 'Looks good.',
      manualItemsForHuman: undefined,
      escalate: undefined,
      escalationReason: undefined,
    });
    await close();
  });

  it('rejects a payload missing verdict as a tool error, not a silent drop', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'review.verdict',
      arguments: { dimensions: [], summary: 'no verdict field' },
    });
    expect(result.isError).toBe(true);
    expect(session.recordReviewVerdict).not.toHaveBeenCalled();
    await close();
  });

  it('rejects a payload missing summary as a tool error, not a silent drop', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'review.verdict',
      arguments: { verdict: 'approved', dimensions: [] },
    });
    expect(result.isError).toBe(true);
    expect(session.recordReviewVerdict).not.toHaveBeenCalled();
    await close();
  });

  it('rejects a verdict outside the approved/needs_changes/incomplete/error vocabulary', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'review.verdict',
      arguments: { ...validArgs, verdict: 'maybe' },
    });
    expect(result.isError).toBe(true);
    expect(session.recordReviewVerdict).not.toHaveBeenCalled();
    await close();
  });

  it('a second call in the same iteration is last-write-wins and does not throw', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const first = await client.callTool({
      name: 'review.verdict',
      arguments: validArgs,
    });
    const second = await client.callTool({
      name: 'review.verdict',
      arguments: { ...validArgs, verdict: 'needs_changes' },
    });
    expect(resultOf(first as never)).toEqual({ status: 'ok' });
    expect(resultOf(second as never)).toEqual({ status: 'ok' });
    expect(session.recordReviewVerdict).toHaveBeenCalledTimes(2);
    await close();
  });

  it('returns session_not_live when the session has ended', async () => {
    const { client, close } = await connectedClient(() => undefined);
    const result = await client.callTool({
      name: 'review.verdict',
      arguments: validArgs,
    });
    expect(resultOf(result as never)).toEqual({ error: 'session_not_live' });
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

  it('accepts a not-yet-triggerable disposition (the parking abstain)', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'not-yet-triggerable',
        evidence: {
          expected: 'The nightly backfill has run at least once.',
          found: 'No audit_log entry for this job yet — it has not run.',
          query: 'auditLog.query projectId=proj-1 action=nightly_backfill',
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
      disposition: 'not-yet-triggerable',
      evidence: {
        expected: 'The nightly backfill has run at least once.',
        found: 'No audit_log entry for this job yet — it has not run.',
        query: 'auditLog.query projectId=proj-1 action=nightly_backfill',
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
        proposedFix: { existingTaskId: 'notion:abc' },
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
      proposedFix: { existingTaskId: 'notion:abc' },
    });
    await close();
  });

  it('rejects a fail without proposedFix', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-1',
        disposition: 'fail',
        evidence: { expected: 'x', found: 'y', query: 'z' },
      },
    });
    expect(result.isError).toBe(true);
    expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
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

  it('accepts a reclassify proposal to needs-triage', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    await client.callTool({
      name: 'gate.verify',
      arguments: {
        gateItemId: 'item-4',
        disposition: 'needs-setup',
        reclassify: {
          to: 'needs-triage',
          reason: 'cannot tell what tier fits',
        },
      },
    });
    expect(session.recordGateVerifyDisposition).toHaveBeenCalledWith({
      gateItemId: 'item-4',
      disposition: 'needs-setup',
      evidence: undefined,
      reclassify: {
        to: 'needs-triage',
        reason: 'cannot tell what tier fits',
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

  it('accepts a proposedFix when disposition is fail', async () => {
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
        },
        proposedFix: {
          title: 'Fix the widget creation audit write',
          cause: {
            file: 'packages/backend/src/widgets.ts',
            line: 10,
            condition: 'widget_created returns before the audit write',
          },
          input: 'widget 42 created at 2026-10-14',
          fix: 'write the audit_log row before returning',
          filesAffected: ['packages/backend/src/widgets.ts'],
          automatedCriteria: ['creating a widget writes an audit_log row'],
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
      },
      reclassify: undefined,
      proposedFix: {
        title: 'Fix the widget creation audit write',
        cause: {
          file: 'packages/backend/src/widgets.ts',
          line: 10,
          condition: 'widget_created returns before the audit write',
        },
        input: 'widget 42 created at 2026-10-14',
        fix: 'write the audit_log row before returning',
        filesAffected: ['packages/backend/src/widgets.ts'],
        automatedCriteria: ['creating a widget writes an audit_log row'],
      },
    });
    await close();
  });

  it('rejects a proposedFix when disposition is pass', async () => {
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
        },
        proposedFix: {
          title: 'Fix the widget creation audit write',
          cause: {
            file: 'packages/backend/src/widgets.ts',
            line: 10,
            condition: 'widget_created returns before the audit write',
          },
          input: 'widget 42 created at 2026-10-14',
          fix: 'write the audit_log row before returning',
          filesAffected: ['packages/backend/src/widgets.ts'],
          automatedCriteria: ['creating a widget writes an audit_log row'],
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(session.recordGateVerifyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('keeps VERIFIER_RECLASSIFY_TARGETS and gateVerifyReclassifyToSchema in sync', () => {
    expect(new Set(gateVerifyReclassifyToSchema.options)).toEqual(
      VERIFIER_RECLASSIFY_TARGETS,
    );
  });
});

describe('deploy.verdict', () => {
  it('delegates to session.recordDeployAgenticVerdict', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'deploy.verdict',
      arguments: { verdict: 'approved', detail: 'looks healthy' },
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordDeployAgenticVerdict).toHaveBeenCalledWith({
      verdict: 'approved',
      detail: 'looks healthy',
    });
    await close();
  });

  it('surfaces a non-deploy-agentic session (e.g. task_id mismatch) as an error, not a bare ok', async () => {
    const session = fakeSession();
    session.recordDeployAgenticVerdict.mockImplementation(() => {
      throw new Error(
        'recordDeployAgenticVerdict: session task_id "gate-item:x" is not a deploy-agentic task',
      );
    });
    const { client, close } = await connectedClient(() => session, 'ops');
    const result = await client.callTool({
      name: 'deploy.verdict',
      arguments: { verdict: 'inconclusive' },
    });
    expect(result.isError).toBe(true);
    expect(resultOf(result as never).error).toMatch(
      /not a deploy-agentic task/,
    );
    await close();
  });

  it('is not registered for a non-planning (null workflow) session', async () => {
    const { client, close } = await connectedClient(() => fakeSession(), null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('deploy.verdict');
    await close();
  });
});
