/**
 * Tests for `pullRequest.getByTaskId`: found/not-found delegation to the
 * existing getPRByNotionTaskId query, no throw on a missing row.
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
import { registerPullRequestReadTools } from './pullRequestReadTools';

beforeEach(() => {
  db.prepare('DELETE FROM pull_requests').run();
});

function insertPR(taskId: string, prNumber: number): void {
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, repo, state, draft, review_result, review_at,
       created_at, updated_at, synced_at)
    VALUES
      (@pr_number, @pr_url, @task_id, @repo, 'open', 0, NULL, NULL,
       @created_at, @created_at, @created_at)
  `,
  ).run({
    pr_number: prNumber,
    pr_url: `https://github.com/owner/repo/pull/${prNumber}`,
    task_id: taskId,
    repo: 'owner/repo',
    created_at: '2024-01-01T00:00:00Z',
  });
}

async function connectedClient() {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerPullRequestReadTools(server);
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
}): unknown {
  const text = result.content[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content');
  return JSON.parse(text);
}

describe('pullRequest.getByTaskId', () => {
  it('returns the PR row when one exists for the task', async () => {
    insertPR('notion:task-1', 42);
    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'pullRequest.getByTaskId',
        arguments: { taskId: 'notion:task-1' },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();
    expect(result).toMatchObject({ pr_number: 42, task_id: 'notion:task-1' });
  });

  it('returns null when no PR exists for the task', async () => {
    const { client, close } = await connectedClient();
    const result = resultOf(
      (await client.callTool({
        name: 'pullRequest.getByTaskId',
        arguments: { taskId: 'notion:no-such-task' },
      })) as { content: Array<{ type: string; text?: string }> },
    );
    await close();
    expect(result).toBeNull();
  });
});
