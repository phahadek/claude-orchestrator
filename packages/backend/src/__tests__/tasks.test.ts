import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import yaml from 'js-yaml';
import type { TaskAggregateRow } from '../db/queries.js';
import { mockDbQueries } from './helpers/mockDbQueries';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () =>
  mockDbQueries({
    getTaskCache: vi.fn(),
    getActiveTaskAggregates: vi.fn(),
    getSetting: vi.fn().mockReturnValue(null),
    getMilestoneById: vi.fn().mockReturnValue(null),
    clearTaskPauseReason: vi.fn(),
    resetTaskCrashCount: vi.fn(),
    deleteTaskCacheRow: vi.fn(),
    getPRByNotionTaskId: vi.fn().mockReturnValue(null),
    clearTerminalPRFlags: vi.fn(),
    getTaskRepoAssignment: vi.fn().mockReturnValue(null),
  }),
);

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
  getAllProjects: vi.fn().mockReturnValue([]),
  runtimeSettings: { task_cache_refresh_interval_ms: 60_000 },
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTasksRouter,
  summarizeEvent,
  setTaskBroadcast,
  emitTaskUpdated,
} from '../routes/tasks.js';
import * as queries from '../db/queries.js';
import { insertStagedIntent } from '../db/queries.js';
import type { StagedIntentState } from '../db/types.js';
import { getTaskBackend } from '../tasks/TaskBackend.js';
import { recordEvent } from '../audit/AuditLog.js';
import type { NotionTask } from '../notion/types.js';
import { passesGroomDepGate } from '../orchestration/planningCandidates.js';
import { normalizeBoardId } from '../tasks/taskId.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
    // annotateGroomDepBlocking requires every cached task to carry a real
    // `status` string (NotionTask.status is non-optional) — these fixtures
    // otherwise crash the route with "Cannot read properties of undefined
    // (reading 'includes')".
    raw_json: JSON.stringify([
      { id: 'task-ready', status: '🗂️ Ready', dependsOn: [] },
      { id: 'task-done', status: '✅ Done', dependsOn: [] },
      { id: 'task-deferred', status: '⏸️ Deferred', dependsOn: [] },
      { id: 'task-backlog', status: '🔲 Backlog', dependsOn: [] },
      { id: 'task-in-progress', status: '🔄 In Progress', dependsOn: [] },
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
    const ids = res.body.tasks.map((t: { taskId: string }) => t.taskId);
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
    const ids = res.body.tasks.map((t: { taskId: string }) => t.taskId);
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
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].taskId).toBe('notion:task-abc');
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
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].taskId).toBe(PREFIXED_ID);
    expect(res.body.tasks[0].taskId).toMatch(
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
    const taskA = res.body.tasks.find(
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

    const taskB = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-b',
    );
    const taskC = res.body.tasks.find(
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

    const task2 = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'jira:PROJ-2',
    );
    const task3 = res.body.tasks.find(
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

    const taskBeta = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'yaml:task-beta',
    );
    const taskGamma = res.body.tasks.find(
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

// ── GET /api/tasks/active?shape= ──────────────────────────────────────────────

describe('GET /api/tasks/active — shape param', () => {
  function makeRichAggregate(
    taskId: string,
    notionStatus: string,
  ): TaskAggregateRow {
    return makeAggregate(taskId, notionStatus, {
      code_session_id: `session-${taskId}`,
      code_session_status: 'done',
      code_session_started_at: 1000,
      code_session_ended_at: 2000,
      code_session_input_tokens: 111,
      code_session_output_tokens: 222,
      code_session_last_event_payload: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'wrapping up' }] },
      }),
      pr_number: 42,
      pr_url: 'https://github.com/org/repo/pull/42',
      pr_title: 'Some PR title',
      pr_head_branch: 'feature/x',
      pr_base_branch: 'dev',
      pr_state: 'closed',
      pr_draft: 0,
      pr_merge_state: 'clean',
      review_session_id: `review-${taskId}`,
      review_session_status: 'done',
      review_session_input_tokens: 33,
      review_session_output_tokens: 44,
      pr_review_result: JSON.stringify({
        verdict: 'approve',
        summary: 'looks good',
      }),
      pr_review_iteration: 1,
      pr_pause_reason: JSON.stringify({
        reason: 'max_reviews',
        detail: 'hit review cap',
      }),
      depth_review_session_id: `depth-${taskId}`,
      depth_review_session_status: 'done',
      depth_review_verdict: 'pass',
    } as Partial<TaskAggregateRow>);
  }

  beforeEach(() => {
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify([
        { id: 'task-done', status: '✅ Done', dependsOn: [] },
        { id: 'task-in-progress', status: '🔄 In Progress', dependsOn: [] },
      ]),
      fetched_at: Date.now(),
    } as never);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeRichAggregate('task-done', '✅ Done'),
      makeRichAggregate('task-in-progress', '🔄 In Progress'),
    ]);
  });

  it('shape=summary omits/nulls heavy nested fields for a ✅ Done task, while a non-Done task keeps full fidelity', async () => {
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1&shape=summary',
    );
    expect(res.status).toBe(200);

    const done = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-done',
    );
    const inProgress = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-in-progress',
    );
    expect(done).toBeDefined();
    expect(inProgress).toBeDefined();

    // Done task: heavy fields trimmed
    expect(done.pr.prNumber).toBe(42);
    expect(done.pr.title).toBeUndefined();
    expect(done.pr.headBranch).toBeUndefined();
    expect(done.review).toBeNull();
    expect(done.depthReview).toBeNull();
    expect(done.pauseDetail == null).toBe(true);
    expect(done.recoveryDescriptor).toBeUndefined();
    expect(done.totalTokens).toBeUndefined();
    expect(done.codeSession.sessionId).toBe('session-task-done');
    expect(done.codeSession.status).toBeUndefined();
    expect(done.codeSession.lastMessage).toBeUndefined();

    // Non-Done task: full fidelity preserved
    expect(inProgress.pr.prNumber).toBe(42);
    expect(inProgress.pr.title).toBe('Some PR title');
    expect(inProgress.pr.headBranch).toBe('feature/x');
    expect(inProgress.review).not.toBeNull();
    expect(inProgress.review.summary).toBe('looks good');
    expect(inProgress.depthReview).not.toBeNull();
    expect(inProgress.depthReview.verdict).toBe('pass');
    expect(inProgress.totalTokens).toEqual({ input: 144, output: 266 });
    expect(inProgress.codeSession.status).toBe('done');
    expect(inProgress.codeSession.lastMessage).toBe('wrapping up');
  });

  it("shape=full (and no shape param) is byte-for-byte unchanged from today's response shape", async () => {
    const [noParamRes, explicitFullRes] = await Promise.all([
      supertest(buildApp()).get('/api/tasks/active?projectId=proj-1'),
      supertest(buildApp()).get(
        '/api/tasks/active?projectId=proj-1&shape=full',
      ),
    ]);
    expect(noParamRes.status).toBe(200);
    expect(explicitFullRes.status).toBe(200);
    expect(noParamRes.text).toBe(explicitFullRes.text);

    const done = noParamRes.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-done',
    );
    expect(done.pr.title).toBe('Some PR title');
    expect(done.review.summary).toBe('looks good');
    expect(done.depthReview.verdict).toBe('pass');
    expect(done.totalTokens).toEqual({ input: 144, output: 266 });
    expect(done.codeSession.status).toBe('done');
    expect(done.codeSession.lastMessage).toBe('wrapping up');
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
    const task = res.body.tasks.find(
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
    const task = res.body.tasks.find(
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
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-review-tokens',
    );
    expect(task.review.inputTokens).toBe(80);
    expect(task.review.outputTokens).toBe(40);
  });
});

