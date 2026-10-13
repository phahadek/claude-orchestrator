import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const m = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  setTaskUrgent: vi.fn(),
  getTaskExecutionFlags: vi.fn(),
  getActiveTaskAggregates: vi.fn(),
  recordEvent: vi.fn(),
  getAllProjects: vi.fn(),
  getTaskCache: vi.fn(),
  listTaskExecutionFlagsForProject: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  getProjectById: m.getProjectById,
  getAllProjects: m.getAllProjects,
  runtimeSettings: {},
}));

vi.mock('../../db/queries.js', () => ({
  getTaskCache: m.getTaskCache,
  listTaskExecutionFlagsForProject: m.listTaskExecutionFlagsForProject,
  getActiveTaskAggregates: m.getActiveTaskAggregates,
  clearTaskPauseReason: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  deleteTaskCacheRow: vi.fn(),
  getTaskRepoAssignment: vi.fn().mockReturnValue(undefined),
  setTaskRepoAssignment: vi.fn(),
  getTaskExecutionFlags: m.getTaskExecutionFlags,
  setTaskUrgent: m.setTaskUrgent,
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  getTaskPauseReason: vi.fn().mockReturnValue(null),
  hasAwaitingDispositionIntentForTask: vi.fn().mockReturnValue(false),
}));

vi.mock('../../projects/ProjectService.js', () => ({
  ProjectService: { getMilestone: vi.fn() },
  getProjectRepos: vi.fn().mockReturnValue([]),
}));

vi.mock('../../tasks/TaskBackend.js', () => ({ getTaskBackend: vi.fn() }));

vi.mock('../../audit/AuditLog.js', () => ({ recordEvent: m.recordEvent }));

vi.mock('../../config/settings.js', () => ({
  typedGetSetting: vi.fn().mockReturnValue(3),
}));

vi.mock('../../tasks/TaskStatusEngine.js', () => ({
  deriveDisplayStatus: vi.fn().mockReturnValue('ready'),
  recordDisplayStatusTransition: vi.fn(),
}));

import { createTasksRouter, setTaskBroadcast } from '../tasks.js';
import type { ServerMessage } from '../../ws/types.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createTasksRouter());
  return app;
}

function makeRow() {
  return {
    task_id: 'notion:abc',
    raw_json: JSON.stringify({
      id: 'abc',
      title: 'T',
      status: '🗂️ Ready',
      dependsOn: [],
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getProjectById.mockReturnValue({ id: 'proj-1', name: 'P' });
  m.getTaskExecutionFlags.mockReturnValue(undefined);
  m.getActiveTaskAggregates.mockReturnValue([]);
  m.getAllProjects.mockReturnValue([]);
  m.getTaskCache.mockReturnValue(null);
  m.listTaskExecutionFlagsForProject.mockReturnValue([]);
});

describe('POST /api/tasks/:taskId/urgent', () => {
  it('toggles urgent, audits, and emits task_updated', async () => {
    const broadcast = vi.fn<(msg: ServerMessage) => void>();
    setTaskBroadcast(broadcast);
    m.getActiveTaskAggregates.mockReturnValue([makeRow()]);
    m.getTaskExecutionFlags
      .mockReturnValueOnce({ urgent: 0 })
      .mockReturnValue({ urgent: 1 });

    const res = await supertest(buildApp())
      .post('/api/tasks/abc/urgent?projectId=proj-1')
      .send({ urgent: true });

    expect(res.status).toBe(200);
    expect(m.setTaskUrgent).toHaveBeenCalledWith(
      'notion:abc',
      'proj-1',
      true,
      'human',
    );
    expect(m.recordEvent).toHaveBeenCalledTimes(1);
    expect(m.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'task_urgent_changed',
        payload: { urgent: true, previous: false },
      }),
    );
    expect(m.getActiveTaskAggregates).toHaveBeenCalledWith(['notion:abc']);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    const msg = broadcast.mock.calls[0][0] as Extract<
      ServerMessage,
      { type: 'task_updated' }
    >;
    expect(msg.task.urgent).toBe(true);
  });

  it('emits task_updated for every ancestor whose inherited urgency changed', async () => {
    const board = [
      { id: 'a', title: 'A', status: '🗂️ Ready', dependsOn: [] },
      { id: 'b', title: 'B', status: '🗂️ Ready', dependsOn: ['a'] },
      { id: 'c', title: 'C', status: '🗂️ Ready', dependsOn: ['b'] },
      { id: 'd', title: 'D', status: '🗂️ Ready', dependsOn: [] },
    ];
    let cUrgent = false;
    m.getAllProjects.mockReturnValue([
      { id: 'proj-1', name: 'P', boardId: 'b1' },
    ]);
    m.getTaskCache.mockImplementation((key: string) =>
      key === 'board:b1'
        ? { raw_json: JSON.stringify(board), fetched_at: 1 }
        : null,
    );
    m.listTaskExecutionFlagsForProject.mockImplementation(() =>
      cUrgent
        ? [
            {
              task_id: 'notion:c',
              project_id: 'proj-1',
              urgent: 1,
              urgent_set_by: 'human',
              urgent_set_at: 1,
              execute_now_reason: null,
              execute_now_set_at: null,
            },
          ]
        : [],
    );
    m.setTaskUrgent.mockImplementation(
      (_id: string, _p: string, urgent: boolean) => {
        cUrgent = urgent;
      },
    );
    m.getActiveTaskAggregates.mockImplementation((ids: string[]) =>
      ids.map((id) => ({
        task_id: id,
        raw_json: JSON.stringify(
          board.find((t) => `notion:${t.id}` === id) ?? board[0],
        ),
      })),
    );
    const broadcast = vi.fn<(msg: ServerMessage) => void>();
    setTaskBroadcast(broadcast);

    const res = await supertest(buildApp())
      .post('/api/tasks/c/urgent?projectId=proj-1')
      .send({ urgent: true });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(3));
    const ids = broadcast.mock.calls
      .map(
        (c) =>
          (c[0] as Extract<ServerMessage, { type: 'task_updated' }>).task
            .taskId,
      )
      .sort();
    expect(ids).toEqual(['notion:a', 'notion:b', 'notion:c']);
  });

  it('returns 400 and writes nothing for a non-boolean body', async () => {
    const res = await supertest(buildApp())
      .post('/api/tasks/abc/urgent?projectId=proj-1')
      .send({ urgent: 'yes' });

    expect(res.status).toBe(400);
    expect(m.setTaskUrgent).not.toHaveBeenCalled();
    expect(m.recordEvent).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown project', async () => {
    m.getProjectById.mockReturnValue(undefined);
    const res = await supertest(buildApp())
      .post('/api/tasks/abc/urgent?projectId=nope')
      .send({ urgent: true });

    expect(res.status).toBe(404);
    expect(m.setTaskUrgent).not.toHaveBeenCalled();
  });

  it('builds urgent:false for an unflagged task', async () => {
    const broadcast = vi.fn<(msg: ServerMessage) => void>();
    setTaskBroadcast(broadcast);
    m.getActiveTaskAggregates.mockReturnValue([makeRow()]);

    await supertest(buildApp())
      .post('/api/tasks/abc/urgent?projectId=proj-1')
      .send({ urgent: false });

    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    const msg = broadcast.mock.calls[0][0] as Extract<
      ServerMessage,
      { type: 'task_updated' }
    >;
    expect(msg.task.urgent).toBe(false);
  });
});
