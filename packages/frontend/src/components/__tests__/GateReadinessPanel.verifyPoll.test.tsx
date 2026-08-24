import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
  getVerifySessions: vi.fn().mockResolvedValue([]),
  dispatchVerification: vi.fn(),
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

const deployApiMock = vi.hoisted(() => ({
  launch: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ run: null, events: [] }),
}));
vi.mock('../../api/deploy', () => ({ deployApi: deployApiMock }));

import { GateReadinessPanel } from '../GateReadinessPanel';

const MILESTONES = [
  { project: 'proj-1', milestone: 'M12', status: 'green', blockingCount: 0 },
];

const ITEM = {
  id: 'item-1',
  project: 'proj-1',
  milestone: 'M12',
  text: 'needs a verify pass',
  classification: 'Read-Only',
  state: 'open',
  currentDisposition: undefined,
  latestDisposition: undefined,
  updatedAt: '2026-01-01T00:00:00Z',
  sources: [],
  events: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  gateApiMock.listGateItems.mockResolvedValue({
    items: [ITEM],
    total: 1,
    page: 1,
  });
  gateApiMock.getGateReadiness.mockResolvedValue({
    status: 'blocked',
    blocking: [],
    bespokeStates: [],
    nonResolvingItems: [],
    counts: {},
    awaitingSetupCount: 0,
  });
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GateReadinessPanel — verify polling settles on a non-resolving verdict', () => {
  it('settles the poll and reflects needs-setup in the table when currentDisposition never moves', async () => {
    gateApiMock.dispatchVerification.mockResolvedValue({
      dispatched: ['item-1'],
      skipped: [],
    });
    // The verifier abstains: currentDisposition stays undefined (state
    // untouched) but latestDisposition moves to needs-setup.
    gateApiMock.getGateItemDetail.mockResolvedValue({
      item: {
        ...ITEM,
        currentDisposition: undefined,
        latestDisposition: 'needs-setup',
      },
      sources: [],
      events: [],
    });

    render(
      <GateReadinessPanel
        activeProjectId="proj-1"
        activeBoardMilestone="M12"
      />,
    );
    await screen.findByText('needs a verify pass');

    vi.useFakeTimers();

    await act(async () => {
      screen.getByTestId('gate-verify-item-item-1').click();
      await Promise.resolve();
    });

    expect(screen.getByTestId('gate-verify-item-item-1').textContent).toBe(
      'Verifying…',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    vi.useRealTimers();

    // Polling settled: the button is no longer disabled/"Verifying…", and
    // the table cell reflects the needs-setup verdict rather than looping
    // forever because currentDisposition never changed.
    await waitFor(() => {
      expect(screen.getByTestId('gate-verify-item-item-1').textContent).toBe(
        'Verify',
      );
    });
    const row = screen.getByText('needs a verify pass').closest('tr');
    expect(row?.textContent).toContain('needs-setup');
  });
});
