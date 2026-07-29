/**
 * Tests for the design completeness-safeguard MCP tool surface:
 * completeness.disposition (direct write) and completeness.traceCoverage
 * (advisory read). AC: a disposition persists and reads back via the same
 * store helper the device-authed HTTP route (routes/design.ts) uses, and
 * trace-coverage never throws for a task with no coverage data.
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
import { registerCompletenessTools } from './completenessTools';
import {
  listCompletenessDispositions,
  listStagedIntentsByProject,
  upsertTaskCache,
} from '../../db/queries';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

const PROBED = ['unstated-premises'];

beforeEach(() => {
  db.prepare('DELETE FROM completeness_disposition').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM task_cache').run();
  for (const taskId of [
    'notion:design1',
    'notion:design2',
    'notion:design3',
    'notion:design4',
    'notion:design5',
  ]) {
    upsertTaskCache(taskId, JSON.stringify({ type: '📐 Design' }));
  }
});

async function connectedClient(
  workflow: PlanningWorkflow | null = 'design',
  projectId?: string,
) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerCompletenessTools(server, {
    sessionId: 'session-1',
    workflow,
    projectId,
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

describe('completeness tool registration', () => {
  it('registers both tools for a design session', async () => {
    const { client, close } = await connectedClient('design');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['completeness.disposition', 'completeness.traceCoverage'].sort(),
    );
    await close();
  });

  it('registers neither tool for a non-design session', async () => {
    const { client, close } = await connectedClient('ops');
    // No tool capability at all is registered on this connection (the
    // server declares tools/list only once a tool exists), so listing
    // itself is unsupported — the strongest possible "no tools" signal.
    await expect(client.listTools()).rejects.toThrow('Method not found');
    await close();
  });

  it('registers neither tool for a non-planning session', async () => {
    const { client, close } = await connectedClient(null);
    await expect(client.listTools()).rejects.toThrow('Method not found');
    await close();
  });
});

describe('completeness.disposition', () => {
  it('persists a row to completeness_disposition, readable back via the store helper the HTTP route uses', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design1',
        project: 'demo',
        milestone: 'M13',
        probed: PROBED,
        questions: [
          {
            question: 'Should X be configurable?',
            disposition: 'out-of-scope',
            reason: 'Out of scope.',
          },
        ],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });

    const body = resultOf(result as never);
    expect(body.source_task_id).toBe('notion:design1');
    expect(body.probed).toEqual(PROBED);

    const rows = listCompletenessDispositions('notion:design1');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].questions)).toEqual({
      probed: PROBED,
      questions: [
        {
          question: 'Should X be configurable?',
          disposition: 'out-of-scope',
          reason: 'Out of scope.',
          approvalStatus: 'proposed',
        },
      ],
    });
    await close();
  });

  it('round-trips each of the six named dispositions', async () => {
    const named = [
      'resolved',
      'out-of-scope',
      'not-a-decision',
      'fold',
      'file-sibling',
      'sibling-owned',
    ] as const;
    const { client, close } = await connectedClient();
    for (const disposition of named) {
      const result = await client.callTool({
        name: 'completeness.disposition',
        arguments: {
          taskId: 'notion:design1',
          probed: PROBED,
          questions: [{ question: 'Q?', disposition, reason: 'r' }],
          runAt: '2026-07-28T00:00:00.000Z',
        },
      });
      const body = resultOf(result as never) as {
        questions: Array<{ disposition: string }>;
      };
      expect(body.questions[0].disposition).toBe(disposition);
    }
    await close();
  });

  it('rejects a legacy accepted/dismissed value — not one of the six named dispositions', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design1',
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'accepted', reason: 'resolved' },
        ],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });
    expect(result.isError).toBeTruthy();
    await close();
  });

  it('rejects an empty probed array — a clean pass must still name what it checked', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design1',
        probed: [],
        questions: [],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });
    expect(result.isError).toBeTruthy();
    expect(listCompletenessDispositions('notion:design1')).toHaveLength(0);
    await close();
  });

  it('records a clean pass as an affirmative statement of what was probed', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design1',
        probed: [
          'durability-failure-modes',
          'dual-read-consumer-set',
          'interaction-bugs',
          'missing-scaffolding',
          'state-mutation-granularity',
          'unstated-premises',
        ],
        questions: [],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });
    const body = resultOf(result as never) as {
      probed: string[];
      questions: unknown[];
    };
    expect(body.probed).toHaveLength(6);
    expect(body.questions).toEqual([]);
    await close();
  });

  it('rejects a task id that does not resolve, and writes no row', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:does-not-exist',
        probed: PROBED,
        questions: [],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });
    expect(result.isError).toBeTruthy();
    expect(listCompletenessDispositions('notion:does-not-exist')).toHaveLength(
      0,
    );
    await close();
  });

  it('rejects a malformed/non-timestamp runAt', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design1',
        probed: PROBED,
        questions: [],
        runAt: 'not-a-timestamp',
      },
    });
    expect(result.isError).toBeTruthy();
    await close();
  });

  it('defaults approvalStatus to proposed when omitted', async () => {
    const { client, close } = await connectedClient();
    await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design2',
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'resolved', reason: 'resolved' },
        ],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });
    const rows = listCompletenessDispositions('notion:design2');
    expect(JSON.parse(rows[0].questions).questions[0].approvalStatus).toBe(
      'proposed',
    );
    await close();
  });

  it('normalizes a date-only runAt to a full ISO timestamp', async () => {
    const { client, close } = await connectedClient();
    await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design3',
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'resolved', reason: 'resolved' },
        ],
        runAt: '2026-07-28',
      },
    });
    const rows = listCompletenessDispositions('notion:design3');
    expect(rows[0].run_at).toBe('2026-07-28T00:00:00.000Z');
    await close();
  });

  it('also stages a completeness.disposition intent for operator approval when the session resolves to a project', async () => {
    const { client, close } = await connectedClient('design', 'proj-1');
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design4',
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'resolved', reason: 'resolved' },
        ],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });

    const body = resultOf(result as never) as { intent: { id: string } };
    expect(body.intent).toBeTruthy();

    const intents = listStagedIntentsByProject('proj-1');
    expect(intents).toHaveLength(1);
    expect(intents[0].kind).toBe('completeness.disposition');
    expect(intents[0].session_id).toBe('session-1');
    expect(intents[0].state).toBe('staged');
    await close();
  });

  it('stages no intent when the session resolves to no project — the durable write still happens', async () => {
    const { client, close } = await connectedClient('design');
    const result = await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design5',
        probed: PROBED,
        questions: [
          { question: 'Q?', disposition: 'resolved', reason: 'resolved' },
        ],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });

    const body = resultOf(result as never) as {
      intent: unknown;
      source_task_id: string;
    };
    expect(body.intent).toBeNull();
    expect(body.source_task_id).toBe('notion:design5');
    expect(listCompletenessDispositions('notion:design5')).toHaveLength(1);
    await close();
  });
});

describe('completeness.traceCoverage', () => {
  it('does not throw and returns an empty flags result for a task with no coverage data', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.traceCoverage',
      arguments: {
        taskId: 'notion:design1',
        acceptanceCriteria: [],
        lockedDecisions: [],
        followOnTasks: [],
        worklistOptions: { trackedFiles: [] },
      },
    });
    expect(result.isError).toBeFalsy();
    const body = resultOf(result as never);
    expect(body.flags).toEqual([]);
    await close();
  });

  it('flags an acceptance criterion that traces to no locked decision', async () => {
    const { client, close } = await connectedClient();
    const result = await client.callTool({
      name: 'completeness.traceCoverage',
      arguments: {
        taskId: 'notion:design1',
        acceptanceCriteria: ['Widgets must render in under 100ms'],
        lockedDecisions: [],
        followOnTasks: [],
        worklistOptions: { trackedFiles: [] },
      },
    });
    const body = resultOf(result as never) as { flags: unknown[] };
    expect(body.flags.length).toBeGreaterThan(0);
    await close();
  });
});
