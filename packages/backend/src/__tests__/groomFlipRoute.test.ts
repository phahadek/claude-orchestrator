import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockFlipToReady = vi.fn();
const mockGetTaskBackend = vi.fn();
const mockResolveMilestoneForProject = vi.fn();
const mockGetProjectRowById = vi.fn();

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: (...args: unknown[]) => mockGetTaskBackend(...args),
}));

vi.mock('../db/queries', () => ({
  getProjectRowById: (...args: unknown[]) => mockGetProjectRowById(...args),
}));

vi.mock('../tasks/TaskWriteCommands', async () => {
  const actual = await vi.importActual<
    typeof import('../tasks/TaskWriteCommands')
  >('../tasks/TaskWriteCommands');
  return {
    ...actual,
    BackendTaskWriteCommands: vi.fn().mockImplementation(() => ({
      flipToReady: (...args: unknown[]) => mockFlipToReady(...args),
    })),
  };
});

vi.mock('../projects/milestoneResolver', async () => {
  const actual = await vi.importActual<
    typeof import('../projects/milestoneResolver')
  >('../projects/milestoneResolver');
  return {
    ...actual,
    resolveMilestoneForProject: (...args: unknown[]) =>
      mockResolveMilestoneForProject(...args),
  };
});

import { GroomingGateError } from '../groom/groomGate';
import { ReadinessGateError } from '../tasks/readinessGate';
import { createGroomFlipRouter } from '../routes/groomFlip';
import type { OpsSessionLauncher } from '../orchestration/OpsSessionLauncher';

const mockLaunchSelected = vi.fn();
const mockLauncher = {
  launchSelected: (...args: unknown[]) => mockLaunchSelected(...args),
} as unknown as OpsSessionLauncher;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createGroomFlipRouter(mockLauncher));
  return app;
}

const validBody = {
  project: 'polimarket-analyser',
  taskId: 'notion:abc',
  title: 'Add the webhook',
  milestone: 'M12',
  dependsOn: ['notion:dep-1'],
  groomingGate: {
    size_check: { decision: 'no_split' },
    type_check: { decision: 'none' },
  },
  gateContribution: {
    classification: 'Read-Only',
    items: [{ text: 'Verify the webhook fires' }],
  },
  seedContribution: {
    decision: 'seeds',
    seeds: [{ spec: 'Add webhook_url to config' }],
  },
};

beforeEach(() => {
  mockFlipToReady.mockReset();
  mockGetTaskBackend.mockReset();
  mockResolveMilestoneForProject.mockReset();
  mockResolveMilestoneForProject.mockReturnValue('M12');
  mockGetTaskBackend.mockReturnValue({ type: 'notion' });
  mockGetProjectRowById.mockReset();
  mockGetProjectRowById.mockReturnValue({
    id: 'polimarket-analyser',
    context_url: 'https://www.notion.so/proj-context',
  });
  mockLaunchSelected.mockReset();
  mockLaunchSelected.mockResolvedValue({
    launched: ['notion:abc'],
    deferred: [],
  });
});

