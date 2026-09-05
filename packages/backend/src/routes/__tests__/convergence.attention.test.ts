/**
 * Route test for GET /api/milestones/:project/:milestone/attention
 * (packages/backend/src/routes/convergence.ts).
 *
 * AC: against a fixture with 17 milestone board caches and 189
 * task_pause_reasons rows, the route completes in under 200ms — the
 * regression this guards is computeMilestoneAttentionSignals re-parsing
 * every board blob per pause row (see attentionSignals.ts).
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { upsertTaskCache, setTaskPauseReason } from '../../db/queries.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { createConvergenceRouter } from '../convergence.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createConvergenceRouter(undefined));
  return app;
}

const PROJECT_ID = 'proj-attention-route-fixture';
const NUM_MILESTONES = 17;
const TOTAL_PAUSE_ROWS = 189;

describe('GET /api/milestones/:project/:milestone/attention', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM task_cache').run();
    db.prepare('DELETE FROM task_pause_reasons').run();
    db.prepare('DELETE FROM projects').run();
    db.prepare('DELETE FROM milestones').run();

    ProjectService.create({
      id: PROJECT_ID,
      name: 'Attention Route Fixture',
      projectDir: '/tmp/attention-route-fixture',
    });

    for (let i = 0; i < NUM_MILESTONES; i++) {
      const milestone = ProjectService.createMilestone({
        id: `ms-route-${i}`,
        projectId: PROJECT_ID,
        name: `M${i}`,
        canonicalShortId: `M${i}`,
        sourceId: `src-route-${i}`,
      });
      upsertTaskCache(
        `board:${milestone.id}`,
        JSON.stringify([{ id: `task-${i}-a` }, { id: `task-${i}-b` }]),
      );
    }

    setTaskPauseReason('task-0-a', 'planning_terminal_no_decision', 'x');
    for (let i = 1; i < NUM_MILESTONES; i++) {
      setTaskPauseReason(`task-${i}-a`, 'planning_terminal_no_decision', 'z');
    }
    let seeded = NUM_MILESTONES;
    for (let i = 0; seeded + i < TOTAL_PAUSE_ROWS; i++) {
      setTaskPauseReason(`orphan-task-${i}`, 'launch_failed', 'w');
    }
  });

  it('completes in under 200ms against the fixture', async () => {
    const start = performance.now();
    const res = await request(makeApp()).get(
      `/api/milestones/${PROJECT_ID}/M0/attention`,
    );
    const elapsedMs = performance.now() - start;

    expect(res.status).toBe(200);
    expect(res.body.tier2.some((s: { key: string }) =>
      s.key.startsWith('blocked:task-0-a'),
    )).toBe(true);
    expect(elapsedMs).toBeLessThan(200);
  });
});
