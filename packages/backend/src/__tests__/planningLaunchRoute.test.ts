import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../db/queries.js', () => ({
  getMilestoneById: mockGetMilestoneById,
  getProjectRowById: mockGetProjectRowById,
}));

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

  it('resolves ops and investigation to standard until the ops sibling type exists', () => {
    expect(resolveSessionType('ops')).toBe('standard');
    expect(resolveSessionType('investigation')).toBe('standard');
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

    const res = await request(makeApp(launcher)).post('/api/planning/launch').send({
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

    const res = await request(makeApp(launcher)).post('/api/planning/launch').send({
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

    const res = await request(makeApp(launcher)).post('/api/planning/launch').send({
      workflow: 'ops',
      projectId: 'p1',
      milestone: 'm1',
      taskIds: ['notion:bare-uuid-1'],
    });

    expect(res.status).toBe(202);
    expect(mockLoadOpsContext).toHaveBeenCalledWith('m1');
    const call = launchSelected.mock.calls[0][0];
    expect(call.sessionType).toBe('standard');
    expect(call.tasks).toHaveLength(1);
    expect(call.tasks[0].id).toBe('bare-uuid-1');
  });

  it('rejects an unsupported workflow', async () => {
    const launcher = {
      launchSelected: vi.fn(),
    } as unknown as OpsSessionLauncher;

    const res = await request(makeApp(launcher)).post('/api/planning/launch').send({
      workflow: 'nonsense',
      projectId: 'p1',
      milestone: 'm1',
      taskIds: ['notion:task-a'],
    });

    expect(res.status).toBe(400);
  });
});
