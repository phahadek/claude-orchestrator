/**
 * Tests for the deploy report-in route (packages/backend/src/routes/deploy.ts).
 *
 * AC: the route records a project's deployed SHA (skill→orchestrator
 * direction) and fires the gate-verification reconciler immediately
 * (event-driven, nothing polled). The route never reads a deploy-written
 * file — it only calls the deployService record function.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const deployServiceMock = vi.hoisted(() => ({
  reportProjectDeploy: vi.fn(),
  getLatestDeployRun: vi.fn(),
  listDeployRunEvents: vi.fn(),
  DeployRunConflictError: class DeployRunConflictError extends Error {},
}));

vi.mock('../../deploy/deployService.js', () => deployServiceMock);

const deployOrchestratorMock = vi.hoisted(() => ({
  startDeploy: vi.fn(),
}));

vi.mock('../../deploy/DeployOrchestrator.js', () => ({
  DeployOrchestrator: vi.fn().mockImplementation(() => deployOrchestratorMock),
}));

const queriesMock = vi.hoisted(() => ({
  getProjectRowById: vi.fn(),
}));

vi.mock('../../db/queries.js', () => queriesMock);

import { createDeployRouter, setDeployScheduler } from '../deploy.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createDeployRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  setDeployScheduler(null as never);
});

describe('POST /api/deploy/report-in', () => {
  it('records the projects deployed sha via deployService', async () => {
    const res = await request(makeApp())
      .post('/api/deploy/report-in')
      .send({ projectId: 'claude-orchestrator', sha: 'abc123' });

    expect(deployServiceMock.reportProjectDeploy).toHaveBeenCalledWith(
      'claude-orchestrator',
      'abc123',
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      projectId: 'claude-orchestrator',
      sha: 'abc123',
    });
  });

  it('400s when projectId or sha is missing, never recording anything', async () => {
    const res = await request(makeApp())
      .post('/api/deploy/report-in')
      .send({ projectId: 'claude-orchestrator' });

    expect(res.status).toBe(400);
    expect(deployServiceMock.reportProjectDeploy).not.toHaveBeenCalled();
  });

  it('fires triggerNow on the gate-verification reconciler after recording', async () => {
    const triggerNow = vi.fn().mockResolvedValue(undefined);
    setDeployScheduler({ triggerNow } as never);

    await request(makeApp())
      .post('/api/deploy/report-in')
      .send({ projectId: 'claude-orchestrator', sha: 'abc123' });

    expect(triggerNow).toHaveBeenCalledWith('gate_verification_reconciler');
  });

  it('still records and responds when no scheduler is wired', async () => {
    const res = await request(makeApp())
      .post('/api/deploy/report-in')
      .send({ projectId: 'claude-orchestrator', sha: 'abc123' });

    expect(res.status).toBe(202);
    expect(deployServiceMock.reportProjectDeploy).toHaveBeenCalled();
  });
});

describe('POST /api/deploy/launch', () => {
  it('starts a deploy_run behind the confirm-gate and returns it, with no targetSha given', async () => {
    queriesMock.getProjectRowById.mockReturnValue({
      id: 'claude-orchestrator',
      project_dir: '/repo/claude-orchestrator',
    });
    const run = {
      run_id: 'run-1',
      project: 'claude-orchestrator',
      target_sha: 'resolved-dev-sha',
      current_step: null,
      status: 'running',
      started_at: '2026-07-20T00:00:00.000Z',
      completed_at: null,
    };
    deployOrchestratorMock.startDeploy.mockResolvedValue(run);

    const res = await request(makeApp())
      .post('/api/deploy/launch')
      .send({ projectId: 'claude-orchestrator' });

    expect(deployOrchestratorMock.startDeploy).toHaveBeenCalledWith();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ run });
  });

  it('400s when projectId is missing', async () => {
    const res = await request(makeApp()).post('/api/deploy/launch').send({});

    expect(res.status).toBe(400);
    expect(deployOrchestratorMock.startDeploy).not.toHaveBeenCalled();
  });

  it('404s an unknown project', async () => {
    queriesMock.getProjectRowById.mockReturnValue(undefined);

    const res = await request(makeApp())
      .post('/api/deploy/launch')
      .send({ projectId: 'unknown' });

    expect(res.status).toBe(404);
  });

  it('409s when the project already has an active run', async () => {
    queriesMock.getProjectRowById.mockReturnValue({
      id: 'claude-orchestrator',
      project_dir: '/repo/claude-orchestrator',
    });
    deployOrchestratorMock.startDeploy.mockRejectedValue(
      new deployServiceMock.DeployRunConflictError('already running'),
    );

    const res = await request(makeApp())
      .post('/api/deploy/launch')
      .send({ projectId: 'claude-orchestrator' });

    expect(res.status).toBe(409);
  });
});

describe('GET /api/deploy/status', () => {
  it('returns the active run and its events for a project', async () => {
    const run = {
      run_id: 'run-1',
      project: 'claude-orchestrator',
      target_sha: 'abc123',
      current_step: 'confirm',
      status: 'running',
      started_at: '2026-07-20T00:00:00.000Z',
      completed_at: null,
    };
    const events = [
      {
        id: 1,
        run_id: 'run-1',
        step: 'confirm',
        event_type: 'step_started',
        disposition: null,
        detail: null,
        at: '2026-07-20T00:00:01.000Z',
      },
    ];
    deployServiceMock.getLatestDeployRun.mockReturnValue(run);
    deployServiceMock.listDeployRunEvents.mockReturnValue(events);

    const res = await request(makeApp()).get(
      '/api/deploy/status?projectId=claude-orchestrator',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ run, events });
  });

  it('returns a null run and empty events when the project has none active', async () => {
    deployServiceMock.getLatestDeployRun.mockReturnValue(undefined);

    const res = await request(makeApp()).get(
      '/api/deploy/status?projectId=claude-orchestrator',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ run: null, events: [] });
  });

  it('returns the latest terminal run with its failure-detail events when no run is active', async () => {
    const run = {
      run_id: 'run-2',
      project: 'claude-orchestrator',
      target_sha: 'abc123',
      current_step: 'provision',
      status: 'failed',
      started_at: '2026-07-20T00:00:00.000Z',
      completed_at: '2026-07-20T00:05:00.000Z',
    };
    const events = [
      {
        id: 5,
        run_id: 'run-2',
        step: 'provision',
        event_type: 'step_failed',
        disposition: null,
        detail: 'sudo: unknown user deploy',
        at: '2026-07-20T00:04:59.000Z',
      },
    ];
    deployServiceMock.getLatestDeployRun.mockReturnValue(run);
    deployServiceMock.listDeployRunEvents.mockReturnValue(events);

    const res = await request(makeApp()).get(
      '/api/deploy/status?projectId=claude-orchestrator',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ run, events });
  });

  it('400s when projectId is missing', async () => {
    const res = await request(makeApp()).get('/api/deploy/status');

    expect(res.status).toBe(400);
  });
});
