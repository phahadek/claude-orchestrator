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

// Every taskId referenced across these tests is a fixture, not a real board
// task — stub the backend so stage-time task-reference validation (see
// validateAndNormalizeTaskReferences) resolves it rather than rejecting.
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nok'),
  })),
}));

import { db } from '../../db/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerStageProposalTools } from './stageProposalTools';
import { getStagedIntent, listStagedIntentsByGroup } from '../../db/queries';
import {
  gateContributionDecisionSchema,
  gateContributionItemInputSchema,
} from './schemas';
import { GATE_ITEM_TIER_SELECTION_GUIDANCE } from '../../gate/gateItemClassificationGuidance';

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
  it('registers exactly the 16 stage-proposal tool names', async () => {
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
        'intent.withdraw',
        'journal.setState',
        'planning.noOp',
        'seed.stage',
        'session.requestCapability',
        'task.create',
        'task.patchBodySection',
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

  it('task.setStatus rejects a groomingGate.triage.proposedVerdict outside the TriageVerdict taxonomy', async () => {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'task.setStatus',
      arguments: {
        payload: {
          taskId: 't-1',
          status: 'Ready',
          groomingGate: {
            triage: {
              proposedVerdict: 'Ready',
              hasOpenQuestionsHeading: true,
            },
          },
        },
      },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/proposedVerdict/);
    expect(text).toMatch(/clean/);
    expect(text).toMatch(/blocked/);
    expect(text).toMatch(/needs-attention/);
    expect(db.prepare('SELECT COUNT(*) as n FROM staged_intent').get()).toEqual(
      { n: 0 },
    );
    await close();
  });

  it.each(['clean', 'blocked', 'needs-attention'] as const)(
    'task.setStatus accepts a groomingGate.triage.proposedVerdict of %s',
    async (proposedVerdict) => {
      const { client, close } = await connectedClient();
      const result = await client.callTool({
        name: 'task.setStatus',
        arguments: {
          payload: {
            taskId: 't-1',
            status: 'Ready',
            groomingGate: {
              triage: {
                proposedVerdict,
                hasOpenQuestionsHeading: true,
              },
            },
          },
        },
      });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      const intent = parseIntentResult(
        result as { content: Array<{ type: string; text?: string }> },
      );
      expect(intent.kind).toBe('task.setStatus');
      await close();
    },
  );

  it('task.create accepts an optional body and stages it verbatim in the payload', async () => {
    const { client, close } = await connectedClient();
    const body = '## Summary\nDo the thing.';
    const result = await client.callTool({
      name: 'task.create',
      arguments: { payload: { title: 'New task', body } },
    });
    const intent = parseIntentResult(
      result as { content: Array<{ type: string; text?: string }> },
    );
    expect(intent.kind).toBe('task.create');
    expect((intent.payload as { body?: string }).body).toBe(body);
    await close();
  });

  it('task.create tool description no longer directs callers to task.updateBody for a new task', async () => {
    const { client, close } = await connectedClient();
    const { tools } = await client.listTools();
    const createTool = tools.find((t) => t.name === 'task.create');
    expect(createTool?.description).toBeDefined();
    expect(createTool!.description).not.toMatch(
      /set separately via task\.updateBody/i,
    );
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

  it("intent.withdraw moves this session's own staged intent to a terminal withdrawn state", async () => {
    const { client, close } = await connectedClient();
    const created = await client.callTool({
      name: 'task.create',
      arguments: { payload: { title: 'A mistaken proposal' } },
    });
    const intent = parseIntentResult(
      created as { content: Array<{ type: string; text?: string }> },
    );

    const result = await client.callTool({
      name: 'intent.withdraw',
      arguments: {
        payload: {
          intentId: intent.id,
          reason: 'staged against the wrong task by mistake',
        },
      },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const withdrawn = parseIntentResult(
      result as { content: Array<{ type: string; text?: string }> },
    );
    expect(withdrawn.state).toBe('withdrawn');
    expect(withdrawn.dispositionReason).toBe(
      'staged against the wrong task by mistake',
    );

    const stored = getStagedIntent(intent.id as string);
    expect(stored?.state).toBe('withdrawn');
    await close();
  });

  it("intent.withdraw rejects withdrawing another session's intent", async () => {
    const { client, close } = await connectedClient();
    const created = await client.callTool({
      name: 'task.create',
      arguments: { payload: { title: "Someone else's proposal" } },
    });
    const intent = parseIntentResult(
      created as { content: Array<{ type: string; text?: string }> },
    );

    // registerStageProposalTools is scoped per-connection to a fixed
    // ctx.sessionId — simulate a different staging session by mutating the
    // stored row's session_id directly, rather than this connection's own.
    db.prepare('UPDATE staged_intent SET session_id = ? WHERE id = ?').run(
      'a-different-session',
      intent.id,
    );

    const result = await client.callTool({
      name: 'intent.withdraw',
      arguments: {
        payload: { intentId: intent.id, reason: 'not mine to withdraw' },
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    await close();
  });
});

describe('stage-proposal MCP tools — envelope fields misplaced inside payload', () => {
  const SAMPLE_GROOM_PROPOSAL = {
    achieves: 'Flips the task to Ready.',
    openQuestions: 'None.',
    automatedTests: 'Existing suite covers it.',
    manualVerification: 'n/a',
    operationalSeed: 'n/a',
  };

  it('rejects a groomProposal nested inside payload, naming the key and where it belongs', async () => {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'task.setStatus',
      arguments: {
        payload: {
          taskId: 't-1',
          status: 'Ready',
          groomProposal: SAMPLE_GROOM_PROPOSAL,
        },
      },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/groomProposal/);
    expect(text).toMatch(/alongside payload/);
    expect(db.prepare('SELECT COUNT(*) as n FROM staged_intent').get()).toEqual(
      { n: 0 },
    );
    await close();
  });

  it.each(['decisionProposal', 'groupId', 'supersedes'])(
    'rejects %s nested inside payload the same way',
    async (envelopeField) => {
      const { client, close } = await connectedClient();
      const result = (await client.callTool({
        name: 'task.setStatus',
        arguments: {
          payload: {
            taskId: 't-1',
            status: 'Ready',
            [envelopeField]: 'should have been a sibling of payload',
          },
        },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(result.isError).toBe(true);
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(new RegExp(envelopeField));
      expect(text).toMatch(/alongside payload/);
      await close();
    },
  );

  it('stages exactly as before when groomProposal is passed as a sibling of payload', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'task.setStatus',
      arguments: {
        payload: { taskId: 't-1', status: 'Ready' },
        groomProposal: SAMPLE_GROOM_PROPOSAL,
      },
    });
    const intent = parseIntentResult(
      result as { content: Array<{ type: string; text?: string }> },
    );
    expect(intent.groomProposal).toEqual(SAMPLE_GROOM_PROPOSAL);
    const stored = getStagedIntent(intent.id as string);
    expect(
      stored?.groom_proposal ? JSON.parse(stored.groom_proposal) : null,
    ).toEqual(SAMPLE_GROOM_PROPOSAL);
    await close();
  });

  it('still fails with the existing error when a required payload field is missing', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'gate.accrete',
      arguments: {
        payload: {
          items: [{ text: 'an item' }],
          classification: 'Read-Only',
        },
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text =
      (result as { content: Array<{ type: string; text?: string }> })
        .content[0]?.text ?? '';
    expect(text).toMatch(/sourceTask/);
    await close();
  });

  it('rejects an unrecognized key inside payload that is not an envelope field', async () => {
    const { client, close } = await connectedClient();
    const result = (await client.callTool({
      name: 'task.setDependsOn',
      arguments: {
        payload: { taskId: 't-1', dependsOn: [], triage: 'clean' },
      },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toMatch(/triage/);
    await close();
  });

  it('every tool registered through envelope() rejects an unknown payload key', async () => {
    const ENVELOPE_TOOL_PAYLOADS: Record<string, Record<string, unknown>> = {
      'task.create': { title: 'New task' },
      'task.setStatus': { taskId: 't-1', status: 'Ready' },
      'task.setDependsOn': { taskId: 't-1', dependsOn: [] },
      'task.updateBody': {
        taskId: 't-1',
        sections: {
          summary: 's',
          dependencies: [],
          context: [],
          automatedCriteria: [],
          manualCriteria: [],
        },
      },
      'task.setProperties': { taskId: 't-1', patch: {} },
      'gate.accrete': {
        sourceTask: { id: 't-1', title: 'Task', project: 'p', milestone: 'm' },
        items: [{ text: 'an item' }],
        classification: 'Read-Only',
      },
      'seed.stage': {
        sourceTask: { id: 't-1', title: 'Task', project: 'p', milestone: 'm' },
        seeds: [{ spec: 'a seed' }],
        decision: 'seeds',
      },
      'arch.createUnit': {
        title: 'A unit',
        metadata: { kind: 'subsystem', topic: 't', regions: [] },
        body: 'body',
      },
      'arch.updateUnit': { unitId: 'u-1', baseVersion: 1 },
      'arch.supersedeUnit': {
        unitId: 'u-1',
        baseVersion: 1,
        replacement: {
          title: 'A unit',
          metadata: { kind: 'subsystem', topic: 't', regions: [] },
          body: 'body',
        },
      },
      'decision.pickOne': {
        prompt: 'Which?',
        options: [{ label: 'A', description: 'a' }],
        allowFreeForm: false,
      },
      'journal.setState': { taskId: 't-1', state: 'pending' },
      'session.requestCapability': {
        capability: 'x',
        plan: 'y',
        evidence: 'z',
      },
      'planning.noOp': { taskId: 't-1', reason: 'nothing to do' },
    };

    const { client, close } = await connectedClient();
    for (const [name, payload] of Object.entries(ENVELOPE_TOOL_PAYLOADS)) {
      const result = (await client.callTool({
        name,
        arguments: { payload: { ...payload, bogusExtraKey: 'nope' } },
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(result.isError, `${name} should reject an unknown payload key`).toBe(
        true,
      );
      expect(result.content[0]?.text ?? '').toMatch(/bogusExtraKey/);
    }
    await close();
  });
});

describe('gate.accrete — classification tier guidance', () => {
  const REAL_TIERS = [
    'Read-Only',
    'Prod-Mutating',
    'Opportunistic',
    'Human-Observation',
  ];

  it('the batch-level classification field exposes a non-empty description naming all four real tiers', () => {
    const description = gateContributionDecisionSchema.description;
    expect(description).toBeTruthy();
    for (const tier of REAL_TIERS) {
      expect(description).toContain(tier);
    }
  });

  it('the per-item classification field exposes the same tier guidance', () => {
    const description =
      gateContributionItemInputSchema.shape.classification.description;
    expect(description).toBeTruthy();
    for (const tier of REAL_TIERS) {
      expect(description).toContain(tier);
    }
  });

  it('the tier guidance states the live-session-vs-human-observation distinction', () => {
    const description = gateContributionDecisionSchema.description ?? '';
    expect(description).toMatch(/live dispatched session/);
    expect(description).toMatch(/not Human-Observation/);
    expect(description).toMatch(/session_events/);
  });

  it('the gate.accrete tool description carries the tier-selection guidance', async () => {
    const { client, close } = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'gate.accrete');
    expect(tool?.description).toContain(GATE_ITEM_TIER_SELECTION_GUIDANCE);
    await close();
  });

  it('the schema field description and the tool description are sourced from the same shared constant (no drift)', async () => {
    const { client, close } = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'gate.accrete');

    expect(gateContributionDecisionSchema.description).toContain(
      GATE_ITEM_TIER_SELECTION_GUIDANCE,
    );
    expect(
      gateContributionItemInputSchema.shape.classification.description,
    ).toContain(GATE_ITEM_TIER_SELECTION_GUIDANCE);
    expect(tool?.description).toContain(GATE_ITEM_TIER_SELECTION_GUIDANCE);
    await close();
  });
});
