import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import yaml from 'js-yaml';
import type { TaskAggregateRow } from '../db/queries.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getTaskCache: vi.fn(),
  getActiveTaskAggregates: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  getMilestoneById: vi.fn().mockReturnValue(null),
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

import { createTasksRouter, summarizeEvent } from '../routes/tasks.js';
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
    task_id: notionTaskId,
    raw_json: JSON.stringify(task),
    code_session_id: null,
    code_session_status: null,
    code_session_started_at: null,
    code_session_ended_at: null,
    code_session_input_tokens: null,
    code_session_output_tokens: null,
    code_session_last_event_payload: null,
    review_session_id: null,
    review_session_status: null,
    review_session_input_tokens: null,
    review_session_output_tokens: null,
    pr_number: null,
    pr_url: null,
    pr_title: null,
    pr_head_branch: null,
    pr_base_branch: null,
    pr_state: null,
    pr_draft: null,
    pr_review_result: null,
    pr_review_iteration: null,
    pr_merge_state: null,
    pr_pause_reason: null,
    review_session_result: null,
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
  // Done tasks are excluded at the SQL layer (getActiveTaskAggregates) so they
  // never reach the route. Backlog tasks are intentionally surfaced in the
  // Tasks panel. Only Deferred is filtered at the route level.

  it('does not include tasks with Deferred Notion status', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-deferred', '⏸️ Deferred'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).not.toContain('task-deferred');
    expect(ids).toContain('task-ready');
  });

  it('returns Ready, In Progress, and Backlog tasks while excluding Deferred', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-ready', '🗂️ Ready'),
      makeAggregate('task-deferred', '⏸️ Deferred'),
      makeAggregate('task-backlog', '🔲 Backlog'),
      makeAggregate('task-in-progress', '🔄 In Progress'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const ids = res.body.map((t: { taskId: string }) => t.taskId);
    expect(ids).toContain('task-ready');
    expect(ids).toContain('task-in-progress');
    expect(ids).toContain('task-backlog');
    expect(ids).not.toContain('task-deferred');
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).get('/api/tasks/active');
    expect(res.status).toBe(400);
  });

  it('returns 404 when project is not found', async () => {
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=unknown',
    );
    expect(res.status).toBe(404);
  });

  it('returns non-empty results when board cache has prefixed task IDs matching aggregates', async () => {
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify([
        {
          id: 'notion:task-abc',
          title: 'Task ABC',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: '',
        },
      ]),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-abc', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].taskId).toBe('notion:task-abc');
  });

  it('returns task IDs in notion:<dashed-uuid> form — no notion:notion: double-prefix in response', async () => {
    const DASHED_UUID = '36d22f91-52f3-8121-9dce-d6993942354b';
    const PREFIXED_ID = `notion:${DASHED_UUID}`;

    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify([
        {
          id: PREFIXED_ID,
          title: 'Task Alpha',
          status: '🗂️ Ready',
          type: '💻 Code',
          dependsOn: [],
          notionUrl: `https://notion.so/${DASHED_UUID}`,
        },
      ]),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate(PREFIXED_ID, '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);

    // The full response JSON must not contain a double-prefix anywhere.
    const responseText = JSON.stringify(res.body);
    expect(responseText).not.toContain('notion:notion:');

    // The single task must have a correctly-formed taskId.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].taskId).toBe(PREFIXED_ID);
    expect(res.body[0].taskId).toMatch(
      /^notion:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('dependency resolver populates blocked and blockerNames when dependsOn uses prefixed IDs', async () => {
    const boardTasks: NotionTask[] = [
      {
        id: 'notion:task-a',
        title: 'Task A',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['notion:task-b'],
        notionUrl: '',
      },
      {
        id: 'notion:task-b',
        title: 'Task B',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: [],
        notionUrl: '',
      },
    ];
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify(boardTasks),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-a', '🗂️ Ready'),
      makeAggregate('notion:task-b', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const taskA = res.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-a',
    );
    expect(taskA).toBeDefined();
    expect(taskA.blocked).toBe(true);
    expect(taskA.blockerNames).toContain('Task B');
  });

  it('3-task chain A←B←C (notion:) — B at wave 1 unblocked, C at wave 2 blocked by B', async () => {
    // A is Done, B depends on A (satisfied), C depends on B (not Done → blocked)
    const boardTasks: NotionTask[] = [
      {
        id: 'notion:task-a',
        title: 'Task A',
        status: '✅ Done',
        type: '💻 Code',
        dependsOn: [],
        notionUrl: '',
      },
      {
        id: 'notion:task-b',
        title: 'Task B',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['notion:task-a'],
        notionUrl: '',
      },
      {
        id: 'notion:task-c',
        title: 'Task C',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['notion:task-b'],
        notionUrl: '',
      },
    ];
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify(boardTasks),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-b', '🗂️ Ready'),
      makeAggregate('notion:task-c', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);

    const taskB = res.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-b',
    );
    const taskC = res.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-c',
    );

    expect(taskB).toBeDefined();
    expect(taskB.wave).toBe(1);
    expect(taskB.blocked).toBe(false);

    expect(taskC).toBeDefined();
    expect(taskC.wave).toBe(2);
    expect(taskC.blocked).toBe(true);
    expect(taskC.blockerNames).toContain('Task B');
  });

  it('3-task chain A←B←C (jira:) — B at wave 1 unblocked, C at wave 2 blocked by B', async () => {
    const boardTasks: NotionTask[] = [
      {
        id: 'jira:PROJ-1',
        title: 'Issue 1',
        status: '✅ Done',
        type: '💻 Code',
        dependsOn: [],
        notionUrl: '',
      },
      {
        id: 'jira:PROJ-2',
        title: 'Issue 2',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['jira:PROJ-1'],
        notionUrl: '',
      },
      {
        id: 'jira:PROJ-3',
        title: 'Issue 3',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['jira:PROJ-2'],
        notionUrl: '',
      },
    ];
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify(boardTasks),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('jira:PROJ-2', '🗂️ Ready'),
      makeAggregate('jira:PROJ-3', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);

    const task2 = res.body.find(
      (t: { taskId: string }) => t.taskId === 'jira:PROJ-2',
    );
    const task3 = res.body.find(
      (t: { taskId: string }) => t.taskId === 'jira:PROJ-3',
    );

    expect(task2).toBeDefined();
    expect(task2.wave).toBe(1);
    expect(task2.blocked).toBe(false);

    expect(task3).toBeDefined();
    expect(task3.wave).toBe(2);
    expect(task3.blocked).toBe(true);
    expect(task3.blockerNames).toContain('Issue 2');
  });

  it('3-task chain A←B←C (yaml:) — B at wave 1 unblocked, C at wave 2 blocked by B', async () => {
    const boardTasks: NotionTask[] = [
      {
        id: 'yaml:task-alpha',
        title: 'Alpha',
        status: '✅ Done',
        type: '💻 Code',
        dependsOn: [],
        notionUrl: '',
      },
      {
        id: 'yaml:task-beta',
        title: 'Beta',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['yaml:task-alpha'],
        notionUrl: '',
      },
      {
        id: 'yaml:task-gamma',
        title: 'Gamma',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['yaml:task-beta'],
        notionUrl: '',
      },
    ];
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify(boardTasks),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('yaml:task-beta', '🗂️ Ready'),
      makeAggregate('yaml:task-gamma', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);

    const taskBeta = res.body.find(
      (t: { taskId: string }) => t.taskId === 'yaml:task-beta',
    );
    const taskGamma = res.body.find(
      (t: { taskId: string }) => t.taskId === 'yaml:task-gamma',
    );

    expect(taskBeta).toBeDefined();
    expect(taskBeta.wave).toBe(1);
    expect(taskBeta.blocked).toBe(false);

    expect(taskGamma).toBeDefined();
    expect(taskGamma.wave).toBe(2);
    expect(taskGamma.blocked).toBe(true);
    expect(taskGamma.blockerNames).toContain('Beta');
  });
});

