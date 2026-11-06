/**
 * Tests for ConvergenceSnapshotJob (packages/backend/src/orchestration/ConvergenceSnapshotJob.ts).
 *
 * AC: dedup — two identical consecutive samples write exactly one row; a
 * changed sample writes a new row. A per-milestone failure is caught and
 * does not abort the remaining milestones in the tick.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queriesMock = vi.hoisted(() => ({
  insertConvergenceSnapshot: vi.fn(),
  getLatestConvergenceSnapshot: vi.fn(),
  listOpsJournalEntries: vi.fn(() => []),
}));
const convergenceServiceMock = vi.hoisted(() => ({
  getMilestoneConvergence: vi.fn(),
}));
const gateServiceMock = vi.hoisted(() => ({ getGateReadiness: vi.fn() }));
const seedServiceMock = vi.hoisted(() => ({ getSeedReadiness: vi.fn() }));
const opsReadinessMock = vi.hoisted(() => ({ getOpsReadiness: vi.fn() }));
const projectServiceMock = vi.hoisted(() => ({
  ProjectService: { listMilestones: vi.fn() },
}));

vi.mock('../../db/queries.js', () => queriesMock);
vi.mock(
  '../../convergence/convergenceService.js',
  () => convergenceServiceMock,
);
vi.mock('../../gate/gateService.js', () => gateServiceMock);
vi.mock('../../seed/seedService.js', () => seedServiceMock);
vi.mock('../../convergence/opsReadiness.js', () => opsReadinessMock);
vi.mock('../../projects/ProjectService.js', () => projectServiceMock);

import { ConvergenceSnapshotJob } from '../ConvergenceSnapshotJob.js';
import {
  insertConvergenceSnapshot,
  getLatestConvergenceSnapshot,
} from '../../db/queries.js';
import { getMilestoneConvergence } from '../../convergence/convergenceService.js';

function milestone(overrides: Partial<any> = {}) {
  return {
    id: 'ms-1',
    projectId: 'proj-1',
    name: 'M12',
    sourceId: 'notion-db-12',
    canonicalShortId: 'M12',
    displayOrder: 0,
    wrappedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function convergence(overrides: Partial<any> = {}) {
  return {
    project: 'proj-1',
    milestone: 'M12',
    status: 'blocked',
    distanceToGreen: 3,
    axes: {
      tasks: { status: 'blocked', open: 2, closed: 1, blocking: [] },
      gate: { status: 'blocked', blockingCount: 1, blocking: [] },
      seed: { status: 'green', blockingCount: 0, blocking: [] },
      ops: { status: 'green', blockingCount: 0, blocking: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queriesMock.listOpsJournalEntries.mockReturnValue([]);
  gateServiceMock.getGateReadiness.mockReturnValue({
    status: 'blocked',
    blocking: [{ id: 'g1' }],
    parked: [],
    bespokeStates: [],
    counts: { open: 1, pass: 0 },
  });
  seedServiceMock.getSeedReadiness.mockReturnValue({
    status: 'green',
    blocking: [],
    counts: { confirmed: 0 },
  });
  opsReadinessMock.getOpsReadiness.mockReturnValue({
    status: 'green',
    blocking: [],
    blockingCount: 0,
  });
  convergenceServiceMock.getMilestoneConvergence.mockReturnValue(convergence());
});

describe('ConvergenceSnapshotJob dedup', () => {
  it('writes exactly one row for two identical consecutive samples', async () => {
    projectServiceMock.ProjectService.listMilestones.mockReturnValue([
      milestone(),
    ]);

    let stored: any = undefined;
    (getLatestConvergenceSnapshot as any).mockImplementation(() => stored);
    (insertConvergenceSnapshot as any).mockImplementation((row: any) => {
      stored = { id: 'snap-1', ...row };
    });

    const job = new ConvergenceSnapshotJob({
      listProjects: () => [{ id: 'proj-1' } as any],
    });

    await job.runOnce();
    await job.runOnce();

    expect(insertConvergenceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('writes a new row when the sample changes', async () => {
    projectServiceMock.ProjectService.listMilestones.mockReturnValue([
      milestone(),
    ]);

    let stored: any = undefined;
    (getLatestConvergenceSnapshot as any).mockImplementation(() => stored);
    (insertConvergenceSnapshot as any).mockImplementation((row: any) => {
      stored = { id: 'snap-1', ...row };
    });

    const job = new ConvergenceSnapshotJob({
      listProjects: () => [{ id: 'proj-1' } as any],
    });

    await job.runOnce();

    convergenceServiceMock.getMilestoneConvergence.mockReturnValue(
      convergence({ distanceToGreen: 5 }),
    );

    await job.runOnce();

    expect(insertConvergenceSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('ConvergenceSnapshotJob per-milestone failure isolation', () => {
  it('catches a failure on one milestone and still processes the rest', async () => {
    projectServiceMock.ProjectService.listMilestones.mockReturnValue([
      milestone({
        id: 'ms-broken',
        name: 'Broken',
        canonicalShortId: 'Broken',
      }),
      milestone({ id: 'ms-ok', name: 'OK', canonicalShortId: 'OK' }),
    ]);

    (getLatestConvergenceSnapshot as any).mockReturnValue(undefined);
    (getMilestoneConvergence as any).mockImplementation(
      (_project: string, key: string) => {
        if (key === 'Broken') {
          throw new Error('boom');
        }
        return convergence({ milestone: key });
      },
    );

    const job = new ConvergenceSnapshotJob({
      listProjects: () => [{ id: 'proj-1' } as any],
    });

    const result = await job.runOnce();

    expect(insertConvergenceSnapshot).toHaveBeenCalledTimes(1);
    expect(result.items_processed).toBe(1);
  });
});

describe('ConvergenceSnapshotJob event-loop yielding', () => {
  it('interleaves with a macrotask scheduled mid-tick instead of running the whole milestone loop as one synchronous burst', async () => {
    const milestones = [
      milestone({ id: 'ms-1', name: 'M1', canonicalShortId: 'M1' }),
      milestone({ id: 'ms-2', name: 'M2', canonicalShortId: 'M2' }),
      milestone({ id: 'ms-3', name: 'M3', canonicalShortId: 'M3' }),
    ];
    projectServiceMock.ProjectService.listMilestones.mockReturnValue(
      milestones,
    );
    (getLatestConvergenceSnapshot as any).mockReturnValue(undefined);

    let sampledCount = 0;
    (getMilestoneConvergence as any).mockImplementation(() => {
      sampledCount++;
      return convergence();
    });

    const job = new ConvergenceSnapshotJob({
      listProjects: () => [{ id: 'proj-1' } as any],
    });

    const runPromise = job.runOnce();

    // Scheduled with setImmediate right after starting the tick (but before
    // awaiting it): if runOnce truly yields to the event loop per milestone,
    // this fires interleaved mid-loop — some but not all milestones sampled.
    // Pre-fix, the loop ran fully synchronously with no await point at all,
    // so this would only ever observe 0 or milestones.length, never a
    // partial count.
    const midTickCount = await new Promise<number>((resolve) => {
      setImmediate(() => resolve(sampledCount));
    });

    await runPromise;

    expect(midTickCount).toBeGreaterThan(0);
    expect(midTickCount).toBeLessThan(milestones.length);
    expect(sampledCount).toBe(milestones.length);
  });
});

describe('ConvergenceSnapshotJob ops axis key space', () => {
  it('queries getOpsReadiness and listOpsJournalEntries by the milestone UUID, not the display name', async () => {
    projectServiceMock.ProjectService.listMilestones.mockReturnValue([
      milestone({ id: 'ms-uuid-77', name: 'M12', canonicalShortId: 'M12' }),
    ]);
    (getLatestConvergenceSnapshot as any).mockReturnValue(undefined);

    const job = new ConvergenceSnapshotJob({
      listProjects: () => [{ id: 'proj-1' } as any],
    });

    await job.runOnce();

    expect(opsReadinessMock.getOpsReadiness).toHaveBeenCalledWith(
      'proj-1',
      'ms-uuid-77',
    );
    const filterCall = queriesMock.listOpsJournalEntries.mock.calls;
    expect(filterCall.length).toBeGreaterThan(0);
  });

  it('produces a non-zero ops_open in the persisted snapshot when open ops_journal rows are keyed by the milestone UUID', async () => {
    projectServiceMock.ProjectService.listMilestones.mockReturnValue([
      milestone({ id: 'ms-uuid-77', name: 'M12', canonicalShortId: 'M12' }),
    ]);
    (getLatestConvergenceSnapshot as any).mockReturnValue(undefined);

    queriesMock.listOpsJournalEntries.mockImplementation(() => [
      { project: 'proj-1', milestone: 'ms-uuid-77', state: 'pending' },
      { project: 'proj-1', milestone: 'ms-uuid-77', state: 'resolved' },
      { project: 'proj-1', milestone: 'M12', state: 'pending' },
    ]);
    opsReadinessMock.getOpsReadiness.mockImplementation(
      (_project: string, key: string) =>
        key === 'ms-uuid-77'
          ? {
              status: 'blocked',
              blocking: [{ task_id: 'notion:1', state: 'pending' }],
              blockingCount: 1,
            }
          : { status: 'green', blocking: [], blockingCount: 0 },
    );

    const job = new ConvergenceSnapshotJob({
      listProjects: () => [{ id: 'proj-1' } as any],
    });

    await job.runOnce();

    expect(insertConvergenceSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = (insertConvergenceSnapshot as any).mock.calls[0][0];
    expect(snapshot.ops_open).toBe(1);
  });
});
