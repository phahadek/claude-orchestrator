import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { TaskAggregateRow } from '../db/queries.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getTaskCache: vi.fn(),
  getActiveTaskAggregates: vi.fn(),
  getLatestNonSystemEventPayload: vi.fn().mockReturnValue(null),
  getSetting: vi.fn().mockReturnValue(null),
}));

vi.mock('../config.js', () => ({
  getProjectById: vi.fn((id: string) => {
    if (id === 'proj-1') {
      return {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
      };
    }
    return undefined;
  }),
}));

import { createTasksRouter } from '../routes/tasks.js';
import * as queries from '../db/queries.js';
import type { NotionTask } from '../notion/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAggregate(
  notionTaskId: string,
  notionStatus: string,
  overrides: Partial<TaskAggregateRow> = {},
): TaskAggregateRow {
  const task: NotionTask = {
    id: notionTaskId,
    title: `Task ${notionTaskId}`,
    status: notionStatus,
    type: '💻 Code',
    dependsOn: [],
    notionUrl: `https://notion.so/${notionTaskId}`,
  };
  return {
    notion_task_id: notionTaskId,
    raw_json: JSON.stringify(task),
    code_session_id: null,
    code_session_status: null,
    code_session_started_at: null,
    code_session_ended_at: null,
    code_session_input_tokens: null,
    code_session_output_tokens: null,
    review_session_id: null,
    review_session_status: null,
    pr_number: null,
    pr_url: null,
    pr_title: null,
    pr_head_branch: null,
    pr_base_branch: null,
    pr_state: null,
    pr_draft: null,
    pr_review_result: null,
    pr_review_iteration: null,
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createTasksRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: board cache returns three task IDs
  vi.mocked(queries.getTaskCache).mockReturnValue({
    cache_key: 'board:board-1',
    raw_json: JSON.stringify([
      { id: 'task-ready' },
      { id: 'task-done' },
      { id: 'task-deferred' },
      { id: 'task-backlog' },
      { id: 'task-in-progress' },
    ]),
    fetched_at: Date.now(),
  } as never);
});

// ── GET /api/tasks/active filtering ──────────────────────────────────────────

describe('GET /api/tasks/active', () => {
  it('does not include tasks with Done Notion status', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-done', '✅ Done'),
    ]);

    const res = await supertest(buildApp()).get('/api/tasks/active?projectId=proj-1');
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).not.toContain('task-done');
    expect(ids).toContain('task-ready');
  });

  it('does not include tasks with Deferred Notion status', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-deferred', '⏸️ Deferred'),
    ]);

    const res = await supertest(buildApp()).get('/api/tasks/active?projectId=proj-1');
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).not.toContain('task-deferred');
    expect(ids).toContain('task-ready');
  });

  it('does not include tasks with Backlog Notion status', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-backlog', '🔲 Backlog'),
    ]);

    const res = await supertest(buildApp()).get('/api/tasks/active?projectId=proj-1');
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).not.toContain('task-backlog');
    expect(ids).toContain('task-ready');
  });

  it('returns only active tasks when mix of statuses present', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-done', '✅ Done'),
      makeAggregate('task-deferred', '⏸️ Deferred'),
      makeAggregate('task-backlog', '🔲 Backlog'),
      makeAggregate('task-in-progress', '🔄 In Progress'),
    ]);

    const res = await supertest(buildApp()).get('/api/tasks/active?projectId=proj-1');
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).toContain('task-ready');
    expect(ids).toContain('task-in-progress');
    expect(ids).not.toContain('task-done');
    expect(ids).not.toContain('task-deferred');
    expect(ids).not.toContain('task-backlog');
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).get('/api/tasks/active');
    expect(res.status).toBe(400);
  });

  it('returns 404 when project is not found', async () => {
    const res = await supertest(buildApp()).get('/api/tasks/active?projectId=unknown');
    expect(res.status).toBe(404);
  });
});
