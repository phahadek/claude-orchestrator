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
}));

vi.mock('../../deploy/deployService.js', () => deployServiceMock);

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
    expect(res.body).toEqual({ projectId: 'claude-orchestrator', sha: 'abc123' });
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
