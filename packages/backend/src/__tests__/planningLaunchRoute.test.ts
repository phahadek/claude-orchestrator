import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';
import express from 'express';
import request from 'supertest';

const { mockLoadOpsContext, mockGetMilestoneById, mockGetProjectRowById } =
  vi.hoisted(() => ({
    mockLoadOpsContext: vi.fn(),
    mockGetMilestoneById: vi.fn(),
    mockGetProjectRowById: vi.fn(),
  }));

vi.mock('../ops/opsLoad.js', () => ({
  loadOpsContext: mockLoadOpsContext,
}));

vi.mock('../db/queries.js', () =>
  mockDbQueries({
    getMilestoneById: mockGetMilestoneById,
    getProjectRowById: mockGetProjectRowById,
  }),
);

import {
  createPlanningLaunchRouter,
  resolveSessionType,
} from '../routes/planningLaunch.js';
import type { OpsSessionLauncher } from '../orchestration/OpsSessionLauncher.js';

function makeApp(launcher: OpsSessionLauncher) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPlanningLaunchRouter(launcher));
  return app;
}

const worklistBundle = {
  contextPages: [],
  boards: {
    target: { milestone: 'm1', board: 'b1', counts: {} },
    neighbours: [],
  },
  worklist: {
    executable: [
      {
        id: 'bare-uuid-1',
        title: 'Task 1',
        status: '🗂️ Ready',
        url: 'https://notion.so/1',
      },
    ],
    dep_blocked: [],
    needs_grooming: [],
    closed_not_done: [],
    leftover_tooling: [],
    test_authoring: [],
    newly_unblocked: [],
  },
};

beforeEach(() => {
  mockLoadOpsContext.mockReset();
  mockGetMilestoneById.mockReset();
  mockGetProjectRowById.mockReset();
  mockGetMilestoneById.mockReturnValue({ id: 'm1', project_id: 'p1' });
  mockGetProjectRowById.mockReturnValue({
    id: 'p1',
    context_url: 'https://notion.so/ctx',
  });
  mockLoadOpsContext.mockResolvedValue(worklistBundle);
});

describe('resolveSessionType', () => {
  it('resolves groom and design to their own sessionType', () => {
    expect(resolveSessionType('groom')).toBe('groom');
    expect(resolveSessionType('design')).toBe('design');
  });

  it('resolves ops and investigation to sessionType=ops', () => {
    expect(resolveSessionType('ops')).toBe('ops');
    expect(resolveSessionType('investigation')).toBe('ops');
  });

  it('returns null for an unrecognized workflow', () => {
    expect(resolveSessionType('nonsense')).toBeNull();
  });
});

describe('POST /api/planning/launch', () => {
  it('dispatches a groom session per selected task with sessionType=groom', async () => {
    const launchSelected = vi
      .fn()
      .mockResolvedValue({ launched: ['task-a', 'task-b'], deferred: [] });
    const launcher = { launchSelected } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher))
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        projectId: 'p1',
        milestone: 'm1',
        taskIds: ['notion:task-a', 'notion:task-b'],
      });

    expect(res.status).toBe(202);
    expect(launchSelected).toHaveBeenCalledTimes(1);
    const call = launchSelected.mock.calls[0][0];
    expect(call.sessionType).toBe('groom');
    expect(call.tasks.map((t: { id: string }) => t.id)).toEqual([
      'task-a',
      'task-b',
    ]);
    expect(res.body.launched).toEqual(['task-a', 'task-b']);
    expect(mockLoadOpsContext).not.toHaveBeenCalled();
  });

  it('dispatches a design session per selected task with sessionType=design', async () => {
    const launchSelected = vi
      .fn()
      .mockResolvedValue({ launched: ['task-a'], deferred: [] });
    const launcher = { launchSelected } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher))
      .post('/api/planning/launch')
      .send({
        workflow: 'design',
        projectId: 'p1',
        milestone: 'm1',
        taskIds: ['notion:task-a'],
      });

    expect(res.status).toBe(202);
    const call = launchSelected.mock.calls[0][0];
    expect(call.sessionType).toBe('design');
  });

  it('dispatches an ops session by reusing the ops loader worklist, matching prefixed ids to bare ids', async () => {
    const launchSelected = vi
      .fn()
      .mockResolvedValue({ launched: ['bare-uuid-1'], deferred: [] });
    const launcher = { launchSelected } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher))
      .post('/api/planning/launch')
      .send({
        workflow: 'ops',
        projectId: 'p1',
        milestone: 'm1',
        taskIds: ['notion:bare-uuid-1'],
      });

    expect(res.status).toBe(202);
    expect(mockLoadOpsContext).toHaveBeenCalledWith('m1');
    const call = launchSelected.mock.calls[0][0];
    expect(call.sessionType).toBe('ops');
    expect(call.tasks).toHaveLength(1);
    expect(call.tasks[0].id).toBe('bare-uuid-1');
  });

  it('rejects an unsupported workflow', async () => {
    const launcher = {
      launchSelected: vi.fn(),
    } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher))
      .post('/api/planning/launch')
      .send({
        workflow: 'nonsense',
        projectId: 'p1',
        milestone: 'm1',
        taskIds: ['notion:task-a'],
      });

    expect(res.status).toBe(400);
  });

  it('responds 202 with failed[] present when a dispatch fails, rather than reporting a clean launch', async () => {
    const launchSelected = vi.fn().mockResolvedValue({
      launched: [],
      deferred: [],
      failed: [
        {
          taskId: 'task-a',
          reason: 'Max concurrent planning sessions (5) reached',
        },
      ],
    });
    const launcher = { launchSelected } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher))
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        projectId: 'p1',
        milestone: 'm1',
        taskIds: ['notion:task-a'],
      });

    expect(res.status).toBe(202);
    expect(res.body.launched).toEqual([]);
    expect(res.body.failed).toEqual([
      {
        taskId: 'task-a',
        reason: 'Max concurrent planning sessions (5) reached',
      },
    ]);
  });

  it('does not report a 202 dispatch for an unknown milestone', async () => {
    mockGetMilestoneById.mockReturnValue(undefined);
    const launcher = {
      launchSelected: vi.fn(),
    } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher))
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        projectId: 'p1',
        milestone: 'unknown-milestone',
        taskIds: ['notion:task-a'],
      });

    expect(res.status).toBe(404);
    expect(launcher.launchSelected).not.toHaveBeenCalled();
  });

  it('still responds 500 for a genuine request-level fault, distinct from a per-task dispatch failure', async () => {
    mockLoadOpsContext.mockRejectedValue(new Error('board load failed'));
    const launcher = {
      launchSelected: vi.fn(),
    } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher))
      .post('/api/planning/launch')
      .send({
        workflow: 'ops',
        projectId: 'p1',
        milestone: 'm1',
        taskIds: ['notion:bare-uuid-1'],
      });

    expect(res.status).toBe(500);
    expect(launcher.launchSelected).not.toHaveBeenCalled();
  });
});