// ── GET /api/tasks/non-milestone — resolver back-fill ────────────────────────

describe('GET /api/tasks/non-milestone', () => {
  it('runs the resolver and back-fills wave, blocked, blockerNames on each view', async () => {
    const nonMilestoneTasks: NotionTask[] = [
      {
        id: 'notion:task-x',
        title: 'Task X',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['notion:task-y'],
        notionUrl: '',
      },
      {
        id: 'notion:task-y',
        title: 'Task Y',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: [],
        notionUrl: '',
      },
    ];
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'non_milestone:proj-1',
      raw_json: JSON.stringify(nonMilestoneTasks),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-x', '🗂️ Ready'),
      makeAggregate('notion:task-y', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/non-milestone?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const taskX = res.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-x',
    );
    const taskY = res.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-y',
    );
    expect(taskX).toBeDefined();
    expect(taskX.blocked).toBe(true);
    expect(taskX.blockerNames).toContain('Task Y');
    expect(taskY).toBeDefined();
    expect(taskY.blocked).toBe(false);
    expect(taskY.wave).toBe(1);
  });

  it('3-task chain A←B←C: B at wave 1 unblocked, C at wave 2 blocked by B', async () => {
    const nonMilestoneTasks: NotionTask[] = [
      {
        id: 'notion:task-a',
        title: 'Task A',
        status: '✅ Done',
        type: '💻 Code',
        dependsOn: [],
        notionUrl: '',
      },
      {
        id: 'notion:task-b',
        title: 'Task B',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['notion:task-a'],
        notionUrl: '',
      },
      {
        id: 'notion:task-c',
        title: 'Task C',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['notion:task-b'],
        notionUrl: '',
      },
    ];
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'non_milestone:proj-1',
      raw_json: JSON.stringify(nonMilestoneTasks),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-b', '🗂️ Ready'),
      makeAggregate('notion:task-c', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/non-milestone?projectId=proj-1',
    );
    expect(res.status).toBe(200);

    const taskB = res.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-b',
    );
    const taskC = res.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-c',
    );

    expect(taskB).toBeDefined();
    expect(taskB.wave).toBe(1);
    expect(taskB.blocked).toBe(false);

    expect(taskC).toBeDefined();
    expect(taskC.wave).toBe(2);
    expect(taskC.blocked).toBe(true);
    expect(taskC.blockerNames).toContain('Task B');
  });

  it('dependsOn referencing an ID not in the non-milestone cache resolves to blocked: false', async () => {
    const nonMilestoneTasks: NotionTask[] = [
      {
        id: 'notion:task-orphan',
        title: 'Orphan Task',
        status: '🗂️ Ready',
        type: '💻 Code',
        dependsOn: ['notion:task-from-other-db'],
        notionUrl: '',
      },
    ];
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'non_milestone:proj-1',
      raw_json: JSON.stringify(nonMilestoneTasks),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-orphan', '🗂️ Ready'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/non-milestone?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].taskId).toBe('notion:task-orphan');
    expect(res.body[0].blocked).toBe(false);
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).get('/api/tasks/non-milestone');
    expect(res.status).toBe(400);
  });

  it('returns empty array when cache is missing', async () => {
    vi.mocked(queries.getTaskCache).mockReturnValue(null);
    const res = await supertest(buildApp()).get(
      '/api/tasks/non-milestone?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── totalTokens aggregation ────────────────────────────────────────────────────

describe('buildTaskViewFromRow — totalTokens', () => {
  it('sums code and review session tokens into totalTokens', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-tokens', '🔄 In Progress', {
        code_session_id: 'cs-1',
        code_session_status: 'done',
        code_session_started_at: 1000,
        code_session_input_tokens: 400,
        code_session_output_tokens: 200,
        review_session_id: 'rs-1',
        review_session_status: 'done',
        review_session_input_tokens: 100,
        review_session_output_tokens: 50,
      }),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.find(
      (t: { taskId: string }) => t.taskId === 'task-tokens',
    );
    expect(task.totalTokens.input).toBe(500);
    expect(task.totalTokens.output).toBe(250);
  });

  it('totalTokens counts only code session when review is absent', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-code-only', '🔄 In Progress', {
        code_session_id: 'cs-2',
        code_session_status: 'done',
        code_session_started_at: 1000,
        code_session_input_tokens: 300,
        code_session_output_tokens: 150,
        review_session_id: null,
        review_session_input_tokens: null,
        review_session_output_tokens: null,
      }),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.find(
      (t: { taskId: string }) => t.taskId === 'task-code-only',
    );
    expect(task.totalTokens.input).toBe(300);
    expect(task.totalTokens.output).toBe(150);
  });

  it('review.inputTokens and review.outputTokens are populated from row', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-review-tokens', '🔍 In Review', {
        review_session_id: 'rs-2',
        review_session_status: 'done',
        review_session_input_tokens: 80,
        review_session_output_tokens: 40,
      }),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.find(
      (t: { taskId: string }) => t.taskId === 'task-review-tokens',
    );
    expect(task.review.inputTokens).toBe(80);
    expect(task.review.outputTokens).toBe(40);
  });
});

