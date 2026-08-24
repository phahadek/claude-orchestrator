import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
}));
vi.mock('../../api/gate', () => ({ gateApi: gateApiMock }));

const seedApiMock = vi.hoisted(() => ({
  listSeedMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getSeedReadiness: vi.fn().mockResolvedValue(null),
  listSeedItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
}));
vi.mock('../../api/seed', () => ({
  seedApi: seedApiMock,
  SEED_EVENT_OUTCOMES: ['applied', 'confirmed', 'blocked', 'discarded'],
}));

const convergenceMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useMilestoneConvergence', () => ({
  useMilestoneConvergence: (...args: unknown[]) => convergenceMock(...args),
}));

import { GateReadinessPanel } from '../GateReadinessPanel';

// gate.status/seed.status both green, but the 5-axis convergence (tasks/ops/
// investigationReport also considered) says blocked — the exact staleness
// this badge used to hide.
const GATE_GREEN_MILESTONES = [
  { project: 'proj-1', milestone: 'M12', status: 'green', blockingCount: 0 },
];
const SEED_GREEN_MILESTONES = [
  { project: 'proj-1', milestone: 'M12', status: 'green', blockingCount: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(GATE_GREEN_MILESTONES);
  gateApiMock.listGateItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue(
    SEED_GREEN_MILESTONES,
  );
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
});

describe('GateReadinessPanel composite badge driven by convergence', () => {
  it('reads the convergence hook with the active project and milestone', async () => {
    convergenceMock.mockReturnValue({
      convergence: { status: 'green', axes: {} },
      loading: false,
      error: null,
      refetch: () => {},
    });

    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );

    await screen.findByTestId('gate-readiness-panel');
    expect(convergenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', milestoneId: 'M12' }),
    );
  });

  it('renders "Milestone complete" when convergence.status is green, even if gate/seed rollups alone were green', async () => {
    convergenceMock.mockReturnValue({
      convergence: { status: 'green', axes: {} },
      loading: false,
      error: null,
      refetch: () => {},
    });

    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );

    const badge = await screen.findByTestId('composite-readiness-status');
    expect(badge.textContent).toContain('Milestone complete');
  });

  it('renders "Milestone incomplete" when convergence.status is blocked, even though gate.status and seed.status are both green', async () => {
    convergenceMock.mockReturnValue({
      convergence: { status: 'blocked', axes: {} },
      loading: false,
      error: null,
      refetch: () => {},
    });

    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );

    const badge = await screen.findByTestId('composite-readiness-status');
    expect(badge.textContent).toContain('Milestone incomplete');
    expect(badge.textContent).not.toContain('Milestone complete');
  });

  it('renders no composite badge when convergence has not resolved yet', async () => {
    convergenceMock.mockReturnValue({
      convergence: null,
      loading: true,
      error: null,
      refetch: () => {},
    });

    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );

    await screen.findByTestId('gate-readiness-panel');
    expect(screen.queryByTestId('composite-readiness-status')).toBeNull();
  });
});