describe('buildTaskViewFromRow — hasAwaitingDispositionIntent', () => {
  let intentCounter = 0;

  function stageIntent(taskId: string, state: StagedIntentState) {
    intentCounter += 1;
    insertStagedIntent({
      id: `intent-${intentCounter}`,
      kind: 'task.setStatus',
      payload: '{}',
      payload_hash: `hash-${intentCounter}`,
      task_id: taskId,
      project_id: 'proj-1',
      session_id: null,
      group_id: null,
      milestone: 'M1',
      state,
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      investigation: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: 0,
      updated_at: 0,
    });
  }

  it('is true for a task holding a staged intent', async () => {
    stageIntent('task-backlog', 'staged');
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-backlog', '🔲 Backlog'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-backlog',
    );
    expect(task.hasAwaitingDispositionIntent).toBe(true);
  });

  it('is true for a task holding an approved, needs_revision, or pending_verification intent', async () => {
    stageIntent('task-approved', 'approved');
    stageIntent('task-needs-revision', 'needs_revision');
    stageIntent('task-pending-verification', 'pending_verification');
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-approved', '🔲 Backlog'),
      makeAggregate('task-needs-revision', '🔲 Backlog'),
      makeAggregate('task-pending-verification', '🔲 Backlog'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    for (const taskId of [
      'task-approved',
      'task-needs-revision',
      'task-pending-verification',
    ]) {
      const task = res.body.tasks.find(
        (t: { taskId: string }) => t.taskId === taskId,
      );
      expect(task.hasAwaitingDispositionIntent).toBe(true);
    }
  });

  it('is false for a task whose only intents are terminal (committed/rejected/superseded/withdrawn)', async () => {
    stageIntent('task-terminal', 'committed');
    stageIntent('task-terminal', 'rejected');
    stageIntent('task-terminal', 'superseded');
    stageIntent('task-terminal', 'withdrawn');
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-terminal', '🔲 Backlog'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-terminal',
    );
    expect(task.hasAwaitingDispositionIntent).toBe(false);
  });

  it('is false for a task with no staged intents at all', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-no-intents', '🔲 Backlog'),
    ]);

    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-no-intents',
    );
    expect(task.hasAwaitingDispositionIntent).toBe(false);
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