describe('POST /api/groom/flip', () => {
  it('resolves the canonical milestone and delegates the whole payload to flipToReady, ids never re-typed', async () => {
    mockFlipToReady.mockResolvedValue({
      gate: { itemIds: ['gate-item-1'], marker: {} },
      seed: { itemIds: ['seed-item-1'], marker: {} },
    });

    const res = await request(makeApp())
      .post('/api/groom/flip')
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.gate.itemIds).toEqual(['gate-item-1']);
    expect(res.body.seed.itemIds).toEqual(['seed-item-1']);
    expect(mockResolveMilestoneForProject).toHaveBeenCalledWith(
      'polimarket-analyser',
      'M12',
    );
    expect(mockFlipToReady).toHaveBeenCalledWith(
      {
        taskId: 'notion:abc',
        title: 'Add the webhook',
        project: 'polimarket-analyser',
        milestone: 'M12',
        dependsOn: ['notion:dep-1'],
        groomingGate: validBody.groomingGate,
        gateContribution: validBody.gateContribution,
        seedContribution: validBody.seedContribution,
      },
      { source: 'human' },
    );
  });

  for (const field of [
    'project',
    'taskId',
    'title',
    'milestone',
    'dependsOn',
    'groomingGate',
  ]) {
    it(`400s when ${field} is missing`, async () => {
      const body = { ...validBody } as Record<string, unknown>;
      delete body[field];

      const res = await request(makeApp()).post('/api/groom/flip').send(body);

      expect(res.status).toBe(400);
      expect(mockFlipToReady).not.toHaveBeenCalled();
    });
  }

  it('400s when gateContribution.classification is missing', async () => {
    const body = {
      ...validBody,
      gateContribution: { items: [] },
    };
    const res = await request(makeApp()).post('/api/groom/flip').send(body);
    expect(res.status).toBe(400);
    expect(mockFlipToReady).not.toHaveBeenCalled();
  });

  it('400s when seedContribution.decision is missing', async () => {
    const body = {
      ...validBody,
      seedContribution: { seeds: [] },
    };
    const res = await request(makeApp()).post('/api/groom/flip').send(body);
    expect(res.status).toBe(400);
    expect(mockFlipToReady).not.toHaveBeenCalled();
  });

  it('translates a GroomingGateError to 409 with the reasons', async () => {
    mockFlipToReady.mockRejectedValue(
      new GroomingGateError(['size_check is missing']),
    );

    const res = await request(makeApp())
      .post('/api/groom/flip')
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.reasons).toEqual(['size_check is missing']);
  });

  it('translates a ReadinessGateError to 409 with the violations', async () => {
    const violations = [{ tier: 1, detail: 'missing summary' }];
    mockFlipToReady.mockRejectedValue(
      new ReadinessGateError(
        violations as ConstructorParameters<typeof ReadinessGateError>[0],
      ),
    );

    const res = await request(makeApp())
      .post('/api/groom/flip')
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.violations).toEqual(violations);
  });

  it('400s on any other flipToReady failure', async () => {
    mockFlipToReady.mockRejectedValue(new Error('boom'));

    const res = await request(makeApp())
      .post('/api/groom/flip')
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('boom');
  });
});

describe('POST /api/groom/flip — split_now routing', () => {
  const splitBody = {
    ...validBody,
    groomingGate: {
      ...validBody.groomingGate,
      size_check: { decision: 'split_now' },
    },
  };

  it('routes a confirmed split_now nomination (well past the size floor) to a split session instead of promoting', async () => {
    const res = await request(makeApp())
      .post('/api/groom/flip')
      .send({ ...splitBody, sizeCheckSeed: { files: 20 } }); // 20*75=1500 LoC, > 2x the 500 floor

    expect(res.status).toBe(202);
    expect(res.body.routed).toBe('split');
    expect(res.body.confirm.confirmed).toBe(true);
    expect(mockFlipToReady).not.toHaveBeenCalled();
    expect(mockLaunchSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'polimarket-analyser',
        milestoneId: 'M12',
        sessionType: 'split',
        tasks: [
          expect.objectContaining({ id: 'notion:abc', title: 'Add the webhook' }),
        ],
      }),
    );
  });

  it('does not auto-route an unconfirmed near-floor split_now candidate — needs operator approval', async () => {
    const res = await request(makeApp())
      .post('/api/groom/flip')
      .send({ ...splitBody, sizeCheckSeed: { files: 8 } }); // 8*75=600 LoC, just over the floor

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not confirmed/);
    expect(mockLaunchSelected).not.toHaveBeenCalled();
    expect(mockFlipToReady).not.toHaveBeenCalled();
  });

  it('routes a near-floor split_now candidate once operatorApproved is set', async () => {
    const res = await request(makeApp())
      .post('/api/groom/flip')
      .send({
        ...splitBody,
        sizeCheckSeed: { files: 8 },
        operatorApproved: true,
      });

    expect(res.status).toBe(202);
    expect(mockLaunchSelected).toHaveBeenCalled();
    expect(mockFlipToReady).not.toHaveBeenCalled();
  });

  it('400s when sizeCheckSeed is missing for a split_now nomination', async () => {
    const res = await request(makeApp()).post('/api/groom/flip').send(splitBody);

    expect(res.status).toBe(400);
    expect(mockLaunchSelected).not.toHaveBeenCalled();
  });
});
