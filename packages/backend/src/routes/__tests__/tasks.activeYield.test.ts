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

  it('summary shape is the full shape projected, same order', async () => {
    const full = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1&shape=full',
    );
    const summary = await supertest(buildApp()).get(
      '/api/tasks/active?projectId=proj-1&shape=summary',
    );
    const f = full.body as { tasks: Array<{ taskId: string }> };
    const s = summary.body as { tasks: Array<{ taskId: string }> };
    expect(s.tasks.map((t) => t.taskId)).toEqual(f.tasks.map((t) => t.taskId));
  });

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