// ── POST /api/tasks/:taskId/unblock ────────────────────────────────────────────

function setupFakeBackend(
  updateStatusImpl = vi.fn().mockResolvedValue(undefined),
) {
  vi.mocked(getTaskBackend).mockReturnValue({
    updateStatus: updateStatusImpl,
    fetchTaskPage: vi.fn().mockResolvedValue(''),
  } as never);
  return updateStatusImpl;
}

describe('POST /api/tasks/:taskId/unblock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFakeBackend();
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([]);
  });

  it('returns 422 when projectId is missing', async () => {
    const res = await supertest(buildApp()).post('/api/tasks/task-1/unblock');
    expect(res.status).toBe(422);
  });

  it('returns 422 when getTaskBackend throws', async () => {
    vi.mocked(getTaskBackend).mockImplementation(() => {
      throw new Error('no backend');
    });
    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/unblock?projectId=proj-1',
    );
    expect(res.status).toBe(422);
  });

  it('clears pause reason and crash count before calling updateStatus', async () => {
    const updateStatus = setupFakeBackend();
    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/unblock?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    expect(queries.clearTaskPauseReason).toHaveBeenCalledWith('task-1');
    expect(queries.resetTaskCrashCount).toHaveBeenCalledWith('task-1');
    expect(queries.deleteTaskCacheRow).toHaveBeenCalledWith('task-1');
    expect(updateStatus).toHaveBeenCalledWith('task-1', '🗂️ Ready', {
      source: 'orchestrator',
    });
  });

  it('calls updateStatus with 🗂️ Ready and broadcasts task_status_changed', async () => {
    const broadcasts: unknown[] = [];
    setTaskBroadcast((msg) => broadcasts.push(msg));

    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/unblock?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const changed = broadcasts.find(
      (m) => (m as { type: string }).type === 'task_status_changed',
    ) as { newStatus: string } | undefined;
    expect(changed).toBeDefined();
    expect(changed!.newStatus).toBe('🗂️ Ready');

    setTaskBroadcast(null as never);
  });

  it('records a task_unblocked audit event', async () => {
    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/unblock?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_unblocked',
        actor_type: 'human',
        task_id: 'task-1',
        project_id: 'proj-1',
      }),
    );
  });

  it('returns 200 with newStatus on success', async () => {
    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/unblock?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, newStatus: '🗂️ Ready' });
  });

  it('does not mutate state when projectId cannot be resolved (422)', async () => {
    vi.mocked(getTaskBackend).mockImplementation(() => {
      throw new Error('no backend');
    });
    await supertest(buildApp()).post(
      '/api/tasks/task-1/unblock?projectId=proj-1',
    );
    expect(queries.clearTaskPauseReason).not.toHaveBeenCalled();
    expect(queries.resetTaskCrashCount).not.toHaveBeenCalled();
  });
});

