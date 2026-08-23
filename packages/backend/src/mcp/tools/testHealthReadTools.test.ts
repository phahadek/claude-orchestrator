/**
 * Tests for `testHealth.getFlakyHistory`: returns the flagged_flaky_tests_rollup
 * + base_health_remediation_test_tracking state scoped to a project (and
 * optionally a single test id), never throwing for a test id with no
 * recorded history.
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
import { registerTestHealthReadTools } from './testHealthReadTools';

const PROJECT_ID = 'proj-1';

beforeEach(() => {
  db.prepare('DELETE FROM flagged_flaky_tests_rollup').run();
  db.prepare('DELETE FROM base_health_remediation_test_tracking').run();
});

function insertRollupRow(opts: {
  projectId: string;
  testId: string;
  name: string;
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
    name: opts.name,
    sample_count: opts.sampleCount,
    transition_count: opts.transitionCount,
    computed_at: 1700000000000,
  });
}

function insertTrackingRow(opts: {
  projectId: string;
  testId: string;
  remediationTaskId: string | null;
  remediationTaskOpen: boolean;
}): void {
  db.prepare(
    `INSERT INTO base_health_remediation_test_tracking
       (project_id, test_id, remediation_task_id, remediation_task_open, created_at, updated_at)
     VALUES (@project_id, @test_id, @remediation_task_id, @remediation_task_open, @created_at, @updated_at)`,
  ).run({
    project_id: opts.projectId,
    test_id: opts.testId,
    remediation_task_id: opts.remediationTaskId,
    remediation_task_open: opts.remediationTaskOpen ? 1 : 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  });
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

function resultOf(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('testHealth.getFlakyHistory', () => {
  it('returns the rollup sampleCount/transitionCount for a flagged test id', async () => {
    insertRollupRow({
      projectId: PROJECT_ID,
      testId: 'test-1',
      name: 'src/planning/__tests__/decisionPickOnePayloadShape.test.ts',
      sampleCount: 12,
      transitionCount: 5,
    });

    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'testHealth.getFlakyHistory',
        arguments: { testId: 'test-1' },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(result.rollup).toEqual([
      {
        testId: 'test-1',
        name: 'src/planning/__tests__/decisionPickOnePayloadShape.test.ts',
        sampleCount: 12,
        transitionCount: 5,
      },
    ]);
  });

  it('returns tracking claim state for a test id', async () => {
    insertTrackingRow({
      projectId: PROJECT_ID,
      testId: 'test-1',
      remediationTaskId: 'notion:task-1',
      remediationTaskOpen: true,
    });

    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'testHealth.getFlakyHistory',
        arguments: { testId: 'test-1' },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(result.tracking).toEqual([
      {
        testId: 'test-1',
        remediationTaskId: 'notion:task-1',
        remediationTaskOpen: true,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      },
    ]);
  });

  it('returns an empty result for a test id with no rollup entry and no tracking row, rather than throwing', async () => {
    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'testHealth.getFlakyHistory',
        arguments: { testId: 'never-seen-test' },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(result.rollup).toEqual([]);
    expect(result.tracking).toEqual([]);
  });

  it('scopes results to the given project id', async () => {
    insertRollupRow({
      projectId: 'other-proj',
      testId: 'test-1',
      name: 'some-other-project-test.ts',
      sampleCount: 3,
      transitionCount: 2,
    });

    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'testHealth.getFlakyHistory',
        arguments: { testId: 'test-1' },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(result.rollup).toEqual([]);
    expect(result.tracking).toEqual([]);
  });

  it('with no testId, returns every flagged test in the rollup plus its tracking state', async () => {
    insertRollupRow({
      projectId: PROJECT_ID,
      testId: 'test-1',
      name: 'test-one.ts',
      sampleCount: 10,
      transitionCount: 4,
    });
    insertRollupRow({
      projectId: PROJECT_ID,
      testId: 'test-2',
      name: 'test-two.ts',
      sampleCount: 8,
      transitionCount: 3,
    });
    insertTrackingRow({
      projectId: PROJECT_ID,
      testId: 'test-1',
      remediationTaskId: 'notion:task-1',
      remediationTaskOpen: false,
    });

    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'testHealth.getFlakyHistory',
        arguments: {},
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();

    expect(result.rollup).toEqual([
      {
        testId: 'test-1',
        name: 'test-one.ts',
        sampleCount: 10,
        transitionCount: 4,
      },
      {
        testId: 'test-2',
        name: 'test-two.ts',
        sampleCount: 8,
        transitionCount: 3,
      },
    ]);
    expect(result.tracking).toEqual([
      {
        testId: 'test-1',
        remediationTaskId: 'notion:task-1',
        remediationTaskOpen: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      },
    ]);
  });
});
