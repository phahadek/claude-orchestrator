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
vi.mock('../../api/seed', () => ({ seedApi: seedApiMock }));

const deployApiMock = vi.hoisted(() => ({
  launch: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ run: null, events: [] }),
}));
vi.mock('../../api/deploy', () => ({ deployApi: deployApiMock }));

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
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel milestone sync with the top bar', () => {
  it('defaults selectedMilestone to the top-bar-resolved milestone, not the first in the list', async () => {
    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );

    const select = (await screen.findByLabelText(
      'Select milestone',
    )) as HTMLSelectElement;
    expect(select.value).toBe('M12');
  });

  it('updates the panel selection when the top-bar selection changes', async () => {
    const { rerender } = render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M10"
      />,
    );

    let select = (await screen.findByLabelText(
      'Select milestone',
    )) as HTMLSelectElement;
    expect(select.value).toBe('M10');

    rerender(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M11"
      />,
    );

    select = (await screen.findByLabelText(
      'Select milestone',
    )) as HTMLSelectElement;
    expect(select.value).toBe('M11');
  });

  it('falls back to the first milestone when the top-bar selection does not resolve', async () => {
    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone={null}
      />,
    );

    const select = (await screen.findByLabelText(
      'Select milestone',
    )) as HTMLSelectElement;
    expect(select.value).toBe('M10');
  });
});
