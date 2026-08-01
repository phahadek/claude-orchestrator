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
  recordEvent: vi.fn(),
  reopenItem: vi.fn(),
  approveItem: vi.fn(),
  reclassifyItem: vi.fn(),
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
    classification: 'Human-Observation',
    state: 'open',
    latestDisposition: undefined,
    updatedAt: '2026-01-01T00:00:00Z',
    sources: [],
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  gateApiMock.getGateReadiness.mockResolvedValue({
    status: 'blocked',
    blocking: [],
    counts: {},
  });
  gateApiMock.getVerifySessions.mockResolvedValue([]);
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel — operator reclassify control', () => {
  it('offers only the valid classification vocabulary as options', async () => {
    const item = makeItem('a');
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    const select = screen.getByTestId(
      'gate-item-reclassify-a',
    ) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual([
      'needs-triage',
      'Read-Only',
      'Opportunistic',
      'Prod-Mutating',
      'Human-Observation',
    ]);
  });

  it('posts a reclassification with the entered operator, updates the row, and refreshes readiness', async () => {
    const item = makeItem('a');
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    gateApiMock.reclassifyItem.mockResolvedValue({
      ...item,
      classification: 'Prod-Mutating',
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.change(screen.getByTestId('gate-operator-input'), {
      target: { value: 'pedro@example.com' },
    });
    fireEvent.change(screen.getByTestId('gate-item-reclassify-a'), {
      target: { value: 'Prod-Mutating' },
    });

    await waitFor(() => {
      expect(gateApiMock.reclassifyItem).toHaveBeenCalledWith('a', {
        classification: 'Prod-Mutating',
        operator: 'pedro@example.com',
      });
    });

    await waitFor(() => {
      expect(
        (screen.getByTestId('gate-item-reclassify-a') as HTMLSelectElement)
          .value,
      ).toBe('Prod-Mutating');
    });

    await waitFor(() => {
      expect(gateApiMock.getGateReadiness).toHaveBeenCalledWith(
        'proj-1',
        'M12',
      );
    });
  });

  it('surfaces the server error message when a reclassify is rejected', async () => {
    const item = makeItem('a');
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    gateApiMock.reclassifyItem.mockRejectedValue(
      new Error('invalid classification'),
    );

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.change(screen.getByTestId('gate-item-reclassify-a'), {
      target: { value: 'Prod-Mutating' },
    });

    await waitFor(() => {
      expect(screen.getByText('invalid classification')).toBeTruthy();
    });
  });

  it('reclassifying an item mid-verification does not error, and verify-polling still settles it afterward', async () => {
    const item = makeItem('a', { state: 'runnable' });
    gateApiMock.listGateItems.mockResolvedValue({
      items: [item],
      total: 1,
      page: 1,
    });
    gateApiMock.dispatchVerification.mockResolvedValue({
      dispatched: ['a'],
      skipped: [],
    });
    gateApiMock.reclassifyItem.mockResolvedValue({
      ...item,
      classification: 'Prod-Mutating',
    });

    render(<GateReadinessPanel activeProjectId="proj-1" />);
    await screen.findByText('item a');

    fireEvent.click(screen.getByTestId('gate-verify-item-a'));
    await waitFor(() => {
      expect(gateApiMock.dispatchVerification).toHaveBeenCalledWith(['a']);
    });

    fireEvent.change(screen.getByTestId('gate-item-reclassify-a'), {
      target: { value: 'Prod-Mutating' },
    });

    await waitFor(() => {
      expect(gateApiMock.reclassifyItem).toHaveBeenCalledWith('a', {
        classification: 'Prod-Mutating',
        operator: undefined,
      });
    });

    gateApiMock.getGateItemDetail.mockResolvedValue({
      item: {
        ...item,
        classification: 'Prod-Mutating',
        currentDisposition: 'pass',
        latestDisposition: 'pass',
        state: 'pass',
      },
      sources: [],
      events: [],
    });

    await waitFor(
      () => {
        expect(gateApiMock.getGateItemDetail).toHaveBeenCalledWith('a');
      },
      { timeout: 6000, interval: 200 },
    );
    await waitFor(() => {
      expect(screen.getByTestId('gate-items-table').textContent).toContain(
        'pass',
      );
    });
  }, 10000);
});
