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
  getTaskTitleFromCache: vi.fn(),
}));

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  getMilestoneById,
  getProjectRowById,
  getTaskTitleFromCache,
} from '../../db/queries';
import { createPlanningLaunchRouter } from '../planningLaunch';
import type { OpsSessionLauncher } from '../../orchestration/OpsSessionLauncher';
import { queryAuditLogByProject } from '../../audit/AuditLog';

describe('POST /api/planning/launch', () => {
  let launchSelected: ReturnType<typeof vi.fn>;
  let launcher: OpsSessionLauncher;
  let app: express.Express;

  beforeEach(async () => {
    const { db } = await import('../../db/db.js');
    db.prepare(
      "DELETE FROM audit_log WHERE event_type = 'planning_dispatch_launched'",
    ).run();

    vi.mocked(getMilestoneById).mockReturnValue({
      id: 'm1',
      project_id: 'proj-1',
    } as ReturnType<typeof getMilestoneById>);
    vi.mocked(getProjectRowById).mockReturnValue({
      id: 'proj-1',
      context_url: 'https://example.com/proj-1',
    } as ReturnType<typeof getProjectRowById>);
    vi.mocked(getTaskTitleFromCache).mockReturnValue(null);

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

  it('resolves the task title from the task cache instead of using the bare id', async () => {
    vi.mocked(getTaskTitleFromCache).mockReturnValue(
      'Fix the flaky retry logic',
    );

    const res = await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        milestone: 'm1',
        taskIds: ['abc-123'],
      });

    expect(res.status).toBe(202);
    expect(getTaskTitleFromCache).toHaveBeenCalledWith('notion:abc-123');
    expect(launchSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            id: 'notion:abc-123',
            title: 'Fix the flaky retry logic',
          }),
        ],
      }),
    );
  });

  it('falls back to the bare id (never a notion.so/notion:<id> url) when the title cannot be resolved from the cache', async () => {
    vi.mocked(getTaskTitleFromCache).mockReturnValue(null);

    const res = await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'design',
        milestone: 'm1',
        taskIds: ['abc-123'],
      });

    expect(res.status).toBe(202);
    expect(launchSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({ id: 'notion:abc-123', title: 'abc-123' }),
        ],
      }),
    );
  });

  it('records a planning_dispatch_launched audit row with trigger_source "operator", the flow, and the milestone.id (the flow_arm UUID key space)', async () => {
    const res = await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        milestone: 'm1',
        taskIds: ['task-1'],
      });

    expect(res.status).toBe(202);

    const { entries } = queryAuditLogByProject('proj-1', {
      eventType: 'planning_dispatch_launched',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toEqual({
      trigger_source: 'operator',
      flow: 'groom',
      milestone_id: 'm1',
    });
  });

  it('the operator path and the evaluator path record different trigger_source values (no silent default that collapses them)', async () => {
    const { recordEvent } = await import('../../audit/AuditLog');

    await request(app)
      .post('/api/planning/launch')
      .send({
        workflow: 'groom',
        milestone: 'm1',
        taskIds: ['task-1'],
      });

    // The evaluator path (DispatchTriggerEvaluator.dispatchPlanningCandidate)
    // writes the same event_type with trigger_source: 'evaluator' — asserted
    // directly there. Here we assert the two values are distinct by
    // recording what the evaluator path writes and comparing.
    recordEvent({
      event_type: 'planning_dispatch_launched',
      actor_type: 'system',
      project_id: 'proj-1',
      payload: {
        trigger_source: 'evaluator',
        flow: 'groom',
        milestone_id: 'm1',
      },
    });

    const { entries } = queryAuditLogByProject('proj-1', {
      eventType: 'planning_dispatch_launched',
    });
    const sources = entries.map(
      (e) => (e.payload as { trigger_source: string }).trigger_source,
    );
    expect(sources).toContain('operator');
    expect(sources).toContain('evaluator');
    expect(new Set(sources).size).toBe(2);
  });
});
