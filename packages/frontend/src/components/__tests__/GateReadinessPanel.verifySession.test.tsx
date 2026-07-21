import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateApiMock = vi.hoisted(() => ({
  listMilestoneReadiness: vi.fn().mockResolvedValue([]),
  getGateReadiness: vi.fn().mockResolvedValue(null),
  listGateItems: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1 }),
  getGateItemDetail: vi.fn(),
  getVerifySessions: vi.fn(),
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

const ITEM_WITH_SESSION = {
  id: 'item-with-session',
  project: 'proj-1',
  milestone: 'M12',
  text: 'has a verify session',
  classification: 'Read-Only',
  state: 'open',
  currentDisposition: undefined,
  updatedAt: '2026-01-01T00:00:00Z',
  sources: [],
  events: [],
};

const ITEM_WITHOUT_SESSION = {
  ...ITEM_WITH_SESSION,
  id: 'item-without-session',
  text: 'has no verify session',
};

const DETAIL_FOR = (item: typeof ITEM_WITH_SESSION) => ({
  item,
  sources: [],
  events: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  gateApiMock.listMilestoneReadiness.mockResolvedValue(MILESTONES);
  seedApiMock.listSeedMilestoneReadiness.mockResolvedValue([]);
  seedApiMock.listSeedItems.mockResolvedValue({ items: [], total: 0, page: 1 });
  deployApiMock.getStatus.mockResolvedValue({ run: null, events: [] });
});

describe('GateReadinessPanel — gate item verify session', () => {
  it('renders the verify session status and a jump affordance for an item that has one', async () => {
    gateApiMock.listGateItems.mockResolvedValue({
      items: [ITEM_WITH_SESSION],
      total: 1,
      page: 1,
    });
    gateApiMock.getGateItemDetail.mockResolvedValue(
      DETAIL_FOR(ITEM_WITH_SESSION),
    );
    gateApiMock.getVerifySessions.mockResolvedValue([
      {
        itemId: 'item-with-session',
        sessionId: 'sess-123',
        sessionStatus: 'running',
        startedAt: 100,
        endedAt: null,
      },
    ]);

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const row = await screen.findByText('has a verify session');
    fireEvent.click(row);

    await waitFor(() => {
      expect(gateApiMock.getVerifySessions).toHaveBeenCalledWith(
        'item-with-session',
      );
    });

    const sessionBlock = await screen.findByTestId('gate-item-verify-session');
    expect(sessionBlock.textContent).toContain('running');

    const jumpButton = screen.getByTestId(
      'gate-item-verify-session-jump-item-with-session',
    );

    const listener = vi.fn();
    window.addEventListener('selectSession', listener);
    fireEvent.click(jumpButton);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail).toEqual({
      sessionId: 'sess-123',
    });
    window.removeEventListener('selectSession', listener);
  });

  it('renders nothing for an item that has no verify session', async () => {
    gateApiMock.listGateItems.mockResolvedValue({
      items: [ITEM_WITHOUT_SESSION],
      total: 1,
      page: 1,
    });
    gateApiMock.getGateItemDetail.mockResolvedValue(
      DETAIL_FOR(ITEM_WITHOUT_SESSION),
    );
    gateApiMock.getVerifySessions.mockResolvedValue([]);

    render(<GateReadinessPanel activeProjectId="proj-1" />);

    const row = await screen.findByText('has no verify session');
    fireEvent.click(row);

    await waitFor(() => {
      expect(gateApiMock.getVerifySessions).toHaveBeenCalledWith(
        'item-without-session',
      );
    });

    await screen.findByText(/Sources/);
    expect(screen.queryByTestId('gate-item-verify-session')).toBeNull();
  });
});