// ── TaskView recoveryDescriptor ────────────────────────────────────────────────

describe('TaskView recoveryDescriptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify([
        { id: 'task-1', status: '⚠️ Needs Attention', dependsOn: [] },
      ]),
      fetched_at: Date.now(),
    } as never);
  });

  it('includes recoveryDescriptor with available:true for a redispatch reason', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '⚠️ Needs Attention', {
        pr_pause_reason: 'stalled_idle',
      }),
    ]);
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-1',
    );
    expect(task.recoveryDescriptor).toMatchObject({
      available: true,
      action: 'redispatch',
      label: 'Redispatch',
    });
  });

  it('includes recoveryDescriptor with available:false for max_reviews', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '⚠️ Needs Attention', {
        pr_pause_reason: 'max_reviews',
      }),
    ]);
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-1',
    );
    expect(task.recoveryDescriptor).toMatchObject({ available: false });
    expect(task.recoveryDescriptor.action).toBeUndefined();
  });

  it('includes recoveryDescriptor with available:false when no pause reason', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '🗂️ Ready'),
    ]);
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-1',
    );
    expect(task.recoveryDescriptor).toMatchObject({ available: false });
  });
});

describe('TaskView displayStatus — auto_recovering threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getTaskCache).mockReturnValue({
      cache_key: 'board:board-1',
      raw_json: JSON.stringify([
        { id: 'task-1', status: '👀 In Review', dependsOn: [] },
      ]),
      fetched_at: Date.now(),
    } as never);
  });

  it("returns 'auto_recovering' for a ci_failing pause when pr_flake_recovery_attempts is below the max_retries setting", async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '👀 In Review', {
        pr_pause_reason: 'ci_failing',
        pr_flake_recovery_attempts: 0,
      }),
    ]);
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-1',
    );
    expect(task.displayStatus).toBe('auto_recovering');
  });

  it("returns 'needs_attention' for a ci_failing pause once pr_flake_recovery_attempts reaches the max_retries setting (default 2)", async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '👀 In Review', {
        pr_pause_reason: 'ci_failing',
        pr_flake_recovery_attempts: 2,
      }),
    ]);
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    const task = res.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'task-1',
    );
    expect(task.displayStatus).toBe('needs_attention');
  });
});

// ── POST /api/tasks/:taskId/recover ────────────────────────────────────────────

function buildAppWithServices(
  sessionManagerOverride?: { sendOrResume: ReturnType<typeof vi.fn> },
  reviewOrchestratorOverride?: {
    runAutofixPipeline: ReturnType<typeof vi.fn>;
  },
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createTasksRouter(
      sessionManagerOverride as never,
      reviewOrchestratorOverride as never,
    ),
  );
  return app;
}