// ── GET /api/tasks/export?format=yaml ─────────────────────────────────────────

describe('GET /api/tasks/export?format=yaml', () => {
  const boardTasks = [
    {
      id: 'task-a',
      title: 'Task A',
      status: '🗂️ Ready',
      type: '💻 Code',
      priority: '🔴 High',
      dependsOn: [],
      notionUrl: 'https://notion.so/task-a',
    },
    {
      id: 'task-b',
      title: 'Task B',
      status: '⏭️ Deferred',
      type: '💻 Code',
      priority: '🟡 Medium',
      dependsOn: [],
      notionUrl: 'https://notion.so/task-b',
    },
  ];

  beforeEach(() => {
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify(boardTasks),
      fetched_at: Date.now(),
    } as never);
  });

  it('returns 200 with Content-Type application/yaml', async () => {
    const res = await supertest(buildApp()).get(
      '/api/tasks/export?format=yaml&boardId=board-1',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
  });

  it('returns valid YAML parseable by js-yaml', async () => {
    const res = await supertest(buildApp()).get(
      '/api/tasks/export?format=yaml&boardId=board-1',
    );
    expect(() => yaml.load(res.text)).not.toThrow();
    const parsed = yaml.load(res.text) as {
      board_id: string;
      tasks: unknown[];
    };
    expect(parsed).toHaveProperty('tasks');
    expect(Array.isArray(parsed.tasks)).toBe(true);
  });

  it('excludes Deferred tasks from the export', async () => {
    const res = await supertest(buildApp()).get(
      '/api/tasks/export?format=yaml&boardId=board-1',
    );
    const parsed = yaml.load(res.text) as { tasks: Array<{ id: string }> };
    const ids = parsed.tasks.map((t) => t.id);
    expect(ids).toContain('task-a');
    expect(ids).not.toContain('task-b');
  });

  it('returns 400 when format is unsupported', async () => {
    const res = await supertest(buildApp()).get(
      '/api/tasks/export?format=json&boardId=board-1',
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when board is not found in cache', async () => {
    vi.mocked(queries.getTaskCache).mockReturnValue(null);
    const res = await supertest(buildApp()).get(
      '/api/tasks/export?format=yaml&boardId=unknown-board',
    );
    expect(res.status).toBe(404);
  });
});

