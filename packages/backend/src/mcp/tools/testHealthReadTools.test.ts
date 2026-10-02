/**
 * Tests for `testHealth.getFlakyHistory`: requires testIds and returns exactly
 * one flip-rate entry per distinct requested id, in request order.
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
import { typedGetSetting } from '../../config/settings';
import { registerTestHealthReadTools } from './testHealthReadTools';

const PROJECT_ID = 'proj-1';

beforeEach(() => {
  db.prepare('DELETE FROM flagged_flaky_tests_rollup').run();
  db.prepare('DELETE FROM base_health_remediation_test_tracking').run();
});

function insertRollupRow(opts: {
  projectId: string;
  testId: string;
  sampleCount: number;
  transitionCount: number;
}): void {
  db.prepare(
    `INSERT INTO flagged_flaky_tests_rollup
       (project_id, test_id, name, sample_count, transition_count, computed_at)
     VALUES (@project_id, @test_id, @name, @sample_count, @transition_count, @computed_at)`,
  ).run({
    project_id: opts.projectId,
    test_id: opts.testId,
    name: `${opts.testId}.ts`,
    sample_count: opts.sampleCount,
    transition_count: opts.transitionCount,
    computed_at: 1700000000000,
  });
}

function insertTrackingRow(testId: string): void {
  db.prepare(
    `INSERT INTO base_health_remediation_test_tracking
       (project_id, test_id, remediation_task_id, remediation_task_open, created_at, updated_at)
     VALUES (@project_id, @test_id, 'notion:task-1', 1, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z')`,
  ).run({ project_id: PROJECT_ID, test_id: testId });
}

async function connectedClient() {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerTestHealthReadTools(server, { projectId: PROJECT_ID });
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

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  const { client, close } = await connectedClient();
  try {
    return (await client.callTool({
      name: 'testHealth.getFlakyHistory',
      arguments: args,
    })) as ToolResult;
  } finally {
    await close();
  }
}

function entriesOf(result: ToolResult): Record<string, unknown>[] {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content');
  return (JSON.parse(text) as { entries: Record<string, unknown>[] }).entries;
}

describe('testHealth.getFlakyHistory', () => {
  it('rejects a call with no testIds', async () => {
    const result = await call({});
    expect(result.isError).toBe(true);
  });

  it('rejects an empty testIds array', async () => {
    const result = await call({ testIds: [] });
    expect(result.isError).toBe(true);
  });

  it('returns one entry per distinct id in request order, collapsing duplicates', async () => {
    const result = await call({ testIds: ['b', 'a', 'b', 'c'] });
    expect(entriesOf(result).map((e) => e.testId)).toEqual(['b', 'a', 'c']);
  });

  it('returns counts for a flagged test and null counts plus the threshold for an absent one', async () => {
    insertRollupRow({
      projectId: PROJECT_ID,
      testId: 'flagged',
      sampleCount: 12,
      transitionCount: 5,
    });
    const flipThreshold = typedGetSetting('flip_rate_threshold_k');

    const result = await call({ testIds: ['flagged', 'absent'] });

    expect(entriesOf(result)).toEqual([
      {
        testId: 'flagged',
        flipRateFlagged: true,
        transitionCount: 5,
        sampleCount: 12,
        flipThreshold,
      },
      {
        testId: 'absent',
        flipRateFlagged: false,
        transitionCount: null,
        sampleCount: null,
        flipThreshold,
      },
    ]);
  });

  it('never returns rollup rows for tests that were not requested', async () => {
    insertRollupRow({
      projectId: PROJECT_ID,
      testId: 'other',
      sampleCount: 3,
      transitionCount: 2,
    });
    const result = await call({ testIds: ['requested'] });
    expect(entriesOf(result).map((e) => e.testId)).toEqual(['requested']);
    expect(entriesOf(result)[0]?.flipRateFlagged).toBe(false);
  });

  it('ignores rollup rows from other projects', async () => {
    insertRollupRow({
      projectId: 'other-proj',
      testId: 'test-1',
      sampleCount: 3,
      transitionCount: 2,
    });
    const result = await call({ testIds: ['test-1'] });
    expect(entriesOf(result)[0]?.flipRateFlagged).toBe(false);
  });

  it('does not surface base-health tracking rows', async () => {
    insertTrackingRow('test-1');
    const result = await call({ testIds: ['test-1'] });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('notion:task-1');
    expect(text).not.toContain('remediation');
    expect(text).not.toContain('tracking');
  });
});
