/**
 * Tests for the bounded window on GET .../convergence/history
 * (packages/backend/src/routes/convergence.ts + db/queries.ts).
 *
 * AC: the query supports an explicit row-limit / since-timestamp window; a
 * caller that passes no window still gets the full, unbounded history back.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertConvergenceSnapshot,
  listConvergenceSnapshotHistory,
} from '../../db/queries.js';
import { createConvergenceRouter } from '../convergence.js';

const milestoneResolverMock = vi.hoisted(() => ({
  resolveMilestoneRowForProject: vi.fn(),
  canonicalMilestoneKey: vi.fn(),
  UnknownMilestoneError: class UnknownMilestoneError extends Error {},
}));
vi.mock('../../projects/milestoneResolver.js', () => milestoneResolverMock);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createConvergenceRouter());
  return app;
}

function snapshot(
  ts: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    project: 'proj-1',
    milestone: 'M1',
    ts,
    tasks_open: 1,
    tasks_closed: 0,
    gate_open: 1,
    gate_closed: 0,
    seed_open: 0,
    seed_closed: 0,
    ops_open: 0,
    ops_closed: 0,
    total_scope: 2,
    distance_to_green: 2,
    status: 'blocked',
    ...overrides,
  };
}

beforeEach(() => {
  db.prepare('DELETE FROM convergence_snapshot').run();
  vi.clearAllMocks();
  milestoneResolverMock.resolveMilestoneRowForProject.mockReturnValue({
    id: 'ms-1',
    name: 'M1',
    canonicalShortId: 'M1',
  });
  milestoneResolverMock.canonicalMilestoneKey.mockReturnValue('M1');
});

const TS = [
  '2026-07-01T00:00:00.000Z',
  '2026-07-02T00:00:00.000Z',
  '2026-07-03T00:00:00.000Z',
  '2026-07-04T00:00:00.000Z',
  '2026-07-05T00:00:00.000Z',
];

describe('listConvergenceSnapshotHistory windowing', () => {
  it('with no window, returns the full unbounded history, oldest first', () => {
    for (const ts of TS) {
      insertConvergenceSnapshot(snapshot(ts) as any);
    }

    const rows = listConvergenceSnapshotHistory('proj-1', 'M1');
    expect(rows).toHaveLength(5);
    expect(rows[0].ts).toBe(TS[0]);
    expect(rows[4].ts).toBe(TS[4]);
  });

  it('with a limit, returns only the most recent N rows, still ordered oldest first', () => {
    for (const ts of TS) {
      insertConvergenceSnapshot(snapshot(ts) as any);
    }

    const rows = listConvergenceSnapshotHistory('proj-1', 'M1', { limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].ts).toBe(TS[3]);
    expect(rows[1].ts).toBe(TS[4]);
  });

  it('with a sinceTs, returns only rows at or after that timestamp', () => {
    for (const ts of TS) {
      insertConvergenceSnapshot(snapshot(ts) as any);
    }

    const rows = listConvergenceSnapshotHistory('proj-1', 'M1', {
      sinceTs: TS[2],
    });
    expect(rows.map((r) => r.ts)).toEqual([TS[2], TS[3], TS[4]]);
  });
});

describe('GET /api/milestones/:project/:milestone/convergence/history', () => {
  it('forwards a limit query param as a bounded window', async () => {
    for (const ts of TS) {
      insertConvergenceSnapshot(snapshot(ts) as any);
    }

    const res = await request(makeApp()).get(
      '/api/milestones/proj-1/M1/convergence/history?limit=2',
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[1].ts).toBe(TS[4]);
  });

  it('with no query params, returns the full unbounded history unchanged', async () => {
    for (const ts of TS) {
      insertConvergenceSnapshot(snapshot(ts) as any);
    }

    const res = await request(makeApp()).get(
      '/api/milestones/proj-1/M1/convergence/history',
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });
});