// ── summarizeEvent — tool-call formatting ─────────────────────────────────────

function toolUsePayload(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name, input }],
    },
  });
}

function toolUseTopLevel(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'tool_use', name, input });
}

describe('summarizeEvent — tool-call formatting', () => {
  it('Read shows the basename of file_path', () => {
    expect(
      summarizeEvent(
        toolUsePayload('Read', { file_path: 'src/components/App.tsx' }),
      ),
    ).toBe('Read(App.tsx)');
  });

  it('Write shows the basename of file_path', () => {
    expect(
      summarizeEvent(
        toolUsePayload('Write', { file_path: '/absolute/path/index.ts' }),
      ),
    ).toBe('Write(index.ts)');
  });

  it('Edit shows the basename of file_path', () => {
    expect(
      summarizeEvent(
        toolUsePayload('Edit', { file_path: 'packages/backend/src/server.ts' }),
      ),
    ).toBe('Edit(server.ts)');
  });

  it('Bash shows the first token of the command', () => {
    expect(
      summarizeEvent(toolUsePayload('Bash', { command: 'git status --short' })),
    ).toBe('Bash(git)');
  });

  it('Bash with a single-word command', () => {
    expect(summarizeEvent(toolUsePayload('Bash', { command: 'npx' }))).toBe(
      'Bash(npx)',
    );
  });

  it('Grep shows the pattern', () => {
    expect(
      summarizeEvent(toolUsePayload('Grep', { pattern: 'useState' })),
    ).toBe('Grep(useState)');
  });

  it('Glob shows the pattern', () => {
    expect(
      summarizeEvent(toolUsePayload('Glob', { pattern: '**/*.tsx' })),
    ).toBe('Glob(**/*.tsx)');
  });

  it('Agent shows the description', () => {
    expect(
      summarizeEvent(
        toolUsePayload('Agent', { description: 'Explore codebase' }),
      ),
    ).toBe('Agent(Explore codebase)');
  });

  it('WebFetch shows the url', () => {
    expect(
      summarizeEvent(
        toolUsePayload('WebFetch', { url: 'https://example.com/api' }),
      ),
    ).toBe('WebFetch(https://example.com/api)');
  });

  it('WebSearch shows the query', () => {
    expect(
      summarizeEvent(
        toolUsePayload('WebSearch', { query: 'vitest mock module' }),
      ),
    ).toBe('WebSearch(vitest mock module)');
  });

  it('unknown tool falls back to bare tool name (no brackets)', () => {
    expect(
      summarizeEvent(toolUsePayload('UnknownTool', { something: 'value' })),
    ).toBe('UnknownTool');
  });

  it('enforces 80-char cap with ellipsis', () => {
    const longArg = 'a'.repeat(100);
    const result = summarizeEvent(toolUsePayload('Grep', { pattern: longArg }));
    expect(result.length).toBe(80);
    expect(result.endsWith('…')).toBe(true);
  });

  it('works with top-level tool_use event shape', () => {
    expect(
      summarizeEvent(toolUseTopLevel('Read', { file_path: 'src/App.tsx' })),
    ).toBe('Read(App.tsx)');
  });

  it('Read with Windows-style backslash path shows basename', () => {
    expect(
      summarizeEvent(
        toolUsePayload('Read', { file_path: 'src\\components\\App.tsx' }),
      ),
    ).toBe('Read(App.tsx)');
  });
});