describe('POST /api/tasks/:taskId/recover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFakeBackend();
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([]);
  });

  it('returns 422 when projectId is missing', async () => {
    const res = await supertest(buildApp()).post('/api/tasks/task-1/recover');
    expect(res.status).toBe(422);
  });

  it('returns 422 when no pause reason / no recovery available', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '🗂️ Ready'),
    ]);
    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/recover?projectId=proj-1',
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No recovery action/);
  });

  it('returns 422 for max_reviews (no action available)', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '⚠️ Needs Attention', {
        pr_pause_reason: 'max_reviews',
      }),
    ]);
    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/recover?projectId=proj-1',
    );
    expect(res.status).toBe(422);
  });

  it('returns success (rerun) for a PR paused at stalled_reconcile_cap', async () => {
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('task-1', '⚠️ Needs Attention', {
        pr_pause_reason: 'stalled_reconcile_cap',
      }),
    ]);
    vi.mocked(queries.getPRByNotionTaskId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
      task_id: 'task-1',
    } as never);
    const res = await supertest(buildApp()).post(
      '/api/tasks/task-1/recover?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'rerun' });
  });

  describe('action: redispatch', () => {
    beforeEach(() => {
      vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
        makeAggregate('task-1', '⚠️ Needs Attention', {
          pr_pause_reason: 'stalled_idle',
        }),
      ]);
    });

    it('clears pause reason, crash count, cache row and sets Ready', async () => {
      const updateStatus = setupFakeBackend();
      const res = await supertest(buildApp()).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, action: 'redispatch' });
      expect(queries.clearTaskPauseReason).toHaveBeenCalledWith('task-1');
      expect(queries.resetTaskCrashCount).toHaveBeenCalledWith('task-1');
      expect(queries.deleteTaskCacheRow).toHaveBeenCalledWith('task-1');
      expect(updateStatus).toHaveBeenCalledWith('task-1', '🗂️ Ready', {
        source: 'orchestrator',
      });
    });

    it('records a task_recovered audit event', async () => {
      setupFakeBackend();
      const res = await supertest(buildApp()).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(200);
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'task_recovered',
          actor_type: 'human',
          task_id: 'task-1',
          project_id: 'proj-1',
          payload: expect.objectContaining({ action: 'redispatch' }),
        }),
      );
    });

    it('evicts/aborts a live non-review session for the task before setting Ready', async () => {
      const updateStatus = setupFakeBackend();
      const findLiveSessionIdForTask = vi
        .fn()
        .mockReturnValue('live-session-1');
      const abortSession = vi.fn().mockResolvedValue(undefined);
      const app = buildAppWithServices({
        sendOrResume: vi.fn(),
        findLiveSessionIdForTask,
        abortSession,
      } as never);

      const res = await supertest(app).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );

      expect(res.status).toBe(200);
      expect(findLiveSessionIdForTask).toHaveBeenCalledWith('task-1');
      expect(abortSession).toHaveBeenCalledWith('live-session-1');
      expect(abortSession.mock.invocationCallOrder[0]).toBeLessThan(
        updateStatus.mock.invocationCallOrder[0],
      );
    });

    it('does not call abortSession when no live session exists for the task', async () => {
      const updateStatus = setupFakeBackend();
      const findLiveSessionIdForTask = vi.fn().mockReturnValue(undefined);
      const abortSession = vi.fn().mockResolvedValue(undefined);
      const app = buildAppWithServices({
        sendOrResume: vi.fn(),
        findLiveSessionIdForTask,
        abortSession,
      } as never);

      const res = await supertest(app).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );

      expect(res.status).toBe(200);
      expect(abortSession).not.toHaveBeenCalled();
      expect(updateStatus).toHaveBeenCalled();
    });
  });

  describe('action: rerun', () => {
    beforeEach(() => {
      vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
        makeAggregate('task-1', '⚠️ Needs Attention', {
          pr_pause_reason: 'ci_billing_blocked',
        }),
      ]);
    });

    it('returns 422 when no PR is found', async () => {
      vi.mocked(queries.getPRByNotionTaskId).mockReturnValue(null);
      const res = await supertest(buildApp()).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/No PR found/);
    });

    it('clears PR flags and runs autofix pipeline', async () => {
      vi.mocked(queries.getPRByNotionTaskId).mockReturnValue({
        pr_number: 42,
        repo: 'owner/repo',
        task_id: 'task-1',
      } as never);
      const runAutofixPipeline = vi
        .fn()
        .mockResolvedValue({ success: true, summary: '' });
      const app = buildAppWithServices(undefined, { runAutofixPipeline });

      const res = await supertest(app).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, action: 'rerun' });
      expect(queries.clearTerminalPRFlags).toHaveBeenCalledWith(
        42,
        'owner/repo',
        'human_unpark',
      );
      // runAutofixPipeline is fire-and-forget; wait a tick for it
      await new Promise((r) => setTimeout(r, 10));
      expect(runAutofixPipeline).toHaveBeenCalledWith(
        42,
        'owner/repo',
        'task-1',
      );
    });

    it('records a task_recovered audit event with rerun action', async () => {
      vi.mocked(queries.getPRByNotionTaskId).mockReturnValue({
        pr_number: 42,
        repo: 'owner/repo',
        task_id: 'task-1',
      } as never);
      const res = await supertest(buildApp()).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(200);
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'task_recovered',
          payload: expect.objectContaining({ action: 'rerun' }),
        }),
      );
    });
  });

  describe('action: resume', () => {
    beforeEach(() => {
      vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
        makeAggregate('task-1', '⚠️ Needs Attention', {
          pr_pause_reason: 'ci_failing',
          code_session_id: 'sess-1',
          code_session_status: 'idle',
        }),
      ]);
      vi.mocked(queries.getPRByNotionTaskId).mockReturnValue({
        pr_number: 99,
        repo: 'owner/repo',
        task_id: 'task-1',
      } as never);
    });

    it('returns 422 when no code session is found', async () => {
      vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
        makeAggregate('task-1', '⚠️ Needs Attention', {
          pr_pause_reason: 'ci_failing',
          code_session_id: null,
        }),
      ]);
      const res = await supertest(buildApp()).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/No code session/);
    });

    it('clears PR flags and calls sendOrResume with a nudge', async () => {
      const sendOrResume = vi.fn().mockResolvedValue('sess-1');
      const app = buildAppWithServices({ sendOrResume });

      const res = await supertest(app).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, action: 'resume' });
      expect(queries.clearTerminalPRFlags).toHaveBeenCalledWith(
        99,
        'owner/repo',
        'human_unpark',
      );
      expect(sendOrResume).toHaveBeenCalledWith(
        'sess-1',
        expect.stringContaining('Recovery requested'),
        { allowTerminal: true },
      );
    });

    it('passes allowTerminal:true so a killed session can be respawned', async () => {
      vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
        makeAggregate('task-1', '⚠️ Needs Attention', {
          pr_pause_reason: 'ci_failing',
          code_session_id: 'sess-1',
          code_session_status: 'killed',
        }),
      ]);
      const sendOrResume = vi.fn().mockResolvedValue('sess-1');
      const app = buildAppWithServices({ sendOrResume });

      const res = await supertest(app).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(200);
      expect(sendOrResume).toHaveBeenCalledWith('sess-1', expect.any(String), {
        allowTerminal: true,
      });
    });

    it('records a task_recovered audit event with resume action', async () => {
      const res = await supertest(buildApp()).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(200);
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'task_recovered',
          payload: expect.objectContaining({ action: 'resume' }),
        }),
      );
    });

    it('baseline_escalation_floor resolves to 422 (deliberate none, no recovery action)', async () => {
      vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
        makeAggregate('task-1', '⚠️ Needs Attention', {
          pr_pause_reason: 'baseline_escalation_floor',
          code_session_id: 'sess-1',
          code_session_status: 'idle',
        }),
      ]);
      const res = await supertest(buildApp()).post(
        '/api/tasks/task-1/recover?projectId=proj-1',
      );
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        error: 'No recovery action available for this task',
        pauseReason: 'baseline_escalation_floor',
      });
    });
  });
});

