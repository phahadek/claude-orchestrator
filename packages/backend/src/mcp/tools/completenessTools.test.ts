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

import { db } from '../../db/db.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCompletenessTools } from './completenessTools';
import { listCompletenessDispositions } from '../../db/queries';
import type { PlanningWorkflow } from '../../planning/planningIntentKinds';

beforeEach(() => {
  db.prepare('DELETE FROM completeness_disposition').run();
});

async function connectedClient(workflow: PlanningWorkflow | null = 'design') {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerCompletenessTools(server, { sessionId: 'session-1', workflow });
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
        questions: [
          {
            question: 'Should X be configurable?',
            disposition: 'dismissed',
            reason: 'Out of scope.',
          },
        ],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });

    const body = resultOf(result as never);
    expect(body.source_task_id).toBe('notion:design1');

    const rows = listCompletenessDispositions('notion:design1');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].questions)).toEqual([
      {
        question: 'Should X be configurable?',
        disposition: 'dismissed',
        reason: 'Out of scope.',
        approvalStatus: 'proposed',
      },
    ]);
    await close();
  });

  it('defaults approvalStatus to proposed when omitted', async () => {
    const { client, close } = await connectedClient();
    await client.callTool({
      name: 'completeness.disposition',
      arguments: {
        taskId: 'notion:design2',
        questions: [
          { question: 'Q?', disposition: 'accepted', reason: 'resolved' },
        ],
        runAt: '2026-07-28T00:00:00.000Z',
      },
    });
    const rows = listCompletenessDispositions('notion:design2');
    expect(JSON.parse(rows[0].questions)[0].approvalStatus).toBe('proposed');
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
