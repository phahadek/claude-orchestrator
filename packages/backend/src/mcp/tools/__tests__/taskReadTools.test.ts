import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const backend = {
  fetchTaskSummary: vi.fn(),
  listTasksByStatus: vi.fn(),
};

vi.mock('../../../tasks/TaskBackend', () => ({
  getTaskBackend: () => backend,
}));

vi.mock('../../../projects/milestoneResolver', () => ({
  buildTaskMilestoneIndex: () =>
    new Map([
      ['notion:in-project', 'M2'],
      ['notion:in-project-later', 'M3'],
    ]),
  resolveMilestoneForTaskId: (_p: string, id: string) =>
    id === 'in-project' ? 'M2' : null,
}));

import { registerTaskReadTools } from '../taskReadTools';

async function connect() {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerTaskReadTools(server, { workflow: 'design', projectId: 'p' });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1.0.0' });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

function text(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0].text;
}

describe('task read tools carry milestone', () => {
  it('task.queryTasks returns milestone and drops tasks outside the project', async () => {
    const mk = (id: string, title: string) => ({
      task: { id, title, type: '💻 Code', status: '🔲 Backlog' },
    });
    backend.listTasksByStatus.mockResolvedValue([
      mk('in-project', 'Mine'),
      mk('in-project-later', 'Later'),
      mk('other-project', 'Foreign'),
    ]);
    const client = await connect();
    const res = await client.callTool({
      name: 'task.queryTasks',
      arguments: { status: '🔲 Backlog' },
    });
    const parsed = JSON.parse(text(res));
    expect(parsed.map((r: { id: string }) => r.id)).toEqual([
      'in-project',
      'in-project-later',
    ]);
    expect(parsed[0].milestone).toBe('M2');
    expect(parsed[1].milestone).toBe('M3');
  });

  it('task.getById carries milestone', async () => {
    backend.fetchTaskSummary.mockResolvedValue({
      title: 'Mine',
      type: '💻 Code',
      status: '🔲 Backlog',
    });
    const client = await connect();
    const res = await client.callTool({
      name: 'task.getById',
      arguments: { taskId: 'in-project' },
    });
    expect(JSON.parse(text(res)).milestone).toBe('M2');
  });
});