describe('emitTaskUpdated — single-task dependency resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setTaskBroadcast(null as never);
  });

  function taskCacheRow(task: NotionTask) {
    return {
      cache_key: task.id,
      raw_json: JSON.stringify(task),
      fetched_at: Date.now(),
    } as never;
  }

  it('broadcasts blocked: true with a non-empty blockerNames for a task with an unsatisfied dependency', async () => {
    const taskA: NotionTask = {
      id: 'notion:task-a',
      title: 'Task A',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: ['notion:task-b'],
      notionUrl: '',
    };
    const taskB: NotionTask = {
      id: 'notion:task-b',
      title: 'Task B',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    };
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-a', taskA.status, {
        raw_json: JSON.stringify(taskA),
      }),
    ]);
    vi.mocked(queries.getTaskCache).mockImplementation(((key: string) =>
      key === 'notion:task-b'
        ? taskCacheRow(taskB)
        : undefined) as typeof queries.getTaskCache);

    const broadcasts: Array<{ type: string; task?: NotionTask & object }> = [];
    setTaskBroadcast((msg) => broadcasts.push(msg as never));

    emitTaskUpdated('notion:task-a');
    await flushAsync();

    const updated = broadcasts.find((m) => m.type === 'task_updated');
    expect(updated).toBeDefined();
    const task = updated!.task as unknown as {
      taskId: string;
      blocked: boolean;
      blockerNames: string[];
    };
    expect(task.taskId).toBe('notion:task-a');
    expect(task.blocked).toBe(true);
    expect(task.blockerNames).toContain('Task B');
  });

  it('broadcasts blocked: false when all dependencies are ✅ Done', async () => {
    const taskA: NotionTask = {
      id: 'notion:task-a',
      title: 'Task A',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: ['notion:task-b'],
      notionUrl: '',
    };
    const taskB: NotionTask = {
      id: 'notion:task-b',
      title: 'Task B',
      status: '✅ Done',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    };
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-a', taskA.status, {
        raw_json: JSON.stringify(taskA),
      }),
    ]);
    vi.mocked(queries.getTaskCache).mockImplementation(((key: string) =>
      key === 'notion:task-b'
        ? taskCacheRow(taskB)
        : undefined) as typeof queries.getTaskCache);

    const broadcasts: Array<{ type: string; task?: object }> = [];
    setTaskBroadcast((msg) => broadcasts.push(msg as never));

    emitTaskUpdated('notion:task-a');
    await flushAsync();

    const updated = broadcasts.find((m) => m.type === 'task_updated');
    expect(updated).toBeDefined();
    const task = updated!.task as unknown as {
      blocked: boolean;
      blockerNames: string[];
    };
    expect(task.blocked).toBe(false);
    expect(task.blockerNames).toEqual([]);
  });

  it('the board-wide and non-milestone list endpoints resolve blocked/blockerNames identically to the single-task broadcast', async () => {
    const taskA: NotionTask = {
      id: 'notion:task-a',
      title: 'Task A',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: ['notion:task-b'],
      notionUrl: '',
    };
    const taskB: NotionTask = {
      id: 'notion:task-b',
      title: 'Task B',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    };
    const boardTasks = [taskA, taskB];

    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([
      makeAggregate('notion:task-a', taskA.status, {
        raw_json: JSON.stringify(taskA),
      }),
    ]);
    vi.mocked(queries.getTaskCache).mockImplementation(((key: string) => {
      if (key === 'board:board-1' || key === 'non_milestone:proj-1') {
        return {
          cache_key: key,
          raw_json: JSON.stringify(boardTasks),
          fetched_at: Date.now(),
        } as never;
      }
      if (key === 'notion:task-b') return taskCacheRow(taskB);
      return undefined;
    }) as typeof queries.getTaskCache);

    const activeRes = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    const nonMilestoneRes = await supertest(buildApp()).get(
      '/api/tasks/non-milestone?projectId=proj-1',
    );

    const broadcasts: Array<{ type: string; task?: object }> = [];
    setTaskBroadcast((msg) => broadcasts.push(msg as never));
    emitTaskUpdated('notion:task-a');
    await flushAsync();
    const broadcastTask = broadcasts.find((m) => m.type === 'task_updated')!
      .task as unknown as { blocked: boolean; blockerNames: string[] };

    const activeTask = activeRes.body.tasks.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-a',
    );
    const nonMilestoneTask = nonMilestoneRes.body.find(
      (t: { taskId: string }) => t.taskId === 'notion:task-a',
    );

    expect(activeTask.blocked).toBe(true);
    expect(activeTask.blockerNames).toEqual(broadcastTask.blockerNames);
    expect(nonMilestoneTask.blocked).toBe(activeTask.blocked);
    expect(nonMilestoneTask.blockerNames).toEqual(activeTask.blockerNames);
    expect(broadcastTask.blocked).toBe(activeTask.blocked);
  });
});

