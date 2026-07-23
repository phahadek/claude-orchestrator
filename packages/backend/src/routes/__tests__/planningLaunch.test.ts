/**
 * Tests for POST /api/planning/launch (packages/backend/src/routes/planningLaunch.ts).
 * Verifies the per-launch model/effort override (added alongside the
 * Groom(N)/Ops(N)/Design(N) launch picker) is threaded through to
 * OpsSessionLauncher.launchSelected, and that omitting it preserves the
 * existing runtimeSettings-driven fallback behavior.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getMilestoneById: vi.fn(),
  getProjectRowById: vi.fn(),
}));

import { getMilestoneById, getProjectRowById } from '../../db/queries';
import { createPlanningLaunchRouter } from '../planningLaunch';
import type { OpsSessionLauncher } from '../../orchestration/OpsSessionLauncher';

describe('POST /api/planning/launch', () => {
  let launchSelected: ReturnType<typeof vi.fn>;
  let launcher: OpsSessionLauncher;
  let app: express.Express;

  beforeEach(() => {
    vi.mocked(getMilestoneById).mockReturnValue({
      id: 'm1',
      project_id: 'proj-1',
    } as ReturnType<typeof getMilestoneById>);
    vi.mocked(getProjectRowById).mockReturnValue({
      id: 'proj-1',
      context_url: 'https://example.com/proj-1',
    } as ReturnType<typeof getProjectRowById>);

    launchSelected = vi
      .fn()
      .mockResolvedValue({ launched: ['task-1'], deferred: [] });
    launcher = { launchSelected } as unknown as OpsSessionLauncher;

    app = express();
    app.use(express.json());
    app.use('/api', createPlanningLaunchRouter(launcher));
  });

  it('threads a model field from the request to the launched session', async () => {
    const res = await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        milestone: 'm1',
        taskIds: ['task-1'],
        model: 'claude-opus-4-6',
        effort: 'high',
      });

    expect(res.status).toBe(202);
    expect(launchSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-opus-4-6',
        effort: 'high',
      }),
    );
  });

  it('falls back to runtimeSettings model resolution when no model is provided', async () => {
    const res = await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        milestone: 'm1',
        taskIds: ['task-1'],
      });

    expect(res.status).toBe(202);
    expect(launchSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
        effort: undefined,
      }),
    );
  });

  it('records the launched task id in canonical notion:<uuid> form for a bare input id', async () => {
    const res = await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        milestone: 'm1',
        taskIds: ['abc-123'],
      });

    expect(res.status).toBe(202);
    expect(launchSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: 'notion:abc-123' })],
      }),
    );
  });

  it('records the launched task id in canonical notion:<uuid> form for an already-prefixed input id', async () => {
    const res = await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'design',
        milestone: 'm1',
        taskIds: ['notion:abc-123'],
      });

    expect(res.status).toBe(202);
    expect(launchSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: 'notion:abc-123' })],
      }),
    );
  });
});
