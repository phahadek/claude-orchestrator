import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const m = vi.hoisted(() => ({
  getActiveTaskAggregates: vi.fn(),
  getTaskCache: vi.fn(),
  getTaskIdsOrderedByFetchedAt: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  getProjectById: vi.fn().mockReturnValue({ id: 'proj-1', boardId: 'b1' }),
  getAllProjects: vi.fn().mockReturnValue([]),
  runtimeSettings: { task_cache_refresh_interval_ms: 60_000 },
}));

vi.mock('../../db/queries.js', () => ({
  getTaskCache: m.getTaskCache,
  getTaskIdsOrderedByFetchedAt: m.getTaskIdsOrderedByFetchedAt,
  listTaskExecutionFlagsForProject: vi.fn().mockReturnValue([]),
  getActiveTaskAggregates: m.getActiveTaskAggregates,
  clearTaskPauseReason: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  deleteTaskCacheRow: vi.fn(),
  getTaskRepoAssignment: vi.fn().mockReturnValue(undefined),
  setTaskRepoAssignment: vi.fn(),
  getTaskExecutionFlags: vi.fn().mockReturnValue(undefined),
  setTaskUrgent: vi.fn(),
  isExecuteNowExpired: vi.fn().mockReturnValue(false),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  getTaskPauseReason: vi.fn().mockReturnValue(null),
  hasAwaitingDispositionIntentForTask: vi.fn().mockReturnValue(false),
}));

vi.mock('../../projects/ProjectService.js', () => ({
  ProjectService: { getMilestone: vi.fn() },
  getProjectRepos: vi.fn().mockReturnValue([]),
}));
vi.mock('../../tasks/TaskBackend.js', () => ({ getTaskBackend: vi.fn() }));
vi.mock('../../audit/AuditLog.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../config/settings.js', () => ({
  typedGetSetting: vi.fn().mockReturnValue(3),
}));
vi.mock('../../tasks/TaskStatusEngine.js', () => ({
  deriveDisplayStatus: vi.fn().mockReturnValue('ready'),
  recordDisplayStatusTransition: vi.fn(),
}));

import { createTasksRouter } from '../tasks.js';

const N = 350;
const ids = Array.from({ length: N }, (_, i) => `notion:t${i}`);

function buildApp() {
  const app = express();
  app.use('/api', createTasksRouter());
  return app;
}

function rowFor(id: string) {
  return {
    task_id: id,
    raw_json: JSON.stringify({
      id,
      title: `Title ${id}`,
      status: '🗂️ Ready',
      dependsOn: [],
    }),
  };
}

// Newest fetched first: reverse of cache order, so a wrong order is detectable.
const orderedIds = [...ids].reverse();

beforeEach(() => {
  vi.clearAllMocks();
  m.getTaskCache.mockReturnValue({
    raw_json: JSON.stringify(
      ids.map((id) => ({ id, title: id, status: '🗂️ Ready', dependsOn: [] })),
    ),
    fetched_at: Date.now(),
  });
  m.getTaskIdsOrderedByFetchedAt.mockReturnValue(orderedIds);
  m.getActiveTaskAggregates.mockImplementation((chunk: string[]) =>
    chunk.map(rowFor),
  );
});

describe('GET /api/tasks/active chunked build', () => {
  for (const shape of ['full', 'summary'] as const) {
    it(`returns every task in fetched_at order for shape=${shape}`, async () => {
      const res = await supertest(buildApp()).get(
        `/api/tasks/active?projectId=proj-1&shape=${shape}`,
      );
      expect(res.status).toBe(200);
      const body = res.body as { tasks: Array<{ taskId: string }> };
      expect(body.tasks).toHaveLength(N);
      expect(body.tasks.map((t) => t.taskId)).toEqual(orderedIds);
      // Chunked: more than one aggregate read, none over 100 ids.
      expect(m.getActiveTaskAggregates.mock.calls.length).toBeGreaterThan(1);
      for (const [chunk] of m.getActiveTaskAggregates.mock.calls) {
        expect((chunk as string[]).length).toBeLessThanOrEqual(100);
      }
    });
  }

  // Reference build: a one-task board is a single chunk with no chunk boundary,
  // so it is the unchunked build of that row. The tasks are independent
  // (no dependsOn), so the 350-task board must yield identical views.
  for (const shape of ['full', 'summary'] as const) {
    it(`each view on the ${N}-task board deep-equals its unchunked build for shape=${shape}`, async () => {
      const big = await supertest(buildApp()).get(
        `/api/tasks/active?projectId=proj-1&shape=${shape}`,
      );
      const bigTasks = (
        big.body as {
          tasks: Array<Record<string, unknown> & { taskId: string }>;
        }
      ).tasks;
      expect(bigTasks).toHaveLength(N);

      const byId = new Map(bigTasks.map((t) => [t.taskId, t]));
      for (let i = 0; i < N; i += 7) {
        const id = ids[i];
        m.getTaskCache.mockReturnValue({
          raw_json: JSON.stringify([
            { id, title: id, status: '🗂️ Ready', dependsOn: [] },
          ]),
          fetched_at: Date.now(),
        });
        m.getTaskIdsOrderedByFetchedAt.mockReturnValue([id]);
        const single = await supertest(buildApp()).get(
          `/api/tasks/active?projectId=proj-1&shape=${shape}`,
        );
        const [ref] = (single.body as { tasks: Array<Record<string, unknown>> })
          .tasks;
        const { executionRank: _a, ...refRest } = ref;
        const { executionRank: _b, ...bigRest } = byId.get(id)!;
        expect(bigRest).toEqual(refRest);
      }
    });
  }

  it('yields to the event loop before the response is sent', async () => {
    let immediateRan = false;
    const req = supertest(buildApp())
      .get('/api/tasks/active?projectId=proj-1&shape=full')
      .then((r) => ({ r, immediateRanAtResponse: immediateRan }));
    setImmediate(() => {
      immediateRan = true;
    });
    const { r, immediateRanAtResponse } = await req;
    expect(r.status).toBe(200);
    expect(immediateRanAtResponse).toBe(true);
  });
});
