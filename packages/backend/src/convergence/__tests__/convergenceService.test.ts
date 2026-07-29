/**
 * Tests for the milestone convergence read-surface
 * (packages/backend/src/convergence/convergenceService.ts).
 *
 * AC: green iff every one of the four axes (tasks/gate/seed/ops) is green;
 * distanceToGreen excludes the ops axis; a source_id-null milestone degrades
 * to gate/seed/ops with the task axis reported unavailable; an absent or
 * stale task_cache board row also reports the task axis unavailable, never
 * green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const projectServiceMock = vi.hoisted(() => ({ getById: vi.fn() }));
const gateServiceMock = vi.hoisted(() => ({ getGateReadiness: vi.fn() }));
const seedServiceMock = vi.hoisted(() => ({ getSeedReadiness: vi.fn() }));
const opsReadinessMock = vi.hoisted(() => ({ getOpsReadiness: vi.fn() }));
const queriesMock = vi.hoisted(() => ({ getTaskCache: vi.fn() }));

vi.mock('../../projects/ProjectService.js', () => ({
  ProjectService: projectServiceMock,
}));
vi.mock('../../gate/gateService.js', () => gateServiceMock);
vi.mock('../../seed/seedService.js', () => seedServiceMock);
vi.mock('../opsReadiness.js', () => opsReadinessMock);
vi.mock('../../db/queries.js', () => queriesMock);

import { runtimeSettings } from '../../config.js';
import {
  getMilestoneConvergence,
  listProjectConvergence,
} from '../convergenceService.js';

const MILESTONE = {
  id: 'ms-uuid-12',
  projectId: 'p1',
  name: 'M12',
  sourceId: 'notion-db-12',
  canonicalShortId: 'M12',
  displayOrder: 0,
  wrappedAt: null,
  createdAt: 0,
  updatedAt: 0,
};

function project(milestones = [MILESTONE]) {
  return { id: 'p1', autoLaunchMilestoneId: null, milestones };
}

function boardRow(tasks: { id: string; title: string; status: string }[]) {
  return { task_id: 'board:ms-uuid-12', fetched_at: Date.now(), raw_json: JSON.stringify(tasks) };
}

const GREEN_GATE = { status: 'green' as const, blocking: [], bespokeStates: [], counts: {} };
const GREEN_SEED = { status: 'green' as const, blocking: [], counts: {} };
const GREEN_OPS = { status: 'green' as const, blocking: [], blockingCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSettings.task_cache_refresh_interval_ms = 60_000;
  projectServiceMock.getById.mockReturnValue(project());
  gateServiceMock.getGateReadiness.mockReturnValue(GREEN_GATE);
  seedServiceMock.getSeedReadiness.mockReturnValue(GREEN_SEED);
  opsReadinessMock.getOpsReadiness.mockReturnValue(GREEN_OPS);
  queriesMock.getTaskCache.mockReturnValue(boardRow([]));
});

describe('getMilestoneConvergence', () => {
  it('is green when all four axes are green', () => {
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.status).toBe('green');
    expect(result.axes.tasks.status).toBe('green');
    expect(result.axes.gate.status).toBe('green');
    expect(result.axes.seed.status).toBe('green');
    expect(result.axes.ops.status).toBe('green');
  });

  it('is blocked when the task axis has open tasks', () => {
    queriesMock.getTaskCache.mockReturnValue(
      boardRow([{ id: 'notion:1', title: 'A task', status: '🔲 Backlog' }]),
    );
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.status).toBe('blocked');
    expect(result.axes.tasks.status).toBe('blocked');
    expect(result.axes.tasks.open).toBe(1);
    expect(result.axes.tasks.blocking).toEqual([
      { id: 'notion:1', title: 'A task', status: '🔲 Backlog' },
    ]);
  });

  it('is blocked when the gate axis is blocked', () => {
    gateServiceMock.getGateReadiness.mockReturnValue({
      status: 'blocked',
      blocking: [
        { id: 'g1', project: 'p1', milestone: 'M12', text: 'gate item', classification: 'Read-Only', state: 'open' },
      ],
      bespokeStates: [],
      counts: {},
    });
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.status).toBe('blocked');
    expect(result.axes.gate.status).toBe('blocked');
    expect(result.axes.gate.blockingCount).toBe(1);
    expect(result.axes.gate.blocking).toEqual([
      { id: 'g1', text: 'gate item', state: 'open' },
    ]);
  });

  it('is blocked when the seed axis is blocked', () => {
    seedServiceMock.getSeedReadiness.mockReturnValue({
      status: 'blocked',
      blocking: [{ id: 's1', project: 'p1', milestone: 'M12', spec: 'seed spec', state: 'pending' }],
      counts: {},
    });
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.status).toBe('blocked');
    expect(result.axes.seed.status).toBe('blocked');
    expect(result.axes.seed.blocking).toEqual([
      { id: 's1', text: 'seed spec', state: 'pending' },
    ]);
  });

  it('is blocked when the ops axis is blocked, but ops does not count toward distanceToGreen', () => {
    opsReadinessMock.getOpsReadiness.mockReturnValue({
      status: 'blocked',
      blocking: [{ task_id: 'notion:1', state: 'candidate' }],
      blockingCount: 1,
    });
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.status).toBe('blocked');
    expect(result.axes.ops.status).toBe('blocked');
    expect(result.distanceToGreen).toBe(0);
  });

  it('distanceToGreen sums open tasks + gate blocking + seed blocking, excluding ops', () => {
    queriesMock.getTaskCache.mockReturnValue(
      boardRow([{ id: 'notion:1', title: 'A task', status: '🔲 Backlog' }]),
    );
    gateServiceMock.getGateReadiness.mockReturnValue({
      status: 'blocked',
      blocking: [
        { id: 'g1', project: 'p1', milestone: 'M12', text: 'gate item', classification: 'Read-Only', state: 'open' },
        { id: 'g2', project: 'p1', milestone: 'M12', text: 'gate item 2', classification: 'Read-Only', state: 'open' },
      ],
      bespokeStates: [],
      counts: {},
    });
    seedServiceMock.getSeedReadiness.mockReturnValue({
      status: 'blocked',
      blocking: [{ id: 's1', project: 'p1', milestone: 'M12', spec: 'seed spec', state: 'pending' }],
      counts: {},
    });
    opsReadinessMock.getOpsReadiness.mockReturnValue({
      status: 'blocked',
      blocking: [
        { task_id: 'notion:1', state: 'candidate' },
        { task_id: 'notion:2', state: 'candidate' },
        { task_id: 'notion:3', state: 'candidate' },
      ],
      blockingCount: 3,
    });
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.distanceToGreen).toBe(1 + 2 + 1);
  });

  it('reports the task axis unavailable (not green) for a source_id-null milestone, converging over gate/seed/ops only', () => {
    projectServiceMock.getById.mockReturnValue(
      project([{ ...MILESTONE, sourceId: null }]),
    );
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.axes.tasks.status).toBe('unavailable');
    expect(result.axes.tasks.open).toBe(0);
    expect(result.axes.tasks.blocking).toEqual([]);
    expect(result.status).toBe('blocked');
    expect(queriesMock.getTaskCache).not.toHaveBeenCalled();
  });

  it('reports the task axis unavailable when the board cache row is absent', () => {
    queriesMock.getTaskCache.mockReturnValue(undefined);
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.axes.tasks.status).toBe('unavailable');
    expect(result.status).toBe('blocked');
  });

  it('reports the task axis unavailable when the board cache row is stale past the freshness threshold', () => {
    runtimeSettings.task_cache_refresh_interval_ms = 1_000;
    queriesMock.getTaskCache.mockReturnValue({
      task_id: 'board:ms-uuid-12',
      fetched_at: Date.now() - 10_000,
      raw_json: JSON.stringify([]),
    });
    const result = getMilestoneConvergence('p1', 'M12');
    expect(result.axes.tasks.status).toBe('unavailable');
    expect(result.status).toBe('blocked');
  });
});

describe('listProjectConvergence', () => {
  it('scopes to non-wrapped milestones only', () => {
    projectServiceMock.getById.mockReturnValue(
      project([MILESTONE, { ...MILESTONE, id: 'ms-uuid-13', name: 'M13', canonicalShortId: 'M13', wrappedAt: Date.now() }]),
    );
    const result = listProjectConvergence('p1');
    expect(result).toHaveLength(1);
    expect(result[0].milestone).toBe('M12');
  });
});