describe('dependency resolution — single source of truth', () => {
  it('only constructs DependencyResolver in one place in tasks.ts', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../routes/tasks.ts'),
      'utf-8',
    );
    const matches = source.match(/new DependencyResolver\(\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('annotateGroomDepBlocking — key space parity with passesGroomDepGate', () => {
  // Production-form ids: notion:-prefixed, hyphenated UUIDs — the form the
  // board-cache loader actually produces, and the form dependsOn entries
  // reference. annotateGroomDepBlocking must key its lookup map on
  // normalizeBoardId(t.id) (bare, hyphenless, lowercased) to match how
  // groomBlockingDepTitles/passesGroomDepGate look up deps, or every lookup
  // misses and every Backlog task with a dependency is reported blocked.
  const DEPENDENT_ID = 'notion:11111111-1111-1111-1111-111111111111';
  const CODE_DEP_ID = 'notion:22222222-2222-2222-2222-222222222222';
  const DESIGN_DEP_ID = 'notion:33333333-3333-3333-3333-333333333333';
  const DEFERRED_DEP_ID = 'notion:44444444-4444-4444-4444-444444444444';

  function dependentTask(dependsOn: string[]): NotionTask {
    return {
      id: DEPENDENT_ID,
      title: 'Dependent Task',
      status: '🔲 Backlog',
      type: '💻 Code',
      dependsOn,
      notionUrl: '',
    };
  }

  async function runActiveWithBoard(boardTasks: NotionTask[]) {
    vi.mocked(queries.getTaskCache).mockImplementation(((key: string) =>
      key === 'board:board-1'
        ? {
            cache_key: key,
            raw_json: JSON.stringify(boardTasks),
            fetched_at: Date.now(),
          }
        : undefined) as typeof queries.getTaskCache);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue(
      boardTasks.map((t) =>
        makeAggregate(t.id, t.status, { raw_json: JSON.stringify(t) }),
      ),
    );
    const res = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1',
    );
    expect(res.status).toBe(200);
    return res.body.tasks.find(
      (v: { taskId: string }) => v.taskId === DEPENDENT_ID,
    );
  }

  it('groomDepBlocked is false for a dependent whose only dep is a 🔲 Backlog 💻 Code task', async () => {
    const codeDep: NotionTask = {
      id: CODE_DEP_ID,
      title: 'Code Dep',
      status: '🔲 Backlog',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    };
    const view = await runActiveWithBoard([
      dependentTask([CODE_DEP_ID]),
      codeDep,
    ]);
    expect(view.groomDepBlocked).toBe(false);
  });

  it('groomDepBlocked is false for a dependent whose only dep is a ✅ Done 📐 Design task on the same board', async () => {
    const designDep: NotionTask = {
      id: DESIGN_DEP_ID,
      title: 'Design Dep',
      status: '✅ Done',
      type: '📐 Design',
      dependsOn: [],
      notionUrl: '',
    };
    const view = await runActiveWithBoard([
      dependentTask([DESIGN_DEP_ID]),
      designDep,
    ]);
    expect(view.groomDepBlocked).toBe(false);
  });

  it('groomDepBlocked is true with the dep title (not its id) for a dependent whose dep is ⏭️ Deferred', async () => {
    const deferredDep: NotionTask = {
      id: DEFERRED_DEP_ID,
      title: 'Deferred Dep Title',
      status: '⏭️ Deferred',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    };
    const view = await runActiveWithBoard([
      dependentTask([DEFERRED_DEP_ID]),
      deferredDep,
    ]);
    expect(view.groomDepBlocked).toBe(true);
    expect(view.groomDepBlockedReason).toContain('Deferred Dep Title');
    expect(view.groomDepBlockedReason).not.toContain(DEFERRED_DEP_ID);
  });

  it('agrees with passesGroomDepGate for the same task/dep fixture set', async () => {
    const codeDep: NotionTask = {
      id: CODE_DEP_ID,
      title: 'Code Dep',
      status: '🔲 Backlog',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    };
    const designDep: NotionTask = {
      id: DESIGN_DEP_ID,
      title: 'Design Dep',
      status: '✅ Done',
      type: '📐 Design',
      dependsOn: [],
      notionUrl: '',
    };
    const deferredDep: NotionTask = {
      id: DEFERRED_DEP_ID,
      title: 'Deferred Dep Title',
      status: '⏭️ Deferred',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: '',
    };
    const boardTasks = [
      dependentTask([CODE_DEP_ID, DESIGN_DEP_ID, DEFERRED_DEP_ID]),
      codeDep,
      designDep,
      deferredDep,
    ];

    const view = await runActiveWithBoard(boardTasks);

    const tasksById = new Map(
      boardTasks.map((t) => [normalizeBoardId(t.id), t]),
    );
    const gateAllows = passesGroomDepGate(boardTasks[0], tasksById);

    expect(view.groomDepBlocked).toBe(!gateAllows);
  });
});
