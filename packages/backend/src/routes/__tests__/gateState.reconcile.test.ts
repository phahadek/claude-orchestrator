/**
 * Tests for the gate-state reconcile route (packages/backend/src/routes/gateState.ts).
 *
 * AC: POST /api/gate/reconcile requires `project` in the body (a deploy SHA
 * is always project-specific) and, when present, scopes the reconcile to
 * that project's git-ancestry source — never the unscoped default, which
 * runs `git merge-base` in the backend process's own cwd rather than any
 * project's clone.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateServiceMock = vi.hoisted(() => ({
  getGateReadiness: vi.fn(),
  reconcileGateRunnability: vi.fn(),
  defaultAncestrySourceForProject: vi.fn(),
  nextRunnableGateItems: vi.fn(),
  nextPendingGateItems: vi.fn(),
  getGateItem: vi.fn(),
  getGateItemDetail: vi.fn(),
  getVerifySessionsForGateItem: vi.fn(),
  listGateItems: vi.fn(),
  listMilestoneReadiness: vi.fn(),
  appendGateItemEvent: vi.fn(),
  approveGateItem: vi.fn(),
  rejectGateItem: vi.fn(),
  reopenGateItem: vi.fn(),
  reclassifyGateItem: vi.fn(),
  backfillGateTask: vi.fn(),
  carryForwardGateItem: vi.fn(),
  getGateVerifyFleetState: vi.fn(),
}));

vi.mock('../../gate/gateService.js', () => gateServiceMock);

const milestoneResolverMock = vi.hoisted(() => ({
  resolveMilestoneForProject: vi.fn(
    (_project: string, milestone: string) => milestone,
  ),
  resolveMilestoneAnyProject: vi.fn((milestone: string) => milestone),
  UnknownMilestoneError: class UnknownMilestoneError extends Error {},
}));

vi.mock('../../projects/milestoneResolver.js', () => milestoneResolverMock);

import { createGateStateRouter } from '../gateState.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createGateStateRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/gate/reconcile', () => {
  it('400s without a project, never calling the service', async () => {
    const res = await request(makeApp())
      .post('/api/gate/reconcile')
      .send({ deploySha: 'sha123' });

    expect(res.status).toBe(400);
    expect(gateServiceMock.reconcileGateRunnability).not.toHaveBeenCalled();
  });

  it('400s without a deploySha, never calling the service', async () => {
    const res = await request(makeApp())
      .post('/api/gate/reconcile')
      .send({ project: 'polimarket-analyser' });

    expect(res.status).toBe(400);
    expect(gateServiceMock.reconcileGateRunnability).not.toHaveBeenCalled();
  });

  it('scopes the reconcile to the given project, using its per-project ancestry source', async () => {
    const scopedAncestrySource = { isAncestor: vi.fn() };
    gateServiceMock.defaultAncestrySourceForProject.mockReturnValue(
      scopedAncestrySource,
    );
    const result = { markedRunnable: ['g1'], reopened: [] };
    gateServiceMock.reconcileGateRunnability.mockResolvedValue(result);

    const res = await request(makeApp())
      .post('/api/gate/reconcile')
      .send({ project: 'polimarket-analyser', deploySha: 'sha123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(
      gateServiceMock.defaultAncestrySourceForProject,
    ).toHaveBeenCalledWith('polimarket-analyser');
    expect(gateServiceMock.reconcileGateRunnability).toHaveBeenCalledWith(
      'sha123',
      {
        project: 'polimarket-analyser',
        ancestrySource: scopedAncestrySource,
      },
    );
  });
});
