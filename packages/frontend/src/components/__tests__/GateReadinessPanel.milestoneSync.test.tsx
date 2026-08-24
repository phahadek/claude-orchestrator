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

import { GateReadinessPanel } from '../GateReadinessPanel';

const MILESTONES = [
  { project: 'proj-1', milestone: 'M10', status: 'green', blockingCount: 0 },
  { project: 'proj-1', milestone: 'M11', status: 'green', blockingCount: 0 },
  { project: 'proj-1', milestone: 'M12', status: 'blocked', blockingCount: 2 },
];

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  gateApiMock.listGateItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
});

describe('GateReadinessPanel milestone sync with the top bar', () => {
  it('renders no milestone selector', async () => {
    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );

    await screen.findByTestId('gate-readiness-panel');
    expect(screen.queryByLabelText('Select milestone')).toBeNull();
  });

  it('derives its milestone purely from activeBoardMilestone', async () => {
    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );

    await screen.findByTestId('gate-readiness-status');
    expect(gateApiMock.getGateReadiness).toHaveBeenCalledWith('proj-1', 'M12');
  });

  it('re-renders with the new milestone when the top-bar selection changes', async () => {
    const { rerender } = render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M10"
      />,
    );

    await screen.findByTestId('gate-readiness-status');
    expect(gateApiMock.getGateReadiness).toHaveBeenCalledWith('proj-1', 'M10');

    rerender(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M11"
      />,
    );

    await screen.findByTestId('gate-readiness-status');
    expect(gateApiMock.getGateReadiness).toHaveBeenCalledWith('proj-1', 'M11');
  });

  it('normalizes a full board name to its short-token milestone', async () => {
    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12 — Orchestrator-run Planning"
      />,
    );

    await screen.findByTestId('gate-readiness-status');
    expect(gateApiMock.getGateReadiness).toHaveBeenCalledWith('proj-1', 'M12');
  });

  it('re-syncs via the normalized token when the top-bar board changes', async () => {
    const { rerender } = render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M10 — Discovery"
      />,
    );

    await screen.findByTestId('gate-readiness-status');
    expect(gateApiMock.getGateReadiness).toHaveBeenCalledWith('proj-1', 'M10');

    rerender(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M11 — Build-out"
      />,
    );

    await screen.findByTestId('gate-readiness-status');
    expect(gateApiMock.getGateReadiness).toHaveBeenCalledWith('proj-1', 'M11');
  });

  it('renders no readiness rollup when the top-bar selection does not resolve', async () => {
    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone={null}
      />,
    );

    await screen.findByTestId('gate-readiness-panel');
    expect(screen.queryByTestId('gate-readiness-status')).toBeNull();
    expect(gateApiMock.getGateReadiness).not.toHaveBeenCalled();
  });
});
