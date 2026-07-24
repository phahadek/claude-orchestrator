import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
  getVerifySessions: vi.fn().mockResolvedValue([]),
  dispatchVerification: vi.fn().mockResolvedValue({ dispatched: [], skipped: [] }),
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

function makeItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project: 'proj-1',
    milestone: 'M12',
    text: `item ${id}`,
    classification: 'Read-Only',
    state: 'open',
    currentDisposition: undefined,
    updatedAt: '2026-01-01T00:00:00Z',
    sources: [],
    events: [],
    ...overrides,
  };
}

const ITEMS = [makeItem('a'), makeItem('b'), makeItem('c')];

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  gateApiMock.listGateItems.mockResolvedValue({
    items: ITEMS,
    total: ITEMS.length,
    page: 1,
  });
  gateApiMock.getVerifySessions.mockResolvedValue([]);
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel — Select All / Clear', () => {
  it('Select All adds every filtered item to the selection and Verify(N) reflects the count', async () => {
    render(<GateReadinessPanel activeProjectId="proj-1" />);

    await screen.findByText('item a');

    const selectAllBtn = screen.getByTestId('gate-select-all-button');
    fireEvent.click(selectAllBtn);

    const verifyBtn = screen.getByTestId('gate-verify-selected-button');
    expect(verifyBtn.textContent).toBe('Verify (3)');
    expect(
      (screen.getByTestId('gate-item-select-a') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('gate-item-select-b') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId('gate-item-select-c') as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('Select All only selects the items shown under the active filters', async () => {
    render(<GateReadinessPanel activeProjectId="proj-1" />);

    await screen.findByText('item a');

    // Simulate a narrower filter: only 'a' comes back from the API for the
    // active state/classification/runnable filters.
    gateApiMock.listGateItems.mockResolvedValue({
      items: [ITEMS[0]],
      total: 1,
      page: 1,
    });

    const stateSelect = screen.getAllByLabelText('State')[0];
    fireEvent.change(stateSelect, { target: { value: 'open' } });

    await waitFor(() => {
      expect(screen.queryByText('item b')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('gate-select-all-button'));

    const verifyBtn = screen.getByTestId('gate-verify-selected-button');
    expect(verifyBtn.textContent).toBe('Verify (1)');
  });

  it('Clear resets the selection to zero', async () => {
    render(<GateReadinessPanel activeProjectId="proj-1" />);

    await screen.findByText('item a');

    fireEvent.click(screen.getByTestId('gate-select-all-button'));
    expect(screen.getByTestId('gate-verify-selected-button').textContent).toBe(
      'Verify (3)',
    );

    fireEvent.click(screen.getByTestId('gate-clear-selection-button'));

    expect(screen.getByTestId('gate-verify-selected-button').textContent).toBe(
      'Verify (0)',
    );
    expect(
      (screen.getByTestId('gate-item-select-a') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('disables Select All when the filtered list is empty and Clear when nothing is selected', async () => {
    gateApiMock.listGateItems.mockResolvedValue({ items: [], total: 0, page: 1 });
    render(<GateReadinessPanel activeProjectId="proj-1" />);

    await waitFor(() => {
      expect(
        (screen.getByTestId('gate-select-all-button') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
    expect(
      (screen.getByTestId('gate-clear-selection-button') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
