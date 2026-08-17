import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
  getVerifySessions: vi.fn().mockResolvedValue([]),
  dispatchVerification: vi
    .fn()
    .mockResolvedValue({ dispatched: [], skipped: [] }),
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
  { project: 'proj-1', milestone: 'M12', status: 'green', blockingCount: 0 },
];

function makeSeedItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project: 'proj-1',
    milestone: 'M12',
    spec: `seed ${id}`,
    classification: 'operational-seed',
    state: 'pending',
    updatedAt: '2026-01-01T00:00:00Z',
    sources: [],
    events: [],
    ...overrides,
  };
}

const ITEMS = [
  makeSeedItem('a'),
  makeSeedItem('b', { classification: 'in-pr' }),
  makeSeedItem('c', { classification: 'needs-triage' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  gateApiMock.listGateItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  gateApiMock.getVerifySessions.mockResolvedValue([]);
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({
    items: ITEMS,
    total: ITEMS.length,
    page: 1,
  });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel — seed items classification filter', () => {
  it('renders each seed item classification in the table', async () => {
    render(<GateReadinessPanel activeProjectId="proj-1" activeBoardMilestone="M12" />);

    await screen.findByText('seed a');

    const table = screen.getByTestId('seed-items-table');
    expect(table.textContent).toContain('operational-seed');
    expect(table.textContent).toContain('in-pr');
    expect(table.textContent).toContain('needs-triage');
  });

  it('re-fetches seed items scoped to the selected classification', async () => {
    render(<GateReadinessPanel activeProjectId="proj-1" activeBoardMilestone="M12" />);

    await screen.findByText('seed a');

    seedApiMock.listSeedItems.mockResolvedValue({
      items: [ITEMS[1]],
      total: 1,
      page: 1,
    });

    const classificationSelect = screen.getByTestId(
      'seed-classification-filter',
    );
    fireEvent.change(classificationSelect, { target: { value: 'in-pr' } });

    await waitFor(() => {
      expect(seedApiMock.listSeedItems).toHaveBeenLastCalledWith(
        expect.objectContaining({ classification: 'in-pr' }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('seed a')).toBeNull();
    });
    expect(screen.getByText('seed b')).toBeTruthy();
  });
});
