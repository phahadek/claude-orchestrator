/**
 * Tests for the verdict-delivery MCP tool surface: review.disposition,
 * flaky.confirm, gate.verify. Each tool delegates to the matching
 * AgentSession.recordXDisposition method rather than duplicating any
 * validation or event-emission logic here — these tests assert the
 * delegation, not the emission internals (covered by
 * session/__tests__/AgentSession.verdictTools.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerVerdictTools } from './verdictTools';
import type { AgentSession } from '../../session/AgentSession';
import { VERIFIER_RECLASSIFY_TARGETS } from '../../session/AgentSession';
import { gateVerifyReclassifyToSchema } from './schemas';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';
import {
  getPRBySessionId,
  evaluateTestFlakinessCorpus,
} from '../../db/queries';
import { getChangedFiles } from '../../session/autofix-runner';
import {
  pauseReasonFromCanonical,
  serializePauseReason,
} from '../../db/pauseReason';

vi.mock('../../db/queries', () => ({
  getPRBySessionId: vi.fn(),
  evaluateTestFlakinessCorpus: vi.fn(),
}));

vi.mock('../../session/autofix-runner', () => ({
  getChangedFiles: vi.fn(),
}));

vi.mock('../../config/settings', () => ({
  typedGetSetting: vi.fn(
    (key: string) =>
      ({
        flip_rate_window_n: 20,
        flip_rate_threshold_k: 2,
        flip_rate_breadth_n: 3,
        flip_rate_breadth_window_hours: 24,
      })[key],
  ),
}));

function fakeSession() {
  return {
    worktreePath: '/fake/worktree',
    recordReviewDisposition: vi.fn(),
    recordReviewVerdict: vi.fn(),
    recordVerifiedFlakyDisposition: vi.fn(),
    recordGateVerifyDisposition: vi
      .fn()
      .mockReturnValue({ id: 'staged-1', milestone: 'M1' }),
    recordDeployAgenticVerdict: vi.fn(),
  } as unknown as AgentSession & {
    recordReviewDisposition: ReturnType<typeof vi.fn>;
    recordReviewVerdict: ReturnType<typeof vi.fn>;
    recordVerifiedFlakyDisposition: ReturnType<typeof vi.fn>;
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
  it('registers review.disposition and flaky.confirm for a non-planning session', async () => {
    const { client, close } = await connectedClient(() => fakeSession(), null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['flaky.confirm', 'review.disposition', 'review.verdict'].sort(),
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

const CI_FAILING_PAUSE = serializePauseReason(
  pauseReasonFromCanonical('ci_failing'),
);
const ANALYZE_FAILING_PAUSE = serializePauseReason(
  pauseReasonFromCanonical('analyze_failing'),
);

describe('flaky.confirm', () => {
  const TEST_ID = 'tests.test_foo.test_something';
  const TEST_NAME = 'test_something';

  beforeEach(() => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
      created_at: '2026-08-01T00:00:00.000Z',
      base_branch: 'dev',
      pause_reason: CI_FAILING_PAUSE,
    } as never);
    vi.mocked(evaluateTestFlakinessCorpus).mockReturnValue({
      testId: TEST_ID,
      eligible: true,
    });
    vi.mocked(getChangedFiles).mockResolvedValue([
      'packages/backend/src/unrelated.ts',
    ]);
  });

  it('returns eligible for a test that clears the cross-SHA corpus and is absent from the diff, with no prior re-run recorded for the session', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: {
        gate: 'f2',
        reason: 'fails across many trees, unrelated to my diff',
        testId: TEST_ID,
        testName: TEST_NAME,
      },
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordVerifiedFlakyDisposition).toHaveBeenCalledWith({
      gate: 'f2',
      reason: 'fails across many trees, unrelated to my diff',
    });
    await close();
  });

  it('delegates to session.recordVerifiedFlakyDisposition for the analyze gate without a testId', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
      created_at: '2026-08-01T00:00:00.000Z',
      base_branch: 'dev',
      pause_reason: ANALYZE_FAILING_PAUSE,
    } as never);
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: { gate: 'analyze', reason: 'unrelated static-analysis flake' },
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordVerifiedFlakyDisposition).toHaveBeenCalledWith({
      gate: 'analyze',
      reason: 'unrelated static-analysis flake',
    });
    await close();
  });

  it('refuses ci/f2 gates without a testId/testName', async () => {
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: { gate: 'f2', reason: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(session.recordVerifiedFlakyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('refuses when the test has not cleared the cross-SHA flakiness corpus', async () => {
    vi.mocked(evaluateTestFlakinessCorpus).mockReturnValue({
      testId: TEST_ID,
      eligible: false,
      reason: 'has not cleared the cross-SHA flakiness bar yet',
    });
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: {
        gate: 'f2',
        reason: 'seems flaky',
        testId: TEST_ID,
        testName: TEST_NAME,
      },
    });
    expect(result.isError).toBe(true);
    expect(resultOf(result as never).error).toContain(
      'has not cleared the cross-SHA flakiness bar yet',
    );
    expect(session.recordVerifiedFlakyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it("refuses when the failing test's own file is in the calling session's diff, naming that file", async () => {
    vi.mocked(getChangedFiles).mockResolvedValue([
      'tests/test_foo.py',
      'packages/backend/src/other.ts',
    ]);
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: {
        gate: 'f2',
        reason: 'seems flaky',
        testId: TEST_ID,
        testName: TEST_NAME,
      },
    });
    expect(result.isError).toBe(true);
    expect(resultOf(result as never).error).toContain('tests/test_foo.py');
    expect(session.recordVerifiedFlakyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('rejects a gate outside ci/f2/analyze', async () => {
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

  it('actuates for gate "ci" when the PR is paused on ci_failing from a pre-review verify failure (post-review CI regression guard)', async () => {
    // beforeEach already sets pause_reason to CI_FAILING_PAUSE — this is the
    // exact shape PreReviewPipeline's verify stage now writes, and is the
    // same shape AutoMerger's post-review CI path writes. Both must actuate
    // identically through this same check.
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: {
        gate: 'ci',
        reason: 'unrelated infra flake',
        testId: TEST_ID,
        testName: TEST_NAME,
      },
    });
    expect(resultOf(result as never)).toEqual({ status: 'ok' });
    expect(session.recordVerifiedFlakyDisposition).toHaveBeenCalledWith({
      gate: 'ci',
      reason: 'unrelated infra flake',
    });
    await close();
  });

  it('refuses gate "ci"/"f2" with an actionable, distinguishable message when the PR is not paused on an automatic ci-source pause (e.g. a pre-review verify failure that never actuates)', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
      created_at: '2026-08-01T00:00:00.000Z',
      base_branch: 'dev',
      pause_reason: null,
    } as never);
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: {
        gate: 'ci',
        reason: 'seems flaky',
        testId: TEST_ID,
        testName: TEST_NAME,
      },
    });
    expect(result.isError).toBe(true);
    const error = resultOf(result as never).error as string;
    expect(error).toContain('"ci"');
    expect(error).toContain('current: none');
    expect(error).not.toContain('cross-SHA flakiness bar');
    expect(error).not.toContain('is in this session');
    expect(session.recordVerifiedFlakyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('refuses gate "analyze" with an actionable message when the PR is not paused on an automatic analyze-source pause', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
      created_at: '2026-08-01T00:00:00.000Z',
      base_branch: 'dev',
      pause_reason: CI_FAILING_PAUSE,
    } as never);
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: { gate: 'analyze', reason: 'unrelated static-analysis flake' },
    });
    expect(result.isError).toBe(true);
    const error = resultOf(result as never).error as string;
    expect(error).toContain('"analyze"');
    expect(error).toContain('current: ci_failing');
    expect(session.recordVerifiedFlakyDisposition).not.toHaveBeenCalled();
    await close();
  });

  it('refuses gate "ci" when the PR is paused on ci_billing_blocked — same source but manual_action, not automatically dischargeable', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'owner/repo',
      created_at: '2026-08-01T00:00:00.000Z',
      base_branch: 'dev',
      pause_reason: serializePauseReason(
        pauseReasonFromCanonical('ci_billing_blocked'),
      ),
    } as never);
    const session = fakeSession();
    const { client, close } = await connectedClient(() => session);
    const result = await client.callTool({
      name: 'flaky.confirm',
      arguments: {
        gate: 'ci',
        reason: 'seems flaky',
        testId: TEST_ID,
        testName: TEST_NAME,
      },
    });
    expect(result.isError).toBe(true);
    const error = resultOf(result as never).error as string;
    expect(error).toContain('current: ci_billing_blocked');
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
